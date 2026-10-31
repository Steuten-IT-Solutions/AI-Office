import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.ts";
import { EVENT_MIGRATIONS, EventStore, GENESIS_HASH } from "./event-store.ts";
import { EventRegistry, type EventType } from "./event-types.ts";
import { IncompatibleSchemaError, migrate, type Migration } from "./migrations.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aio-events-"));
  path = join(dir, "office.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("canonicalJson", () => {
  it("sortiert Schlüssel unabhängig von der Einfügereihenfolge", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, "x"], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, "x"] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("lehnt Werte ab, die kein JSON sind", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
  });
});

describe("EventStore", () => {
  it("hängt Ereignisse mit lückenloser Sequenz und Hash-Kette an", () => {
    const store = EventStore.open(path);
    const first = store.append({ type: "message.sent", actor: "ceo", payload: { text: "Hallo" } });
    const second = store.append({ type: "message.sent", actor: "cto", payload: { text: "Hi" } });
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(store.head()).toEqual({ seq: 2, hash: second.hash });
    expect(store.verifyChain()).toEqual({ ok: true, head: { seq: 2, hash: second.hash } });
    store.close();
  });

  it("liest nach Sequenz und Typ gefiltert", () => {
    const store = EventStore.open(path);
    store.append({ type: "a", actor: "system", payload: 1 });
    store.append({ type: "b", actor: "system", payload: 2 });
    store.append({ type: "a", actor: "system", payload: 3 });
    expect(store.read({ types: ["a"] }).map((e) => e.payload)).toEqual([1, 3]);
    expect(store.read({ afterSeq: 1, limit: 1 }).map((e) => e.seq)).toEqual([2]);
    store.close();
  });

  it("ist bei gleichem Idempotenzschlüssel idempotent", () => {
    const store = EventStore.open(path);
    const first = store.append({
      type: "task.created",
      actor: "coo",
      runId: "r-1",
      idempotencyKey: "r-1:1",
      payload: { title: "A" },
    });
    const again = store.append({
      type: "task.created",
      actor: "coo",
      runId: "r-1",
      idempotencyKey: "r-1:1",
      payload: { title: "A" },
    });
    expect(again).toEqual(first);
    expect(store.read()).toHaveLength(1);
    expect(store.findByIdempotencyKey("r-1:1")).toEqual(first);
    expect(store.findByIdempotencyKey("r-1:2")).toBeUndefined();
    expect(() =>
      store.append({
        type: "task.created",
        actor: "coo",
        idempotencyKey: "r-1:1",
        payload: { title: "B" },
      }),
    ).toThrow(/anderem Inhalt/);
    store.close();
  });

  it("bleibt nach dem Schließen und erneuten Öffnen konsistent", () => {
    const store = EventStore.open(path);
    const event = store.append({ type: "x", actor: "system", payload: { n: 1 } });
    store.close();
    const reopened = EventStore.open(path);
    expect(reopened.read()).toEqual([event]);
    expect(reopened.migration.applied).toEqual([]);
    reopened.close();
  });

  describe("erkennt Manipulation", () => {
    function tamper(sql: string): void {
      const db = new DatabaseSync(path);
      db.exec(sql);
      db.close();
    }

    function filled(): EventStore {
      const store = EventStore.open(path);
      for (let i = 1; i <= 3; i++) {
        store.append({ type: "x", actor: "system", payload: { n: i } });
      }
      return store;
    }

    it("bei geändertem Inhalt", () => {
      const store = filled();
      tamper(`UPDATE events SET payload = '{"n":99}' WHERE seq = 2`);
      expect(store.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 2 });
      store.close();
    });

    it("bei gelöschtem Ereignis in der Mitte", () => {
      const store = filled();
      tamper("DELETE FROM events WHERE seq = 2");
      expect(store.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 2 });
      store.close();
    });

    it("bei abgeschnittenem Ende nur mit gesichertem Kopf", () => {
      const store = filled();
      const savedHead = store.head();
      tamper("DELETE FROM events WHERE seq = 3");
      expect(store.verifyChain().ok).toBe(true);
      expect(store.verifyChain(savedHead)).toMatchObject({ ok: false, brokenAtSeq: 3 });
      store.close();
    });

    it("bei neu berechnetem Hash ohne angepassten Nachfolger", () => {
      const store = filled();
      const events = store.read();
      tamper(`UPDATE events SET hash = '${"f".repeat(64)}' WHERE seq = ${String(events[1]?.seq)}`);
      expect(store.verifyChain()).toMatchObject({ ok: false, brokenAtSeq: 2 });
      store.close();
    });
  });
});

describe("Migrationen (Expand/Contract)", () => {
  const addColumn: Migration = {
    version: 2,
    name: "events_tag",
    phase: "expand",
    up(db) {
      db.exec("ALTER TABLE events ADD COLUMN tag TEXT");
    },
  };
  const dropIndex: Migration = {
    version: 3,
    name: "drop_events_run",
    phase: "contract",
    up(db) {
      db.exec("DROP INDEX events_run");
    },
  };

  it("Vorversion liest und schreibt einen per Expand migrierten Stand", () => {
    const newer = EventStore.open(path, [...EVENT_MIGRATIONS, addColumn]);
    newer.append({ type: "x", actor: "system", payload: { von: "neu" } });
    newer.close();

    const older = EventStore.open(path, EVENT_MIGRATIONS);
    expect(older.migration.unknownExpand).toEqual([2]);
    older.append({ type: "x", actor: "system", payload: { von: "alt" } });
    expect(older.read().map((e) => e.payload)).toEqual([{ von: "neu" }, { von: "alt" }]);
    expect(older.verifyChain().ok).toBe(true);
    older.close();
  });

  it("Vorversion startet nach einer Contract-Migration nicht", () => {
    const newer = EventStore.open(path, [...EVENT_MIGRATIONS, addColumn, dropIndex]);
    newer.close();
    expect(() => EventStore.open(path, [...EVENT_MIGRATIONS, addColumn])).toThrow(
      IncompatibleSchemaError,
    );
  });

  it("rollt eine fehlerhafte Migration vollständig zurück", () => {
    const broken: Migration = {
      version: 2,
      name: "broken",
      phase: "expand",
      up(db) {
        db.exec("CREATE TABLE half (x INTEGER)");
        db.exec("THIS IS NOT SQL");
      },
    };
    expect(() => EventStore.open(path, [...EVENT_MIGRATIONS, broken])).toThrow();
    const db = new DatabaseSync(path);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half'")
      .all();
    const versions = db.prepare("SELECT version FROM schema_migrations").all();
    db.close();
    expect(tables).toEqual([]);
    expect(versions.map((v) => v["version"])).toEqual([1]);
  });

  it("verlangt lückenlose Nummerierung", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => migrate(db, [{ ...addColumn }])).toThrow(/lückenlos/);
    db.close();
  });
});

describe("EventRegistry", () => {
  interface Sent {
    text: string;
  }
  const messageSent: EventType<Sent> = {
    type: "message.sent",
    version: 1,
    parse(payload) {
      if (typeof payload === "object" && payload !== null && "text" in payload) {
        const text = payload.text;
        return typeof text === "string" ? { text } : null;
      }
      return null;
    },
  };

  it("überspringt unbekannte Typen, neuere Versionen und ungültige Payloads", () => {
    const store = EventStore.open(path);
    const registry = new EventRegistry();
    registry.register(messageSent);
    store.append({ type: "message.sent", actor: "ceo", payload: { text: "ok" } });
    store.append({ type: "future.thing", actor: "cto", payload: { a: 1 } });
    store.append({ type: "message.sent", version: 2, actor: "cto", payload: { text: "v2" } });
    store.append({ type: "message.sent", actor: "cto", payload: { falsch: true } });

    const decoded = store.read().map((e) => registry.decode(e));
    expect(decoded.map((d) => (d.kind === "known" ? "known" : d.reason))).toEqual([
      "known",
      "type",
      "version",
      "payload",
    ]);
    expect(registry.decodeAs(messageSent, store.read()[0] ?? expect.fail())).toEqual({
      text: "ok",
    });
    store.close();
  });

  it("verbietet doppelte Registrierung", () => {
    const registry = new EventRegistry();
    registry.register(messageSent);
    expect(() => registry.register(messageSent)).toThrow(/doppelt/);
  });
});
