/**
 * Nachrichten (plan.md Kap. 5.4). Jede Nachricht hat eine Art:
 *
 * - `auftrag`: Der Empfänger soll etwas tun.
 * - `frage`: Der Empfänger soll antworten.
 * - `info`: Weckt niemanden und wird beim nächsten Lauf mitgelesen (E32).
 *
 * Die Weckregeln selbst setzt der Planer um (P06).
 */

export const MESSAGE_KINDS = ["auftrag", "frage", "info"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface Message {
  /** ID des Ereignisses `message.sent`. */
  id: string;
  seq: number;
  occurredAt: string;
  /** Absender: Agenten-ID oder `ceo`. */
  fromId: string;
  /** Empfänger: Agenten-ID oder `ceo`. */
  toId: string;
  kind: MessageKind;
  text: string;
  taskId: string | null;
  /** ID der Nachricht, auf die geantwortet wird. */
  replyToId: string | null;
  runId: string | null;
}

/** Ob eine Nachricht dieser Art den Empfänger wecken darf (E32). */
export function mayWake(kind: MessageKind): boolean {
  return kind !== "info";
}

/** Eskalation (Kap. 5.4, E47). Weckt den Empfänger immer. */
export interface Escalation {
  /** ID des Ereignisses `escalation.raised`. */
  id: string;
  seq: number;
  occurredAt: string;
  /** Agent oder `system` (z. B. Weitergabe nach Timeout, P06). */
  fromId: string;
  toId: string;
  text: string;
  taskId: string | null;
  runId: string | null;
  /** Sequenznummer der ersten Antwort des Empfängers, sonst `null`. */
  answeredSeq: number | null;
}
