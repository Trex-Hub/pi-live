# pi-live protocol reference

This document describes protocol version 1: the event-bus API used by extensions inside pi, the socket protocol used by clients outside pi, and the files pi-live writes. TypeScript types for everything here are in [src/protocol.ts](../src/protocol.ts).

- [Terms](#terms)
- [Event bus API](#event-bus-api)
- [Socket and session files](#socket-and-session-files)
- [Wire protocol](#wire-protocol)
- [Limits](#limits)

## Terms

- **Item**: a prompt that a session is waiting on, as clients see it.
- **Parker**: the extension that owns a prompt and offers it to pi-live.
- **Client**: a program connected to a session's socket.

## Event bus API

Extensions talk to pi-live only through `pi.events`. They never import it. pi loads each package with its own module root, so an import could reach a different copy than the one that is running. The event bus is shared by every extension in the process.

`pi.events.emit` calls handlers synchronously and passes the payload by reference. pi-live relies on both: payloads can carry functions, and a parker knows before `emit` returns whether pi-live accepted its item.

### Channels

| Channel | Emitted by | Payload | Meaning |
|---|---|---|---|
| `pi-live:park` | parker | `ParkRequest` | Open an item. |
| `pi-live:ready` | pi-live | `{ protocol, sessionId, socketPath }` | A session's socket is listening. |
| `pi-live:closed` | pi-live | `{ sessionId }` | A session's socket has closed. |
| `pi-live:who` | anyone | `{ reply(info) }` | If a socket is open, pi-live calls `reply` synchronously with the same payload as `pi-live:ready`. Use it when your extension may have loaded after `pi-live:ready` was emitted. |

### `pi-live:park`

```typescript
interface ParkRequest {
	protocol: 1;
	id: string;          // unique among open items in the session
	owner: string;       // who parked it, for example the extension name
	kind: string;        // tells clients how to read `view`; defined by the parker
	title: string;       // one line for lists and notifications
	view: unknown;       // JSON data clients render; pi-live never reads inside it
	expiresAt?: number;  // epoch ms when the parker will give up, if it has a timeout
	answer(answer: unknown, from: ClientInfo): { status: "delivered" } | { status: "invalid"; reason: string };
	accept(ticket: ParkTicket): void;
}

interface ParkTicket {
	close(outcome: CloseOutcome): void;
}

type CloseOutcome = {
	by: "keyboard" | "client" | "timeout" | "abort" | "error" | "shutdown";
	client?: ClientInfo; // only when by is "client"
};

interface ClientInfo {
	connId: string;
	name: string;
}
```

pi-live accepts an item only if all of these are true:

- `protocol` is `1`.
- `id`, `owner`, `kind` and `title` are non-empty strings.
- `view` can be serialized as JSON.
- `answer` and `accept` are functions.
- `expiresAt`, if present, is a finite number.
- No open item has the same `id`.

An accepted item gets `accept(ticket)` during the `emit` call. A rejected item doesn't, and pi-live shows one warning. pi-live stores a JSON copy of `view`, so later changes to the object don't reach clients. An `id` can be parked again after its item closes.

### Answers

When a client answers an open item, pi-live calls `answer(answer, from)`:

- Return `{ status: "invalid", reason }` to reject it. The item stays open, and the client gets the reason.
- Return `{ status: "delivered" }` after ending your prompt with the answer. pi-live replies `delivered` to that client, then closes the item and tells every client it was closed `by: "client"`.
- A throw, or any other return value, is treated as `invalid` with the reason `parker error`.

`answer` must be synchronous. Once your prompt has ended, return `invalid`, so an answer that arrives late can't resolve it twice. pi-live calls `answer` once at a time, so two clients answering together can't both be delivered.

### Closing

Call `ticket.close(outcome)` when your prompt ends, however it ends. Calls after the first are ignored, so it's safe to call it from a `finally` block even when a client already answered. After a delivered answer, pi-live closes the item itself, so `close` may be called during `answer`, later or not at all. An unknown `by` value is reported as `"error"`.

When the session ends, pi-live closes every open item with `by: "shutdown"`.

## Socket and session files

### Location

- Directory: `$PI_LIVE_DIR`, or `<agent dir>/live`, where the agent dir is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. Created with mode `0700`.
- Socket: `<dir>/<session id>.sock`, mode `0600`.
- Unix socket paths are limited to 104 bytes on macOS and 108 on Linux. If the path would be longer than 100 bytes, the socket is created at `<tmpdir>/pi-live-<uid>/<hash>.sock` instead, in a `0700` directory. `<hash>` is the first 16 hex characters of the SHA-256 of the session id.
- Windows: the named pipe `\\.\pipe\pi-live-<session id>`.

### Session file

Each socket has a session file at `<dir>/<session id>.json`, even when the socket itself is in the temporary directory. Clients can list sessions by reading these files, without connecting to each socket.

```json
{
	"protocol": 1,
	"sessionId": "01a1feea-1468-750a-96d6-bf2777e60575",
	"sessionFile": "/home/me/.pi/agent/sessions/…/session.jsonl",
	"cwd": "/home/me/project",
	"pid": 74194,
	"startedAt": "2026-11-21T19:21:08.000Z",
	"socketPath": "/home/me/.pi/agent/live/01a1feea-1468-750a-96d6-bf2777e60575.sock"
}
```

`sessionFile` is omitted for sessions that aren't saved (`--no-session`). The file is written atomically with mode `0600`.

### Lifecycle

- A socket opens at session start and closes at session end. A new session, a resumed session, a fork or a reload closes the old socket and opens a new one, so there is one socket per session.
- At session end, pi-live closes all items, sends `goodbye` to clients, then removes the socket and session file. It removes them only if they still belong to this process.
- If pi exits without cleaning up, for example after a crash, the next pi-live to start removes the leftover files. A socket counts as stale when it refuses connections, or when its session file's process is no longer running.
- If another running pi already has a socket for the same session id, pi-live leaves it alone, shows a warning and stays off for that session.

## Wire protocol

Messages are JSON objects, one per line, UTF-8, each ending in `\n`. Unknown fields are ignored, so either side can add fields without a new protocol version.

### Client messages

```jsonc
{ "type": "hello", "protocol": 1, "client": { "name": "my-client" } }
{ "type": "answer", "reqId": "r1", "id": "call_1", "answer": { } }
{ "type": "ping", "reqId": "p1" }
```

- `hello` must be the first message, sent within 5 seconds of connecting.
- `reqId` is any string. It's echoed back in the reply.
- The format of `answer` is defined by the item's parker, identified by `owner` and `kind`.

### Server messages

```jsonc
// Reply to hello: the session and every open item, oldest first
{ "type": "welcome", "protocol": 1,
  "session": { "id": "…", "file": "…", "cwd": "…", "pid": 74194 },
  "connId": "c1",
  "items": [] }

// Changes, in the order they happen
{ "type": "item_opened", "item": { "id": "call_1", "owner": "…", "kind": "…", "title": "…", "view": { }, "openedAt": 1795278085572, "expiresAt": 1795278145572 } }
{ "type": "item_closed", "id": "call_1", "outcome": { "by": "client", "client": { "connId": "c1", "name": "my-client" } } }

// Replies
{ "type": "answer_result", "reqId": "r1", "id": "call_1", "status": "delivered" }
{ "type": "answer_result", "reqId": "r2", "id": "call_1", "status": "invalid", "reason": "…" }
{ "type": "answer_result", "reqId": "r3", "id": "call_1", "status": "closed" }
{ "type": "answer_result", "reqId": "r4", "id": "nope", "status": "not_found" }
{ "type": "pong", "reqId": "p1" }

// Problems and shutdown
{ "type": "error", "message": "…" }
{ "type": "goodbye", "reason": "session_shutdown" }
```

### Answer statuses

| Status | Meaning |
|---|---|
| `delivered` | The parker accepted the answer and its prompt has ended. |
| `invalid` | The parker rejected the answer. `reason` says why. The item is still open. |
| `closed` | The item has already closed. |
| `not_found` | No open or recently closed item has this id. |

### Ordering

- `welcome` and the messages after it are consistent: no change falls between the list in `welcome` and the first change sent after it.
- The client whose answer was delivered gets `answer_result` before `item_closed`. Other clients get only `item_closed`.
- A client that reconnects needs no history. The items in `welcome` are the full current state.

### Errors

| Situation | Result |
|---|---|
| Unsupported `protocol` in `hello` | `error "unsupported protocol"`, then the connection closes. |
| Any message before `hello`, or no `hello` within 5 seconds | `error`, then the connection closes. |
| A second `hello`, an unknown `type`, or an `answer` whose `id` or `reqId` isn't a string | `error`. The connection stays open. |
| A line that isn't JSON, or is longer than 1 MiB | `error`, then the connection closes. |

## Limits

| Limit | Value |
|---|---|
| Line length | 1 MiB |
| Connections per session, including ones that haven't sent `hello` | 32 |
| Time to send `hello` | 5 seconds |
| Buffered output per client before it's disconnected | 4 MiB |
| Closed ids remembered for `closed` replies | 256 most recent |

There is no idle timeout. Clients may send `ping` to check the connection.
