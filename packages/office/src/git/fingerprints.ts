import { createHash } from "node:crypto";
import { CEO_ID } from "../domain/agent.ts";
import type { Office } from "../domain/office.ts";
import type { OfficeState } from "../domain/office-state.ts";
import {
  FINGERPRINT_SOURCES,
  MAX_FINGERPRINTS_PER_CALL,
  type IpcParams,
  type IpcResult,
} from "../ipc/protocol.ts";
import type { RunRequester } from "../planner/planner.ts";

/**
 * Fingerabdrücke aus CEO-Chat und Gedächtnis für den Ausgangsfilter des Git-Gates (Office-Seite
 * von S08, plan.md Kap. 5.9 „Ausgehend“, E33). Der Supervisor prüft jeden Text, der nach GitHub
 * geht, gegen diese Abdrücke. Das Office meldet nur SHA-256-Werte, nie den Klartext.
 *
 * **Was gemeldet wird** [Vorschlag, Kap. 5.9 nennt nur „CEO-Chat und Gedächtnis“]:
 * - CEO-Chat (`ceo_chat`): jede Nachricht vom oder an den CEO, jede Eskalation an den CEO und
 *   jede Weisung des CEO (E68).
 * - Gedächtnis (`memory`): jede Übergabenotiz (Kap. 5.2), auch frühere und automatische.
 *   Journal und Beziehungen gibt es im Office noch nicht.
 *
 * **Zurückgestellt** werden Texte, die ein Werkbank-Lauf selbst geschrieben hat, bis das Git-Gate
 * dessen Übergabe abgeschlossen hat (`git.outcome`). Grund: Ein Agent fasst in Übergabenotiz und
 * PR-Text oft dasselbe zusammen. Würde die eigene Notiz vor der Prüfung gemeldet, lehnte das Gate
 * den PR desselben Laufs ab, je nachdem, wer schneller ist. Die Texte des Laufs waren nicht seine
 * Eingabe; was er gelesen hat (CEO-Chat, frühere Notizen), ist zu dem Zeitpunkt längst gemeldet.
 * Ein späterer Lauf, der die Notiz im Kontext hat, wird dagegen geprüft.
 *
 * **Reihenfolge:** `fingerprintsFirst` meldet vor jedem Antrag auf einen Werkbank-Lauf alles
 * Offene und beantragt den Lauf nur, wenn das gelungen ist. Was der Lauf im Kontext sieht, ist
 * damit beim Supervisor, bevor er etwas übergeben kann. Was während des Laufs dazukommt, meldet
 * der nächste Durchlauf (`report` im Takt).
 *
 * Der Fortschritt liegt nur im Speicher. Nach einem Neustart meldet das Office alles noch einmal;
 * der Supervisor zählt Doppelte nicht (`added`) und kennt nur Hinzufügen.
 */

/** Wörter je Fingerabdruck, wie `FINGERPRINT_WORDS` im Supervisor (S08). */
export const FINGERPRINT_WORDS = 8;

export type FingerprintSource = (typeof FINGERPRINT_SOURCES)[number];

/** Wörter wie im Supervisor: NFKC, Kleinbuchstaben, Folgen aus Buchstaben und Ziffern. */
export function fingerprintWords(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * SHA-256 (hex) jedes Fensters aus {@link FINGERPRINT_WORDS} aufeinanderfolgenden Wörtern, mit
 * einem Leerzeichen verbunden. Dieselbe Rechnung wie `fingerprintsOf` im Supervisor; ein Test
 * hält Beispielwerte aus dem Supervisor fest. Kürzere Texte ergeben keinen Abdruck.
 */
export function fingerprintsOf(text: string): string[] {
  const words = fingerprintWords(text);
  const result: string[] = [];
  for (let i = 0; i + FINGERPRINT_WORDS <= words.length; i++) {
    const window = words.slice(i, i + FINGERPRINT_WORDS).join(" ");
    result.push(createHash("sha256").update(window, "utf8").digest("hex"));
  }
  return result;
}

/** Zugriff auf die Ablage im Supervisor, im Betrieb `supervisorGitAccess` (P02). */
export interface FingerprintAccess {
  addFingerprints(params: IpcParams<"fingerprints.add">): Promise<IpcResult<"fingerprints.add">>;
}

export interface FingerprintReport {
  /** Gesendete Abdrücke in diesem Durchlauf. */
  sent: number;
  /** Davon neu laut Supervisor. */
  added: number;
  /** Noch nicht gesendet, weil ein Aufruf scheiterte. Der nächste Durchlauf versucht es wieder. */
  unsent: number;
  /** Zurückgestellt, bis die Übergabe ihres Werkbank-Laufs abgeschlossen ist. */
  deferred: number;
  error: string | null;
}

interface Text {
  source: FingerprintSource;
  text: string;
  /** Lauf, in dem der Text entstand, sonst `null`. */
  runId: string | null;
}

export class FingerprintReporter {
  private readonly office: Office;
  private readonly access: FingerprintAccess;
  /** Bis hierhin sind die Texte eingesammelt (gemeldet, offen oder zurückgestellt). */
  private collectedUpToSeq = 0;
  /** Abdrücke je Quelle, die noch gesendet werden müssen. */
  private readonly unsent: Record<FingerprintSource, Set<string>> = {
    ceo_chat: new Set(),
    memory: new Set(),
  };
  /** Texte je Werkbank-Lauf, dessen Übergabe noch läuft. */
  private readonly deferred = new Map<string, Text[]>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { office: Office; access: FingerprintAccess }) {
    this.office = options.office;
    this.access = options.access;
  }

  /** Abdrücke, die noch nicht beim Supervisor sind (ohne zurückgestellte). */
  get pending(): number {
    return this.unsent.ceo_chat.size + this.unsent.memory.size;
  }

  /** Sammelt neue Texte ein und meldet alles Offene. Nie zwei Durchläufe gleichzeitig. */
  report(): Promise<FingerprintReport> {
    const next = this.queue.then(() => this.run());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async run(): Promise<FingerprintReport> {
    this.office.sync();
    const state = this.office.state;
    for (const text of collect(state, this.collectedUpToSeq)) {
      if (text.runId !== null && awaitsGitOutcome(state, text.runId)) {
        const list = this.deferred.get(text.runId) ?? [];
        list.push(text);
        this.deferred.set(text.runId, list);
      } else {
        this.add(text);
      }
    }
    this.collectedUpToSeq = state.lastSeq;
    for (const [runId, texts] of [...this.deferred]) {
      if (!awaitsGitOutcome(state, runId)) {
        this.deferred.delete(runId);
        texts.forEach((t) => {
          this.add(t);
        });
      }
    }

    const report: FingerprintReport = { sent: 0, added: 0, unsent: 0, deferred: 0, error: null };
    try {
      for (const source of FINGERPRINT_SOURCES) {
        const set = this.unsent[source];
        while (set.size > 0) {
          const hashes = [...set].slice(0, MAX_FINGERPRINTS_PER_CALL);
          const answer = await this.access.addFingerprints({ source, hashes });
          hashes.forEach((h) => set.delete(h));
          report.sent += hashes.length;
          report.added += answer.added;
        }
      }
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    }
    report.unsent = this.pending;
    report.deferred = [...this.deferred.values()].reduce((n, list) => n + list.length, 0);
    return report;
  }

  private add(text: Text): void {
    const set = this.unsent[text.source];
    for (const hash of fingerprintsOf(text.text)) {
      set.add(hash);
    }
  }
}

/** Texte aus CEO-Chat und Gedächtnis nach `afterSeq`. */
function collect(state: OfficeState, afterSeq: number): Text[] {
  const texts: Text[] = [];
  for (const m of state.messages({ afterSeq })) {
    if (m.fromId === CEO_ID || m.toId === CEO_ID) {
      texts.push({ source: "ceo_chat", text: m.text, runId: m.runId });
    }
  }
  for (const e of state.escalations({ toId: CEO_ID, afterSeq })) {
    texts.push({ source: "ceo_chat", text: e.text, runId: e.runId });
  }
  // Weisungen sind Worte des CEO wie der Chat (E68).
  for (const d of state.directives()) {
    if (d.seq > afterSeq) {
      texts.push({ source: "ceo_chat", text: d.text, runId: null });
    }
  }
  for (const h of state.handovers({ afterSeq })) {
    texts.push({ source: "memory", text: h.note, runId: h.runId });
  }
  return texts;
}

/** Werkbank-Lauf, dessen Übergabe noch nicht endgültig festgehalten ist. */
function awaitsGitOutcome(state: OfficeState, runId: string): boolean {
  const start = state.runStart(runId);
  const runType = state.run(runId)?.runType ?? start?.runType;
  return runType === "werkbank" && state.gitOutcome(runId) === undefined;
}

/**
 * Meldet vor jedem Antrag auf einen Werkbank-Lauf alle offenen Abdrücke (siehe oben). Scheitert
 * das, wird der Lauf nicht beantragt; der Planer versucht es später wieder. Andere Lauftypen
 * übergeben nichts an Git und gehen unverändert durch.
 */
export function fingerprintsFirst(
  requester: RunRequester,
  reporter: FingerprintReporter,
): RunRequester {
  return {
    async requestRun(params) {
      if (params.runType === "werkbank") {
        const report = await reporter.report();
        if (report.unsent > 0) {
          throw new Error(
            `Fingerabdrücke nicht beim Supervisor (${String(report.unsent)} offen: ${report.error ?? "unbekannt"}); Werkbank-Lauf nicht beantragt`,
          );
        }
      }
      return requester.requestRun(params);
    },
  };
}
