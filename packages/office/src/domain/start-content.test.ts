import { describe, expect, it } from "vitest";
import {
  MAX_PERSONA_TOKENS,
  estimateTokens,
  loadStartBooks,
  loadStartPersonas,
  parseBook,
  parsePersona,
} from "./start-content.ts";
import { loadStartData } from "./start-data.ts";
import { ValidationError } from "./validation.ts";

const books = loadStartBooks();
const personas = loadStartPersonas();
const { agents } = loadStartData();

describe("Startbücher", () => {
  it("sind die vier Bücher aus P11, alle intern und vom CEO", () => {
    expect(books.map((b) => b.id)).toEqual([
      "firmenhandbuch",
      "git-workflow",
      "kostenregeln",
      "office-api",
    ]);
    for (const book of books) {
      expect(book).toMatchObject({ owner: "ceo", trust: "intern", date: "2026-10-31" });
    }
  });

  it("nennen im Firmenhandbuch die Normen aus Kap. 5.12", () => {
    const handbook = books.find((b) => b.id === "firmenhandbuch")?.body ?? "";
    for (const norm of ["knapp", "`info` statt `auftrag`", "Agenda", "Begründung"]) {
      expect(handbook).toContain(norm);
    }
  });

  it("beschreiben alle Werkzeuge der Office-API aus Kap. 7.3", () => {
    const api = books.find((b) => b.id === "office-api")?.body ?? "";
    for (const tool of ["send_message", "create_task", "delegate", "handover", "escalate"]) {
      expect(api).toContain(`\`${tool}\``);
    }
  });
});

describe("Persona-Texte", () => {
  it("gibt es genau für jeden Startagenten", () => {
    expect(personas.map((p) => p.agentId)).toEqual(agents.map((a) => a.id));
  });

  it("nennen Name und Rolle des Profils und bleiben unter der Obergrenze", () => {
    for (const agent of agents) {
      const persona = personas.find((p) => p.agentId === agent.id);
      expect(persona?.body).toContain(`${agent.name}, ${agent.role}`);
      expect(estimateTokens(persona?.body ?? "")).toBeLessThanOrEqual(MAX_PERSONA_TOKENS);
    }
  });

  it("enthalten Verhaltensregeln statt Skalenwerten (Kap. 5.12)", () => {
    const scaleWords =
      /Offenheit|Gewissenhaftigkeit|Extraversion|Verträglichkeit|Belastbarkeit|\d\s*\/\s*5/;
    for (const persona of personas) {
      expect(persona.body).not.toMatch(scaleWords);
      expect(persona.body).toMatch(/^- /m);
    }
  });
});

describe("Kopf der Markdown-Dateien", () => {
  const head = "titel: T\nquelle: Q\ndatum: 2026-10-31\nbesitzer: ceo\nvertrauensstufe: intern";

  it("wird gelesen und geprüft", () => {
    const book = parseBook("buch", `---\n${head}\n---\n\nText`);
    expect(book).toEqual({
      ok: true,
      value: {
        id: "buch",
        title: "T",
        source: "Q",
        date: "2026-10-31",
        owner: "ceo",
        trust: "intern",
        body: "Text",
      },
    });
    const bad = parseBook("buch", `---\n${head.replace("intern", "geheim")}\nfarbe: rot\n---\nX`);
    expect(bad.ok ? [] : bad.issues).toEqual([
      "farbe: unbekanntes Feld",
      "vertrauensstufe: einer von intern, extern-ungeprüft, extern-geprüft erwartet",
    ]);
  });

  it("lehnt fehlende Köpfe, kaputte Zeilen und zu lange Personas ab", () => {
    expect(() => parseBook("buch", "# Ohne Kopf")).toThrow(ValidationError);
    expect(() => parseBook("buch", "---\nkein wert\n---\nX")).toThrow(ValidationError);
    const long = parsePersona(`---\nagent: a\ndatum: 2026-10-31\n---\n${"x".repeat(901)}`);
    expect(long.ok ? [] : long.issues).toEqual(["Text hat geschätzt 301 Tokens, höchstens 300"]);
  });
});
