import { writeFileSync } from "node:fs";

export type Verdict = "erwartet" | "ABWEICHUNG" | "info";

export interface Finding {
  test: string;
  expected: string;
  observed: string;
  verdict: Verdict;
}

export class Report {
  readonly findings: Finding[] = [];

  readonly title: string;

  constructor(title: string) {
    this.title = title;
  }

  add(test: string, expected: string, observed: string, ok: boolean | null): void {
    const verdict: Verdict = ok === null ? "info" : ok ? "erwartet" : "ABWEICHUNG";
    this.findings.push({ test, expected, observed, verdict });
    console.log(`[${verdict}] ${test}: ${observed}`);
  }

  get passed(): boolean {
    return this.findings.every((f) => f.verdict !== "ABWEICHUNG");
  }

  toMarkdown(): string {
    const escape = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");
    const rows = this.findings.map(
      (f) => `| ${escape(f.test)} | ${escape(f.expected)} | ${escape(f.observed)} | ${f.verdict} |`,
    );
    return [
      `## ${this.title}`,
      "",
      `Zeitpunkt: ${new Date().toISOString()}`,
      `Gesamtergebnis: ${this.passed ? "Go (alle Prüfungen wie erwartet)" : "No-Go (Abweichungen)"}`,
      "",
      "| Prüfung | Erwartet | Beobachtet | Ergebnis |",
      "|---|---|---|---|",
      ...rows,
      "",
    ].join("\n");
  }

  write(file: string): void {
    writeFileSync(file, this.toMarkdown());
    console.log(`\nBericht geschrieben: ${file}`);
  }
}
