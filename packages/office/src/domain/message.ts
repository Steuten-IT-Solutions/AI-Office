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
