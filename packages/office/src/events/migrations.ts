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

function readApplied(db: DatabaseSync): AppliedRow[] {
  return db
    .prepare("SELECT version, phase FROM schema_migrations ORDER BY version")
    .all() as unknown as AppliedRow[];
}

/** Versionen über dem Stand des Codes; wirft, wenn darunter eine Contract-Migration ist. */
function unknownVersions(rows: readonly AppliedRow[], codeVersion: number): AppliedRow[] {
  const unknown = rows.filter((row) => row.version > codeVersion);
  const unknownContract = unknown.find((row) => row.phase === "contract");
  if (unknownContract !== undefined) {
    throw new IncompatibleSchemaError(
      `Datenbank enthält Contract-Migration ${String(unknownContract.version)}, die diese Version nicht kennt. Rücksicherung oder neuere Version nötig.`,
    );
  }
  return unknown;
}

/**
 * Wendet fehlende Migrationen an, jede in einer eigenen `IMMEDIATE`-Transaktion. Der Stand wird
 * jeweils erst unter der Sperre gelesen: Öffnen zwei Prozesse gleichzeitig eine neue Datei,
 * überspringt der zweite, was der erste inzwischen angewandt hat.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): MigrationStatus {
  validate(migrations);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('expand', 'contract')),
    applied_at TEXT NOT NULL
  ) STRICT`);

  const codeVersion = migrations.length;
  unknownVersions(readApplied(db), codeVersion);

  const applied: number[] = [];
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, phase, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of migrations) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = readApplied(db);
      const unknown = unknownVersions(rows, codeVersion);
      if (rows.some((row) => row.version === migration.version)) {
        db.exec("COMMIT");
        continue;
      }
      if (unknown.length > 0) {
        // Eine neuere Version hat schon migriert; Lücken darunter wären ein inkonsistenter Stand.
        throw new IncompatibleSchemaError(
          `Migration ${String(migration.version)} fehlt, obwohl neuere Migrationen angewandt sind.`,
        );
      }
      migration.up(db);
      insert.run(migration.version, migration.name, migration.phase, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
      throw error;
    }
    applied.push(migration.version);
  }

  const rows = readApplied(db);
  return {
    databaseVersion: Math.max(codeVersion, ...rows.map((row) => row.version), 0),
    codeVersion,
    applied,
    unknownExpand: unknownVersions(rows, codeVersion).map((row) => row.version),
  };
}
