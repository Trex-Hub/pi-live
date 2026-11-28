# pi-live protocol reference

This document describes protocol version 1, as spoken by pi-live 0.3: the event-bus API used by extensions inside pi, the socket protocol used by clients outside pi, and the files pi-live writes. TypeScript types for everything here are in [src/protocol.ts](../src/protocol.ts).

pi-live 0.2 added chat and control, and 0.3 added images in `send`, without changing the protocol version. Every addition is a new field or a new message type, marked *since 0.2* or *since 0.3*. **Clients must ignore message types and fields they don't know.** To tell what a pi-live can do, use `welcome.features`, not `version`.

- [Terms](#terms)
- [Event bus API](#event-bus-api)
- [Socket and session files](#socket-and-session-files)
- [Wire protocol](#wire-protocol)
- [Chat](#chat)
- [Actions](#actions)
- [Settings](#settings)
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
	"socketPath": "/home/me/.pi/agent/live/01a1feea-1468-750a-96d6-bf2777e60575.sock",
	"mode": "tui",
	"terminal": "t17",
	"version": "0.3.0"
}
```

`sessionFile` is omitted for sessions that aren't saved (`--no-session`). The file is written atomically with mode `0600`.

*Since 0.2:*

- `mode` is pi's mode, `"tui"` or `"rpc"`.
- `terminal` identifies the terminal pi runs in, so a client can match a session to a window. It's `$PI_LIVE_TERMINAL`, or else `$HC_TERMINAL_ID`, and it's omitted if neither is set.
- `version` is pi-live's package version.

### Lifecycle

- A socket opens at session start and closes at session end. A new session, a resumed session, a fork or a reload closes the old socket and opens a new one, so there is one socket per session. A reload keeps the session id, so the new socket and session file reuse the old paths; the old files are removed before the new ones are written.
- At session end, pi-live closes all items, sends `goodbye` to clients, then removes the socket and session file. It removes them only if they still belong to this process.
- If pi exits without cleaning up, for example after a crash, the next pi-live to start removes the leftover files. A socket counts as stale when it refuses connections, or when its session file's process is no longer running.
- If another running pi already has a socket for the same session id, pi-live leaves it alone, shows a warning and stays off for that session.

## Wire protocol

Messages are JSON objects, one per line, UTF-8, each ending in `\n`. Unknown fields are ignored, so either side can add fields without a new protocol version. Clients must also ignore message types they don't know.

### Client messages

```jsonc
{ "type": "hello", "protocol": 1, "client": { "name": "my-client" }, "chat": true }
{ "type": "answer", "reqId": "r1", "id": "call_1", "answer": { } }
{ "type": "ping", "reqId": "p1" }
{ "type": "action", "reqId": "a1", "op": "send", "text": "hello" }   // since 0.2, see Actions
```

- `hello` must be the first message, sent within 5 seconds of connecting.
- `chat: true` (*since 0.2*, optional) asks for the [chat](#chat) messages. Clients that only care about waits leave it out and aren't sent them.
- `reqId` is any string. It's echoed back in the reply.
- The format of `answer` is defined by the item's parker, identified by `owner` and `kind`.

### Server messages

```jsonc
// Reply to hello: the session and every open item, oldest first
{ "type": "welcome", "protocol": 1,
  "version": "0.3.0",                 // since 0.2: pi-live's package version
  "features": ["chat", "control", "images"],  // since 0.2: "control" and "images" (since 0.3) only when control is on
  "control": true,                    // since 0.2
  "session": { "id": "…", "file": "…", "cwd": "…", "pid": 74194,
               "mode": "tui", "terminal": "t17", "name": "my session" },  // mode, terminal, name since 0.2
  "connId": "c1",
  "items": [],
  "chat": { … } }                     // since 0.2, only for chat clients, see Chat

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
{ "type": "goodbye", "reason": "session_shutdown", "shutdown": "quit" }
```

`session.name` is the session's name, omitted if it has none. `session.terminal` is as in the session file.

`goodbye.shutdown` (*since 0.2*) is why the session ended: `"quit"`, `"reload"`, `"new"`, `"resume"` or `"fork"`. Anything but `quit` means the same pi process is about to open a new socket, so a client can look for it. A crash sends no goodbye; treat a close without one as `quit`.

A client that needs chat and gets a `welcome` without `"chat"` in `features` (or without `features`) is talking to an older pi-live. The same goes for `"images"` and sending images: an older pi-live ignores `content` in `send` and would send nothing.

### Answer statuses

| Status | Meaning |
|---|---|
| `delivered` | The parker accepted the answer and its prompt has ended. |
| `invalid` | The parker rejected the answer. `reason` says why. The item is still open. |
| `closed` | The item has already closed. |
| `not_found` | No open or recently closed item has this id. |

### Ordering

- `welcome` and the messages after it are consistent: no change falls between the list in `welcome` and the first change sent after it.
- The same holds for a chat client's `welcome.chat`: nothing falls between it and the first chat message after it.
- The client whose answer was delivered gets `answer_result` before `item_closed`. Other clients get only `item_closed`.
- A client that reconnects needs no history. The items in `welcome` are the full current state.

### Errors

| Situation | Result |
|---|---|
| Unsupported `protocol` in `hello` | `error "unsupported protocol"`, then the connection closes. |
| Any message before `hello`, or no `hello` within 5 seconds | `error`, then the connection closes. |
| A second `hello`, an unknown `type`, an `answer` whose `id` or `reqId` isn't a string, or an `action` whose `reqId` isn't a string | `error`. The connection stays open. |
| A line that isn't JSON, or is longer than 1 MiB | `error`, then the connection closes. |

## Chat

*Since 0.2.* Sent only to clients whose `hello` had `chat: true`. Together these let a client show the conversation as it happens. pi-live sends no chat history: the session file (`sessionFile`) holds it, and `entries` says when to read it again.

### Snapshot

A chat client's `welcome` carries the whole current picture:

```jsonc
"chat": {
  "state": { … },                                          // as the state message, without "type"
  "models": [ … ],                                         // as models.list
  "commands": [ … ],                                       // as commands.list
  "reply": { "blocks": [ { "kind": "text", "text": "…" } ] },  // the reply streaming now; [] if none
  "tools": [ { "callId": "…", "name": "bash", "argument": "bun test" } ]  // running now, oldest first
}
```

### Messages

```jsonc
{ "type": "state",
  "leafId": "…",                              // the session tree's current leaf, or null
  "model": { "provider": "anthropic", "id": "…", "name": "…", "reasoning": true, "input": ["text", "image"] },  // or null; input since 0.3
  "effort": "high",                           // thinking level, or null
  "efforts": ["off", "minimal", "low", "medium", "high"],  // levels this model takes
  "working": true,                            // the agent is running
  "pending": [ { "id": "p1", "text": "…", "mode": "steer" } ],  // queued messages: "steer" or "followUp"
  "usage": { "tokens": 12000, "window": 200000, "percent": 6 },  // or null; tokens and percent may be null
  "name": "my session",                       // or null
  "waitingForUser": { "kind": "confirm", "title": "…" } }  // a pi dialog is open, or null
{ "type": "models", "list": [ { "provider": "…", "id": "…", "name": "…", "reasoning": true, "input": ["text", "image"], "efforts": ["off", "…"] } ] }
{ "type": "commands", "list": [ { "name": "review", "description": "…", "source": "prompt" } ] }
{ "type": "reply", "blocks": [ { "kind": "thinking", "text": "…" }, { "kind": "text", "text": "…" } ] }
{ "type": "tool", "phase": "start", "callId": "…", "name": "bash", "argument": "bun test" }
{ "type": "tool", "phase": "end", "callId": "…", "name": "bash", "isError": false }
{ "type": "entries", "leafId": "…", "replyDone": true }
{ "type": "notice", "level": "error", "text": "Compaction failed: …" }
```

| Message | Sent |
|---|---|
| `state` | After any change, coalesced to at most one per event-loop turn. Always the whole state. |
| `models` | When the model list changes; checked when a run ends. Scoped models if set, else every available model, at most 2000. |
| `commands` | When the slash command list (extension commands, prompt templates, skills) changes; checked when a run ends. |
| `reply` | While an assistant message streams: the first update at once, then at most one every 50 ms. Always the whole reply so far, with empty blocks left out. |
| `tool` | When a tool starts and ends. `argument` is the main argument (the command, path, query and so on): its first non-empty line, at most 200 characters. |
| `entries` | One event-loop turn after pi writes to the session file: a message ended, the session was compacted, or the tree moved. `replyDone` is true when an assistant reply ended. Always followed by `state`. |
| `notice` | Something the user should see, such as a failed compaction. `level` is `"info"`, `"warning"` or `"error"`. |

- `state.waitingForUser` covers pi's own dialogs (`kind` is `"select"`, `"confirm"`, `"input"`, `"editor"` or `"custom"`; `title` is null if pi gives none). Parked waits are items, not this.
- `state.pending` lists messages typed or sent while the agent works, until pi hands them to the agent. It's cleared when the run ends.
- After `reply` stops for a message, `entries` with `replyDone: true` follows, and the finished message is in the session file.

## Actions

*Since 0.2.* An action asks pi to do something, as if typed in pi's terminal. Actions don't need `chat: true`.

```jsonc
→ { "type": "action", "reqId": "a1", "op": "send", "text": "hello", "deliverAs": "steer" }
← { "type": "action_result", "reqId": "a1", "ok": true }
← { "type": "action_result", "reqId": "a2", "ok": false, "error": "There is nothing to send." }
```

`error` is a sentence an app can show as is.

| `op` | Fields | Does |
|---|---|---|
| `send` | `text` or `content` (*since 0.3*), `deliverAs?` | Sends `text`, or the blocks in `content`, to the agent, with prompt templates and extension commands expanded. Send one of the two, not both. While the agent works, it's delivered as `deliverAs`: `"steer"` (the default) or `"followUp"`. When idle, it starts a run. `ok` means it was handed to pi; pi reports its own errors. |
| `stop` | | Aborts the current run. |
| `set_model` | `model`: `"provider/id"` | Switches the model. |
| `set_effort` | `effort` | Sets the thinking level. It must be one of `state.efforts`. |
| `set_name` | `name` | Names the session. |
| `compact` | `instructions?` | Compacts the session. A failure arrives later as a `notice`. |
| `clear_input` | | Empties pi's input box. Without a terminal UI (RPC mode), it does nothing and still returns `ok`. |

### Sending images

*Since 0.3, only when `welcome.features` has `"images"`.* `send` takes `content`, a list of blocks, instead of `text`:

```jsonc
→ { "type": "action", "reqId": "a3", "op": "send", "content": [
    { "type": "text", "text": "What is in [image 1]?" },
    { "type": "image", "data": "<base64, no data: prefix>", "mimeType": "image/png" } ] }
← { "type": "action_result", "reqId": "a3", "ok": true }
```

- A text block is `{ "type": "text", "text": "…" }`. An image block is `{ "type": "image", "data": "…", "mimeType": "…" }`, with `data` as base64 without a `data:` prefix and `mimeType` one of `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
- Blank text blocks are dropped. Images alone are fine, with no text.
- Check `input` on `state.model` or the `models` entry first: a model whose `input` lacks `"image"` can't read images. `input` only lists `"text"` and `"image"`, and is `["text"]` if the model says nothing usable.
- There is no limit on image size beyond the 1 MiB line limit for the whole message, base64 included (see [Limits](#limits)). A longer line closes the connection.
- **Order:** pi doesn't keep the order of text and images. It joins all text blocks with a newline into one text, and puts all images after it, in the order given. A client that needs to point at an image writes labels such as "[image 1]" into its own text.
- An images-only `send` leaves an empty text block ahead of the images in pi's stored message. Anthropic and OpenAI-style providers drop it.

Refusals:

- Control is off: every action gets `"Control is off for this pi."`. `answer` and `ping` still work.
- `send` whose first word is one of pi's own commands (`/settings /model /thinking /scoped-models /login /logout /llama /new /resume /name /session /tree /fork /clone /compact /import /copy /export /share /bug /trust /mcp /reload /hotkeys /changelog /quit`): "pi-live can't run /new. Use the matching action, or type it in pi's terminal."
- `send` with both `text` and `content`: "Send either text or content, not both." A `content` that is not a list: "content must be a list of blocks." A block that is not text or an image: "pi can't send a “audio” block. Use text or image." A text block without text: "A text block needs text." An image of another type: "pi can't take images of type “image/bmp”. Use image/png, image/jpeg, image/gif or image/webp." An image without base64 `data`: "An image block needs base64 data."
- Empty `send` text or `content` with nothing but blank text, empty `name`, an unknown model, a model with no API key set up, an effort the model doesn't take, an unknown `op`: `ok: false` with a sentence saying so.

## Settings

pi-live reads environment variables first, then its settings files, at every session start.

| Setting | Environment variable | File key | Default |
|---|---|---|---|
| Enabled | `PI_LIVE_ENABLED` (`0`/`false` off) | `enabled` | on |
| Socket directory | `PI_LIVE_DIR` | `dir` | `<agent dir>/live` |
| Control (*since 0.2*) | `PI_LIVE_CONTROL` (`0`/`false`/`off`, `1`/`true`/`on`) | `control` | on |

The settings file is `<agent dir>/pi-live.json`. For control, the first match wins:

1. `PI_LIVE_CONTROL`.
2. The project's `<cwd>/.pi/pi-live.json`, only if pi trusts the project, and only to turn control off (`{ "control": false }`; `true` there is ignored). If the file is invalid, it's ignored with a warning.
3. `control` in `<agent dir>/pi-live.json`.
4. On.

## Limits

| Limit | Value |
|---|---|
| Line length from clients | 1 MiB (a longer line, such as a `send` with more than 1 MiB of text or image data, closes the connection) |
| Line length to clients | None. A `reply` or `welcome` line can be large. |
| Connections per session, including ones that haven't sent `hello` | 32 |
| Time to send `hello` | 5 seconds |
| Buffered output per client before `reply` messages are skipped for it | 1 MiB (*since 0.2*; the next `reply` carries the whole reply, so nothing is lost) |
| Buffered output per client before it's disconnected | 4 MiB |
| Closed ids remembered for `closed` replies | 256 most recent |

There is no idle timeout. Clients may send `ping` to check the connection.
