import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, type JsonValue } from "./canonical-json.ts";
import { migrate, type Migration, type MigrationStatus } from "./migrations.ts";

/**
 * Ereignisprotokoll des Office (plan.md Kap. 3.1 Nr. 2, E38).
 *
 * Nur Anhängen. Jedes Ereignis trägt den Hash seines Vorgängers, sodass eine nachträgliche
 * Änderung erkennbar ist, sobald der Supervisor den Kopf der Kette (`head()`) gesichert hat.
 * Verhindern kann das Office eine Manipulation seiner eigenen Datei nicht; maßgeblich ist das
 * Audit-Log des Supervisors.
 */

export const GENESIS_HASH = "0".repeat(64);

export interface NewEvent {
  type: string;
  /** Version des Payload-Schemas dieses Typs. */
  version?: number;
  /** Wer hat gehandelt: Agenten-ID, `ceo`, `system`. */
  actor: string;
  runId?: string;
  payload: JsonValue;
  /** Für idempotente Aufrufe (Lauf-ID + Sequenznummer, Kap. 5.7). */
  idempotencyKey?: string;
  occurredAt?: Date;
}

export interface StoredEvent {
  seq: number;
  id: string;
  type: string;
  version: number;
  actor: string;
  runId: string | null;
  payload: JsonValue;
  idempotencyKey: string | null;
  occurredAt: string;
  prevHash: string;
  hash: string;
}

export interface ChainHead {
  seq: number;
  hash: string;
}

export type ChainCheck =
  { ok: true; head: ChainHead } | { ok: false; brokenAtSeq: number; reason: string };

interface EventRow {
  seq: number;
  id: string;
  type: string;
  version: number;
  actor: string;
  run_id: string | null;
  payload: string;
  idempotency_key: string | null;
  occurred_at: string;
  prev_hash: string;
  hash: string;
}

export const EVENT_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "events",
    phase: "expand",
    up(db) {
      db.exec(`CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        actor TEXT NOT NULL,
        run_id TEXT,
        payload TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        occurred_at TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE
      ) STRICT`);
      db.exec("CREATE INDEX events_type ON events (type, seq)");
      db.exec("CREATE INDEX events_run ON events (run_id, seq)");
    },
  },
];

/** Hash eines Ereignisses über alle Felder außer dem Hash selbst. */
export function eventHash(event: Omit<StoredEvent, "hash">): string {
  const material = canonicalJson({
    seq: event.seq,
    id: event.id,
    type: event.type,
    version: event.version,
    actor: event.actor,
    runId: event.runId,
    payload: event.payload,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
    prevHash: event.prevHash,
  });
  return createHash("sha256").update(material).digest("hex");
}

function fromRow(row: EventRow): StoredEvent {
  return {
    seq: row.seq,
    id: row.id,
    type: row.type,
    version: row.version,
    actor: row.actor,
    runId: row.run_id,
    payload: JSON.parse(row.payload) as JsonValue,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export interface ReadOptions {
  afterSeq?: number;
  limit?: number;
  types?: readonly string[];
}

export class EventStore {
  readonly migration: MigrationStatus;
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync, migrations: readonly Migration[]) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migration = migrate(this.db, migrations);
  }

  /**
   * Öffnet die Datenbank. `migrations` ist nur für Tests austauschbar; der Betrieb nutzt
   * `EVENT_MIGRATIONS` bzw. die Gesamtliste des Office.
   */
  static open(path: string, migrations: readonly Migration[] = EVENT_MIGRATIONS): EventStore {
    return new EventStore(new DatabaseSync(path), migrations);
  }

  close(): void {
    this.db.close();
  }

  append(input: NewEvent): StoredEvent {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey !== undefined) {
        const existing = this.db
          .prepare("SELECT * FROM events WHERE idempotency_key = ?")
          .get(input.idempotencyKey) as EventRow | undefined;
        if (existing !== undefined) {
          this.db.exec("COMMIT");
          const stored = fromRow(existing);
          if (
            stored.type !== input.type ||
            canonicalJson(stored.payload) !== canonicalJson(input.payload)
          ) {
            throw new Error(
              `Idempotenzschlüssel ${input.idempotencyKey} wurde mit anderem Inhalt wiederverwendet`,
            );
          }
          return stored;
        }
      }
      const last = this.db
        .prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; hash: string } | undefined;
      const unhashed: Omit<StoredEvent, "hash"> = {
        seq: (last?.seq ?? 0) + 1,
        id: randomUUID(),
        type: input.type,
        version: input.version ?? 1,
        actor: input.actor,
        runId: input.runId ?? null,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey ?? null,
        occurredAt: (input.occurredAt ?? new Date()).toISOString(),
        prevHash: last?.hash ?? GENESIS_HASH,
      };
      const event: StoredEvent = { ...unhashed, hash: eventHash(unhashed) };
      this.db
        .prepare(
          `INSERT INTO events (seq, id, type, version, actor, run_id, payload, idempotency_key,
             occurred_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.seq,
          event.id,
          event.type,
          event.version,
          event.actor,
          event.runId,
          canonicalJson(event.payload),
          event.idempotencyKey,
          event.occurredAt,
          event.prevHash,
          event.hash,
        );
      this.db.exec("COMMIT");
      return event;
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  read(options: ReadOptions = {}): StoredEvent[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? 1000;
    const types = options.types ?? [];
    const typeFilter = types.length > 0 ? `AND type IN (${types.map(() => "?").join(", ")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE seq > ? ${typeFilter} ORDER BY seq LIMIT ?`)
      .all(afterSeq, ...types, limit) as unknown as EventRow[];
    return rows.map(fromRow);
  }

  /** Kopf der Kette für die Sicherung durch den Supervisor (E38). */
  head(): ChainHead {
    const last = this.db.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get() as
      ChainHead | undefined;
    return last ?? { seq: 0, hash: GENESIS_HASH };
  }

  /**
   * Prüft die Kette vollständig. Erkennt geänderte, gelöschte oder eingefügte Ereignisse.
   * Ob das Ende abgeschnitten wurde, erkennt nur der Vergleich mit einem gesicherten Kopf.
   */
  verifyChain(expectedHead?: ChainHead): ChainCheck {
    let prevHash = GENESIS_HASH;
    let expectedSeq = 1;
    const statement = this.db.prepare("SELECT * FROM events ORDER BY seq");
    for (const raw of statement.iterate()) {
      const event = fromRow(raw as unknown as EventRow);
      if (event.seq !== expectedSeq) {
        return { ok: false, brokenAtSeq: expectedSeq, reason: "Lücke in der Sequenz" };
      }
      if (event.prevHash !== prevHash) {
        return { ok: false, brokenAtSeq: event.seq, reason: "Vorgänger-Hash passt nicht" };
      }
      const { hash, ...rest } = event;
      if (eventHash(rest) !== hash) {
        return { ok: false, brokenAtSeq: event.seq, reason: "Inhalt passt nicht zum Hash" };
      }
      prevHash = hash;
      expectedSeq += 1;
    }
    const head = { seq: expectedSeq - 1, hash: prevHash };
    if (expectedHead !== undefined && expectedHead.seq > 0) {
      const anchor = this.db
        .prepare("SELECT hash FROM events WHERE seq = ?")
        .get(expectedHead.seq) as { hash: string } | undefined;
      if (anchor?.hash !== expectedHead.hash) {
        return {
          ok: false,
          brokenAtSeq: expectedHead.seq,
          reason: "Gesicherter Kopf fehlt oder weicht ab",
        };
      }
    }
    return { ok: true, head };
  }
}
