import { writeFileSync } from "node:fs";

/**
 * Bericht im Format der Spikes S1c–S1e (spikes/s1-github/src/report.ts), ergänzt um Abschnitte
 * mit Freitext und Tabellen. Jeder Text läuft durch `mask`, damit nie ein Token im Bericht landet
 * (docs/etappe-0.md Kap. 3: „geben nie ein Token aus“).
 */

/** Ersetzt alles, was wie ein Anthropic-Schlüssel oder -Token aussieht. */
export function mask(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
}

export type Verdict = "erwartet" | "ABWEICHUNG" | "info" | "ungültig";

export interface Finding {
  test: string;
  expected: string;
  observed: string;
  verdict: Verdict;
}

function cell(text: string): string {
  return mask(text).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export class Report {
  readonly findings: Finding[] = [];
  readonly sections: string[] = [];
  readonly title: string;
  readonly context: string[];

  constructor(title: string, context: string[] = []) {
    this.title = title;
    this.context = context;
  }

  /** `ok`: `true` erwartet, `false` Abweichung, `null` nur Information. */
  add(test: string, expected: string, observed: string, ok: boolean | null): void {
    const verdict: Verdict = ok === null ? "info" : ok ? "erwartet" : "ABWEICHUNG";
    this.findings.push({ test, expected, observed, verdict });
    console.log(mask(`[${verdict}] ${test}: ${observed}`));
  }

  /** Eine Kontrolle ist fehlgeschlagen; die Messung dahinter gilt nicht. */
  invalid(test: string, expected: string, observed: string): void {
    this.findings.push({ test, expected, observed, verdict: "ungültig" });
    console.log(mask(`[ungültig] ${test}: ${observed}`));
  }

  section(heading: string, lines: string[]): void {
    this.sections.push([`### ${heading}`, "", ...lines.map(mask), ""].join("\n"));
  }

  table(heading: string, header: string[], rows: string[][]): void {
    this.section(heading, [
      `| ${header.map(cell).join(" | ")} |`,
      `|${header.map(() => "---").join("|")}|`,
      ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    ]);
  }

  get outcome(): string {
    if (this.findings.some((f) => f.verdict === "ungültig")) {
      return "Ungültig (eine Kontrolle ist fehlgeschlagen, Messung wiederholen)";
    }
    if (this.findings.some((f) => f.verdict === "ABWEICHUNG")) {
      return "No-Go (Abweichungen)";
    }
    if (!this.findings.some((f) => f.verdict === "erwartet")) {
      return "Nicht bewertbar (keine Prüfung mit Go-Kriterium ausgewertet)";
    }
    return "Go (alle Prüfungen wie erwartet)";
  }

  toMarkdown(now: Date = new Date()): string {
    return [
      `## ${this.title}`,
      "",
      `Zeitpunkt: ${now.toISOString()}`,
      ...this.context.map((line) => mask(line)),
      `Gesamtergebnis: ${this.outcome}`,
      "",
      "| Prüfung | Erwartet | Beobachtet | Ergebnis |",
      "|---|---|---|---|",
      ...this.findings.map(
        (f) => `| ${cell(f.test)} | ${cell(f.expected)} | ${cell(f.observed)} | ${f.verdict} |`,
      ),
      "",
      ...this.sections,
    ].join("\n");
  }

  write(file: string): void {
    writeFileSync(file, this.toMarkdown());
    console.log(`\nBericht geschrieben: ${file}`);
  }
}
