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

export {
  CEO_ID,
  EQUIPMENT,
  MODEL_ALIASES,
  allowedRunTypes,
  parseAgentProfile,
  type AgentProfile,
  type Equipment,
  type ModelAlias,
  type ModelChoice,
  type Temperament,
  type Weakness,
} from "./domain/agent.ts";
export {
  ROOM_KINDS,
  findRoom,
  parseBuilding,
  totalWorkplaces,
  type Building,
  type Floor,
  type Room,
  type RoomKind,
} from "./domain/building.ts";
export {
  AGENT_HIRED,
  AGENT_PROFILE_CHANGED,
  DOMAIN_EVENT_TYPES,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MESSAGE_SENT,
  TASK_CREATED,
  TASK_DELEGATED,
  TASK_STATUS_CHANGED,
  type AgentHired,
  type AgentProfileChanged,
  type MessageSent,
  type TaskCreated,
  type TaskDelegated,
  type TaskStatusChanged,
} from "./domain/events.ts";
export { MESSAGE_KINDS, mayWake, type Message, type MessageKind } from "./domain/message.ts";
export {
  DomainError,
  Office,
  type CommandOptions,
  type NewMessage,
  type NewTask,
} from "./domain/office.ts";
export {
  OfficeState,
  domainRegistry,
  type PendingEvent,
  type SkippedEvent,
} from "./domain/office-state.ts";
export {
  DEFAULT_START_DIR,
  loadStartData,
  seedStartAgents,
  type StartData,
} from "./domain/start-data.ts";
export {
  CLOSED_STATUSES,
  TASK_STATUSES,
  canTransition,
  isReopen,
  type Task,
  type TaskStatus,
} from "./domain/task.ts";
export { ValidationError, type Parsed } from "./domain/validation.ts";
export {
  MAX_HANDBOOK_START_TOKENS,
  MAX_PERSONA_TOKENS,
  TRUST_LEVELS,
  estimateTokens,
  loadStartBooks,
  loadStartPersonas,
  parseBook,
  parsePersona,
  splitFrontMatter,
  type Book,
  type Persona,
  type TrustLevel,
} from "./domain/start-content.ts";
