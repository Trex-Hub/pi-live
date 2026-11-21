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

export interface SessionInfo {
	id: string;
	file?: string;
	cwd: string;
	pid: number;
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
}

// Client → pi-live

export interface HelloMessage {
	type: "hello";
	protocol: number;
	client: { name: string };
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

export type ClientMessage = HelloMessage | AnswerMessage | PingMessage;

// pi-live → client

export interface WelcomeMessage {
	type: "welcome";
	protocol: 1;
	session: SessionInfo;
	connId: string;
	/** Oldest first. */
	items: Item[];
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
}

export type ServerMessage =
	| WelcomeMessage
	| ItemOpenedMessage
	| ItemClosedMessage
	| AnswerResultMessage
	| PongMessage
	| ErrorMessage
	| GoodbyeMessage;
