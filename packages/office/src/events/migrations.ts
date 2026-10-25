import type { DatabaseSync } from "node:sqlite";

/**
 * Migrationen nach Expand/Contract (plan.md Kap. 4.5 Nr. 7, E24).
 *
 * - `expand` fügt nur hinzu (Tabellen, Spalten mit Standardwert, Indizes). Eine ältere
 *   Office-Version kann einen so migrierten Stand weiter lesen und schreiben.
 * - `contract` entfernt oder ändert Bestehendes. Danach kann keine Version vor dieser Migration
 *   mehr starten. Das ist die Grenze für „Last-known-good“.
 */
export type MigrationPhase = "expand" | "contract";

export interface Migration {
  version: number;
  name: string;
  phase: MigrationPhase;
  up(db: DatabaseSync): void;
}

export interface MigrationStatus {
  /** Höchste angewandte Version in der Datenbank. */
  databaseVersion: number;
  /** Höchste Version, die dieser Code kennt. */
  codeVersion: number;
  /** In diesem Lauf angewandte Migrationen. */
  applied: number[];
  /**
   * Versionen in der Datenbank, die dieser Code nicht kennt. Nur `expand` ist erlaubt;
   * dann läuft eine ältere Version auf einem neueren Stand.
   */
  unknownExpand: number[];
}

export class IncompatibleSchemaError extends Error {
  override name = "IncompatibleSchemaError";
}

interface AppliedRow {
  version: number;
  phase: string;
}

function validate(migrations: readonly Migration[]): void {
  migrations.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new Error(
        `Migrationen müssen lückenlos ab 1 nummeriert sein (Position ${String(index)}: ${String(m.version)})`,
      );
    }
  });
}

export function migrate(db: DatabaseSync, migrations: readonly Migration[]): MigrationStatus {
  validate(migrations);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('expand', 'contract')),
    applied_at TEXT NOT NULL
  ) STRICT`);

  const rows = db
    .prepare("SELECT version, phase FROM schema_migrations ORDER BY version")
    .all() as unknown as AppliedRow[];
  const codeVersion = migrations.length;
  const unknown = rows.filter((row) => row.version > codeVersion);
  const unknownContract = unknown.filter((row) => row.phase === "contract");
  if (unknownContract.length > 0) {
    throw new IncompatibleSchemaError(
      `Datenbank enthält Contract-Migration ${String(unknownContract[0]?.version)}, die diese Version nicht kennt. Rücksicherung oder neuere Version nötig.`,
    );
  }

  const appliedVersions = new Set(rows.map((row) => row.version));
  const applied: number[] = [];
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, phase, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    if (unknown.length > 0) {
      // Eine neuere Version hat schon migriert; Lücken darunter wären ein inkonsistenter Stand.
      throw new IncompatibleSchemaError(
        `Migration ${String(migration.version)} fehlt, obwohl neuere Migrationen angewandt sind.`,
      );
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      insert.run(migration.version, migration.name, migration.phase, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applied.push(migration.version);
  }

  return {
    databaseVersion: Math.max(codeVersion, ...rows.map((row) => row.version), 0),
    codeVersion,
    applied,
    unknownExpand: unknown.map((row) => row.version),
  };
}
