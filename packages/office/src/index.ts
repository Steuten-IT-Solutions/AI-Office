/** Version des Office-Kerns. Wird mit dem ersten Release durch den Build ersetzt. */
export const OFFICE_VERSION = "0.0.0";

export { canonicalJson, type JsonValue } from "./events/canonical-json.ts";
export {
  EVENT_MIGRATIONS,
  EventStore,
  GENESIS_HASH,
  eventHash,
  type ChainCheck,
  type ChainHead,
  type NewEvent,
  type ReadOptions,
  type StoredEvent,
} from "./events/event-store.ts";
export { EventRegistry, type DecodedEvent, type EventType } from "./events/event-types.ts";
export {
  IncompatibleSchemaError,
  migrate,
  type Migration,
  type MigrationPhase,
  type MigrationStatus,
} from "./events/migrations.ts";

export {
  DEFAULT_FIXTURE_DIR,
  FakeRunner,
  loadFixture,
  type FakeRunnerOptions,
  type FixtureSelector,
} from "./llm/fake-runner.ts";
export {
  OutcomeCollector,
  type LlmRunner,
  type RunExit,
  type RunOptions,
  type RunOutcome,
  type RunRequest,
  type RunType,
} from "./llm/runner.ts";
export {
  LineSplitter,
  MAX_TOOL_RESULT_CHARS,
  parseLine,
  type ModelCost,
  type RunEvent,
  type TokenUsage,
} from "./llm/stream-json.ts";
