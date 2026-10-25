import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OutcomeCollector,
  type LlmRunner,
  type RunOptions,
  type RunOutcome,
  type RunRequest,
} from "./runner.ts";
import { LineSplitter, parseLine } from "./stream-json.ts";

/**
 * Spielt aufgezeichnete `stream-json`-Läufe ab (E23). Kein Netz, kein Kontingent, deterministisch.
 *
 * Die Aufzeichnungen liegen in `packages/office/fixtures/runs/` und sind ein kritischer Pfad
 * (plan.md Kap. 4.5 Nr. 3): Wer sie ändert, ändert, was die Tests für einen gültigen Lauf halten.
 */
export type FixtureSelector = (request: RunRequest) => string;

export interface FakeRunnerOptions {
  /** Wählt je Auftrag den Namen der Aufzeichnung (ohne `.ndjson`). */
  select: FixtureSelector;
  /** Verzeichnis der Aufzeichnungen. Standard: die mitgelieferten Fixtures. */
  directory?: string;
  /** Größe der Blöcke, in denen der Text geliefert wird; prüft das Zerlegen in Zeilen. */
  chunkSize?: number;
}

export const DEFAULT_FIXTURE_DIR = join(import.meta.dirname, "..", "..", "fixtures", "runs");

const FIXTURE_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function loadFixture(name: string, directory = DEFAULT_FIXTURE_DIR): string {
  if (!FIXTURE_NAME.test(name)) {
    throw new Error(`Ungültiger Fixture-Name: ${name}`);
  }
  return readFileSync(join(directory, `${name}.ndjson`), "utf8");
}

export class FakeRunner implements LlmRunner {
  readonly requests: RunRequest[] = [];
  private readonly options: FakeRunnerOptions;

  constructor(options: FakeRunnerOptions) {
    this.options = options;
  }

  run(request: RunRequest, options: RunOptions = {}): Promise<RunOutcome> {
    this.requests.push(request);
    const text = loadFixture(this.options.select(request), this.options.directory);
    const collector = new OutcomeCollector(request.runId);
    const splitter = new LineSplitter();
    const chunkSize = this.options.chunkSize ?? text.length;
    const emit = (line: string) => {
      for (const event of parseLine(line)) {
        collector.add(event);
        options.onEvent?.(event);
      }
    };

    for (let offset = 0; offset < text.length; offset += chunkSize) {
      if (options.signal?.aborted === true) {
        return Promise.resolve(collector.finish(true));
      }
      for (const line of splitter.push(text.slice(offset, offset + chunkSize))) {
        emit(line);
      }
    }
    for (const line of splitter.end()) {
      emit(line);
    }
    return Promise.resolve(collector.finish(options.signal?.aborted === true));
  }
}
