export { OFFICE_VERSION } from "./version.ts";

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
  ESCALATION_RAISED,
  MAX_HANDOVER_CHARS,
  MAX_TEXT_CHARS,
  MAX_THOUGHT_CHARS,
  MAX_TITLE_CHARS,
  MESSAGE_SENT,
  RATE_LIMIT_STATUSES,
  RUN_EXITS,
  MAX_RUN_TRIGGERS,
  RUN_FINISHED,
  RUN_STARTED,
  RUN_THOUGHT,
  TASK_CREATED,
  TASK_DELEGATED,
  TASK_HANDOVER,
  TASK_STATUS_CHANGED,
  type AgentHired,
  type AgentProfileChanged,
  type EscalationRaised,
  type MessageSent,
  type RunFinished,
  type RunStarted,
  type RunThought,
  type TaskCreated,
  type TaskDelegated,
  type TaskHandover,
  type TaskStatusChanged,
} from "./domain/events.ts";
export {
  MESSAGE_KINDS,
  mayWake,
  type Escalation,
  type Message,
  type MessageKind,
} from "./domain/message.ts";
export {
  CeoApprovalRequired,
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
  type RunRecord,
  type RunStart,
  type SkippedEvent,
  type Thought,
  type WakeItem,
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
  type TaskAssignment,
  type TaskHandoverNote,
  type TaskStatus,
} from "./domain/task.ts";
export { ValidationError, truncateText, type Parsed } from "./domain/validation.ts";
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
export {
  CONTEXT_BOOKS,
  DEFAULT_CONTEXT_TOKENS,
  HANDBOOK_BOOK,
  MAX_HANDBOOK_TOKENS,
  MIN_INBOX_TOKENS,
  WERKBANK_BOOKS,
  buildContext,
  nest,
  quote,
  type ContextInput,
  type RunContext,
} from "./domain/context.ts";
export {
  AUTO_HANDOVER_ANSWER_CHARS,
  MAX_THOUGHTS_PER_RUN,
  RunEvaluation,
  type RunInfo,
} from "./domain/run-evaluation.ts";
export {
  ERRORS,
  MAX_BODY_BYTES,
  MAX_CALLS_PER_RUN,
  MCP_PATH,
  OfficeApi,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  createOfficeApiServer,
  decodeHeaderValue,
  idempotencyKey,
  type OfficeApiOptions,
} from "./api/mcp-server.ts";
export { MIN_TOKEN_LENGTH, RunTokens, type RunGrant } from "./api/run-tokens.ts";
export {
  MAX_ESCALATIONS_PER_DAY,
  TOOLS,
  ToolError,
  type EscalationGate,
  type ToolDefinition,
} from "./api/tools.ts";
export {
  ERROR_CODES as IPC_ERROR_CODES,
  IPC_METHODS,
  MAX_FRAME_BYTES as IPC_MAX_FRAME_BYTES,
  METHODS as IPC_SCHEMAS,
  PROTOCOL_VERSION as IPC_PROTOCOL_VERSION,
  type IpcErrorCode,
  type IpcMethod,
  type IpcParams,
  type IpcResult,
} from "./ipc/protocol.ts";
export {
  DEFAULT_SOCKET_PATH,
  DEFAULT_TIMEOUT_MS as IPC_DEFAULT_TIMEOUT_MS,
  IpcCallError,
  IpcTransportError,
  SupervisorClient,
  supervisorEscalationGate,
  supervisorRunRequester,
  type SupervisorClientOptions,
} from "./ipc/client.ts";
export {
  CausalChains,
  DEFAULT_PLANNER_CONFIG,
  Planner,
  plan,
  runInfo,
  utcDay,
  type Hold,
  type Notice,
  type Plan,
  type PlanInput,
  type PlannerConfig,
  type PlannerOptions,
  type RunRequester,
  type TickResult,
  type Wake,
} from "./planner/planner.ts";

export {
  API_PREFIX,
  DEFAULT_LOGIN_THROTTLE,
  DEFAULT_POLL_MS,
  LIVE_PATH,
  MAX_BODY_BYTES as GATEWAY_MAX_BODY_BYTES,
  MAX_SOCKETS_PER_SESSION,
  OfficeGateway,
  createGatewayServer,
  type GatewayOptions,
  type LoginThrottle,
} from "./gateway/gateway.ts";
export {
  DEFAULT_SCRYPT,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  isPasswordHash,
  readPasswordFile,
  verifyPassword,
  writePasswordFile,
  type ScryptParams,
} from "./gateway/password.ts";
export {
  DEFAULT_SESSION_CONFIG,
  SESSION_COOKIE,
  Sessions,
  type Session,
  type SessionConfig,
} from "./gateway/sessions.ts";
