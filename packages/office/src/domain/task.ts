import type { RunType } from "../llm/runner.ts";

/**
 * Aufgaben (plan.md Kap. 3.3, 5.7). Der Lauftyp ist an der Aufgabe festgelegt und wird vom
 * Supervisor geprüft (Kap. 5.7). Eine Aufgabe entsteht durch `create_task`, wechselt den
 * Bearbeiter durch `delegate` (P08) und ändert ihren Status im Lauf der Arbeit.
 */

export const TASK_STATUSES = [
  "offen",
  "in_arbeit",
  "blockiert",
  "erledigt",
  "abgebrochen",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Abgeschlossene Zustände. Ein Wechsel zurück nach `offen` gilt als Wiedereröffnung. */
export const CLOSED_STATUSES: readonly TaskStatus[] = ["erledigt", "abgebrochen"];

export interface Task {
  /** ID des Ereignisses `task.created`. */
  id: string;
  title: string;
  description: string;
  runType: RunType;
  /** Repo für `werkbank`-Aufgaben, z. B. `Steuten-IT-Solutions/AI-Office`. */
  repo: string | null;
  createdBy: string;
  assigneeId: string | null;
  parentTaskId: string | null;
  status: TaskStatus;
  /**
   * Wie oft die Aufgabe wieder geöffnet wurde. Mehr als 3 löst den Schutzschalter aus
   * (Kap. 4.3); das zählt maßgeblich der Supervisor, hier nur für Anzeige und Planer.
   */
  reopenCount: number;
  createdSeq: number;
  updatedSeq: number;
}

/**
 * Erlaubte Statuswechsel: Offene Zustände wechseln frei untereinander und in einen
 * abgeschlossenen. Abgeschlossene Aufgaben können nur wieder geöffnet werden (`offen`).
 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) {
    return false;
  }
  if (CLOSED_STATUSES.includes(from)) {
    return to === "offen";
  }
  return true;
}

export function isReopen(from: TaskStatus, to: TaskStatus): boolean {
  return CLOSED_STATUSES.includes(from) && to === "offen";
}
