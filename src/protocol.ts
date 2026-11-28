// pi-live protocol: bus types (in-process, pi.events) and wire types (NDJSON socket).
// No imports, so clients can import or copy this file for types.

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Bus (pi.events)
// ---------------------------------------------------------------------------

/** Channel names on pi.events. */
export const CHANNEL_PARK = "pi-live:park";
export const CHANNEL_READY = "pi-live:ready";
export const CHANNEL_CLOSED = "pi-live:closed";
export const CHANNEL_WHO = "pi-live:who";

export interface ParkRequest {
	protocol: 1;
	/** Unique within the session. ask_user uses the toolCallId. */
	id: string;
	/** Who parked it, e.g. "ask_user". Shown to clients. */
	owner: string;
	/** Payload type, owned by the parker, e.g. "ask_user.question" or "ask_user.batch". */
	kind: string;
	/** Short line for lists and notifications, e.g. the question text. */
	title: string;
	/** JSON-safe payload clients render. pi-live never reads inside it. */
	view: unknown;
	/** Epoch ms when the parker will give up (its timeout), if any. */
	expiresAt?: number;

	/**
	 * pi-live calls this with an answer from a client. It must be synchronous:
	 * validate, and if valid, resolve the waiting prompt before returning.
	 */
	answer(answer: unknown, from: ClientInfo): AnswerOutcome;

	/** pi-live calls this synchronously during emit to accept the park. */
	accept(ticket: ParkTicket): void;
}

export type AnswerOutcome =
	| { status: "delivered" }
	| { status: "invalid"; reason: string };

export interface ParkTicket {
	/** The parker calls this exactly once, however the wait ends. Idempotent. */
	close(outcome: CloseOutcome): void;
}

export type CloseOutcome = {
	by: "keyboard" | "client" | "timeout" | "abort" | "error" | "shutdown";
	/** Set when by === "client". */
	client?: ClientInfo;
};

export interface ClientInfo {
	connId: string;
	name: string;
}

/** Payload of `pi-live:ready`, and what `pi-live:who` replies with. */
export interface ReadyInfo {
	protocol: 1;
	sessionId: string;
	socketPath: string;
}

/** Payload of `pi-live:closed`. */
export interface ClosedInfo {
	sessionId: string;
}

/** Payload of `pi-live:who`. pi-live calls `reply` synchronously if it is listening. */
export interface WhoRequest {
	reply(info: ReadyInfo): void;
}

// ---------------------------------------------------------------------------
// Wire (NDJSON over the socket)
// ---------------------------------------------------------------------------

/** `ParkRequest` without the callbacks, plus `openedAt`. */
export interface Item {
	id: string;
	owner: string;
	kind: string;
	title: string;
	view: unknown;
	openedAt: number;
	expiresAt?: number;
}

export type SessionMode = "tui" | "rpc";

/** pi's `session_shutdown` reason. Anything but "quit" means a new socket for the same pid is coming. */
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface SessionInfo {
	id: string;
	file?: string;
	cwd: string;
	pid: number;
	/** Since 0.2. */
	mode?: SessionMode;
	/** Since 0.2. `PI_LIVE_TERMINAL`, else `HC_TERMINAL_ID`; omitted if neither is set. */
	terminal?: string;
	/** Since 0.2. The session name, omitted if none. */
	name?: string;
}

/** Sidecar `<sessionId>.json` next to each socket. */
export interface Sidecar {
	protocol: 1;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	pid: number;
	startedAt: string;
	socketPath: string;
	/** Since 0.2. */
	mode?: SessionMode;
	/** Since 0.2. Omitted if none. */
	terminal?: string;
	/** Since 0.2. pi-live's package version. */
	version?: string;
}

// Client → pi-live

export interface HelloMessage {
	type: "hello";
	protocol: number;
	client: { name: string };
	/** Since 0.2. Ask for chat messages (§ chat). Actions don't need it. */
	chat?: boolean;
}

export interface AnswerMessage {
	type: "answer";
	reqId: string;
	id: string;
	answer: unknown;
}

export interface PingMessage {
	type: "ping";
	reqId: string;
}

/** Since 0.2. Act on pi. Refused unless control is on. */
export type ActionMessage = { type: "action"; reqId: string } & Action;

/** Since 0.3. A piece of a `send`, shaped like pi's own content blocks. */
export type SendBlock =
	| { type: "text"; text: string }
	/** `data` is base64 without a `data:` prefix. */
	| { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" };

export type Action =
	/** Send `text`, or since 0.3 `content` (not both). */
	| { op: "send"; text?: string; content?: SendBlock[]; deliverAs?: "steer" | "followUp" }
	| { op: "stop" }
	| { op: "set_model"; model: string }
	| { op: "set_effort"; effort: string }
	| { op: "set_name"; name: string }
	| { op: "compact"; instructions?: string }
	| { op: "clear_input" };

export type ClientMessage = HelloMessage | AnswerMessage | PingMessage | ActionMessage;

// pi-live → client

export type Feature = "chat" | "control" | "images";

export interface WelcomeMessage {
	type: "welcome";
	protocol: 1;
	/** Since 0.2. pi-live's package version. Decide on `features`, not on this. */
	version?: string;
	/** Since 0.2. "control" only when control is on. */
	features?: Feature[];
	/** Since 0.2. */
	control?: boolean;
	session: SessionInfo;
	connId: string;
	/** Oldest first. */
	items: Item[];
	/** Since 0.2, for `chat: true` clients: the whole current picture. */
	chat?: ChatSnapshot;
}

export interface ItemOpenedMessage {
	type: "item_opened";
	item: Item;
}

export interface ItemClosedMessage {
	type: "item_closed";
	id: string;
	outcome: CloseOutcome;
}

export type AnswerStatus = "delivered" | "invalid" | "closed" | "not_found";

export type AnswerResult =
	| { status: "delivered" }
	| { status: "invalid"; reason: string }
	| { status: "closed" }
	| { status: "not_found" };

export type AnswerResultMessage = { type: "answer_result"; reqId: string; id: string } & AnswerResult;

export interface PongMessage {
	type: "pong";
	reqId: string;
}

export interface ErrorMessage {
	type: "error";
	message: string;
}

export interface GoodbyeMessage {
	type: "goodbye";
	reason: "session_shutdown";
	/** Since 0.2. */
	shutdown?: ShutdownReason;
}

/** Since 0.2. */
export type ActionOutcome = { ok: true } | { ok: false; error: string };
export type ActionResultMessage = { type: "action_result"; reqId: string } & ActionOutcome;

// Chat (since 0.2, only to `chat: true` clients)

export interface ChatModelRef {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	/** Since 0.3. What the model takes in. Always has "text". */
	input: ("text" | "image")[];
}

export interface ChatModel extends ChatModelRef {
	/** Effort levels the model takes. */
	efforts: string[];
}

export interface ChatState {
	leafId: string | null;
	model: ChatModelRef | null;
	effort: string | null;
	/** Levels the current model takes. */
	efforts: string[];
	working: boolean;
	/** Queued messages not yet in the session, oldest first. */
	pending: Array<{ id: string; text: string; mode: "steer" | "followUp" }>;
	usage: { tokens: number | null; window: number; percent: number | null } | null;
	name: string | null;
	/** A pi dialog (parked or not) is open. */
	waitingForUser: { kind: string; title: string | null } | null;
}

export interface ChatCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

export interface ReplyBlock {
	kind: "text" | "thinking";
	text: string;
}

export interface RunningTool {
	callId: string;
	name: string;
	argument?: string;
}

export interface ChatSnapshot {
	state: ChatState;
	models: ChatModel[];
	commands: ChatCommand[];
	reply: { blocks: ReplyBlock[] };
	/** Running now, oldest first. */
	tools: RunningTool[];
}

export type StateMessage = { type: "state" } & ChatState;
export interface ModelsMessage {
	type: "models";
	list: ChatModel[];
}
export interface CommandsMessage {
	type: "commands";
	list: ChatCommand[];
}
/** The whole reply so far; `[]` = none. */
export interface ReplyMessage {
	type: "reply";
	blocks: ReplyBlock[];
}
export interface ToolMessage extends RunningTool {
	type: "tool";
	phase: "start" | "end";
	isError?: boolean;
}
/** The session file changed or the leaf moved: read it. */
export interface EntriesMessage {
	type: "entries";
	leafId: string | null;
	/** An assistant message just finished. */
	replyDone: boolean;
}
export interface NoticeMessage {
	type: "notice";
	level: "info" | "warning" | "error";
	text: string;
}

export type ChatMessage =
	| StateMessage
	| ModelsMessage
	| CommandsMessage
	| ReplyMessage
	| ToolMessage
	| EntriesMessage
	| NoticeMessage;

export type ServerMessage =
	| WelcomeMessage
	| ItemOpenedMessage
	| ItemClosedMessage
	| AnswerResultMessage
	| PongMessage
	| ErrorMessage
	| GoodbyeMessage
	| ActionResultMessage
	| ChatMessage;
