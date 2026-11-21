# pi-live: architecture

Status: plan, nothing built yet.
Companion doc: [`../../pi-ask-user/docs/architecture.md`](../../pi-ask-user/docs/architecture.md).

## 1. What pi-live is

pi-live is a small pi extension that gives one running pi session a door to the outside: a local socket file. Anything on the same machine, running as the same user, can connect to it, see what the session is waiting on, and answer it.

It's a foundation, not a feature. pi-live doesn't know what a question is. Other extensions, starting with our `ask_user` fork, **park** things on it ("I'm waiting for an answer to this"). pi-live lists them, tells attached clients, takes answers by id, and hands each answer back to whoever parked it. The parking extension decides whether the answer is valid.

```
devserver (or your Mac)
┌───────────────────────────────────────────────────────────────┐
│ pi session (one pi process)                                    │
│                                                                │
│  agent ──calls──▶ ask_user (fork) ⇄ terminal UI (keyboard)    │
│                       │ park / answer / close                  │
│                       ▼   (pi.events, in-process)              │
│                    pi-live ── ~/.pi/agent/live/<id>.sock ◀──┐  │
└────────────────────────────────────────────────────────────┼──┘
                                                             │ NDJSON
                              herdr-web backend / CLI / bridge ┘
                                          ⇅  (Tailscale, relay, ssh)
                                     phone app / browser
```

### Rules we agreed on

1. **The session owns the truth.** The open items live inside the pi process. Clients only look at it and send answers. Nothing is stored in a file that clients poll.
2. **The terminal is just another client.** The keyboard and every socket client race, and the first valid answer wins. The others are told the item closed.
3. **Clients attach and get the current view first, then changes.** A client that joins late, or reconnects, sees what's open right now.
4. **Answer by id, get a clear reply.** Every answer gets exactly one reply: `delivered`, `invalid`, `closed` or `not_found`. This is the same vocabulary as Pi Durable's signals, so we can move to Durable later by renaming, not redesigning.
5. **No network port, ever.** pi-live only opens a Unix socket file that only your user can open. Reaching it from a phone is someone else's job: herdr-web's backend, an `ssh -L` forward, Tailscale, or a relay.
6. **Without pi-live, nothing breaks.** Extensions that park must keep working with keyboard only when pi-live isn't loaded.

### Where the idea comes from

- **Pi Durable** (earendil-works/pi `packages/durable`): one process owns state, clients attach (view then changes), tools *park* and wait for a signal, and signals return `delivered | duplicate | invalid | closed | not_found`. pi-live copies that shape into today's pi (1.5.2), which has no attachable door.
- **Codex app-server**: the server sends `requestUserInput` to every subscribed client, replays pending requests when a client resumes, and broadcasts when one is resolved.
- **Claude Code Remote Control / Happy**: the local process is the source of truth, and remote devices reach it through an outbound connection or a relay, never an open inbound port.

### What pi-live is not

- Not a chat mirror. herdr-web already streams messages, tool calls and status through its own extension and wire protocol. pi-live only carries "things waiting on a human".
- Not a status reporter. "Needs You" comes from pi's own blocked status (OSC 7501), which `ask_user` sets itself. pi-live doesn't touch it.
- Not a network server, an auth system or a relay.

## 2. Pieces

```
pi-live/
├── package.json          # pi.extensions: ["./index.ts"]
├── index.ts              # extension entry: guard, lifecycle, bus wiring
├── src/
│   ├── protocol.ts       # wire + bus types, PROTOCOL_VERSION. No runtime deps; clients import it
│   ├── registry.ts       # open items, recently closed ids, first-answer-wins
│   ├── server.ts         # socket server, NDJSON framing, per-client state
│   ├── paths.ts          # socket dir/path, path-length fallback, stale cleanup
│   └── settings.ts       # env + ~/.pi/agent/pi-live.json
├── bin/pi-live.ts        # tiny dev CLI: ls / watch / answer (manual testing)
├── test/                 # bun test
├── README.md
└── docs/architecture.md  # this file
```

Runtime dependencies: none. Only Node built-ins (`node:net`, `node:fs`, `node:path`, `node:os`, `node:crypto`). `@earendil-works/pi-coding-agent` is a peer/dev dependency for types only, like `pi-ask-user`.

Tooling matches `pi-ask-user`: TypeScript run directly by pi, `bun test`, `tsc --noEmit` for typecheck.

## 3. Inside pi: the park API (event bus)

Extensions talk to pi-live only through `pi.events`. They never import it.

Why the bus: pi loads each installed package with its own module root, so `import "@dev8-npm/pi-live"` from `ask_user` could get a different copy from the one actually running. The bus is shared by every extension in the process, so it always reaches the running one.

pi's bus is a plain Node `EventEmitter` (`dist/core/event-bus.js`). `emit` calls the handlers **synchronously**, in the same tick, and passes the data object by reference. The design relies on both facts:

- Payloads can carry callbacks (functions), because nothing serializes them.
- A parker can find out in the same call whether pi-live is present. If no handler accepted the park by the time `emit` returns, there's no pi-live.

### Channels

| Channel | Direction | Purpose |
|---|---|---|
| `pi-live:park` | parker → pi-live | Open an item. |
| `pi-live:ready` | pi-live → anyone | The socket is listening. Payload `{ protocol, sessionId, socketPath }`. Emitted on start and on every session switch. |
| `pi-live:closed` | pi-live → anyone | The socket closed (session switch or shutdown). Payload `{ sessionId }`. |
| `pi-live:who` | anyone → pi-live | Ask "are you there, where's the socket?" Payload `{ reply(info) }`. pi-live calls `reply` synchronously with the same info as `pi-live:ready`. |

`pi-live:who` exists because extensions load in an order we don't control. herdr-web's extension may subscribe to `pi-live:ready` after it already fired.

### `pi-live:park`

```ts
// src/protocol.ts
export const PROTOCOL_VERSION = 1;

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

export interface ClientInfo { connId: string; name: string }
```

### Flow for a parker

```ts
let ticket: ParkTicket | undefined;
pi.events.emit("pi-live:park", {
  protocol: 1, id, owner: "ask_user", kind: "ask_user.question",
  title: question, view, expiresAt,
  answer: (raw, from) => tryResolveFromOutside(raw, from), // validate + complete()
  accept: (t) => { ticket = t; },
} satisfies ParkRequest);

// emit is synchronous, so we know right now:
if (!ticket) { /* no pi-live: keyboard only, nothing else changes */ }

// ...later, in the prompt's finally block, however it ended:
ticket?.close({ by: "keyboard" });
```

### What pi-live does on `pi-live:park`

1. Check `protocol === 1` and that `id`, `owner`, `kind` and `title` are non-empty strings, and that `view` is JSON-serializable. If not, log once and **don't** call `accept`. The parker falls back to keyboard only.
2. If `id` is already open, don't accept. That's a parker bug; a duplicate must not replace the live entry.
3. Store the item, call `accept(ticket)`, and broadcast `item_opened` to every attached client.

### Answer and close, step by step

When a client sends `answer { id, answer }`:

1. If `id` is in the recently-closed set, reply `closed`. If it's unknown, reply `not_found`.
2. Call `item.answer(answer, client)` inside `try/catch`. A throw counts as `invalid` with reason `"parker error"`. pi-live never crashes on a parker bug.
3. On `invalid`, reply `invalid` with the reason. The item stays open.
4. On `delivered`, the parker has resolved its prompt. It may call `ticket.close` synchronously inside `answer()`, later (ask_user's `finally` runs in a microtask after `complete()`), or never. pi-live handles all three the same way. It replies `answer_result delivered` to that client **first**, then closes the item itself and broadcasts exactly one `item_closed { by: "client", client }`. A `close` that arrives during `answer()` is not broadcast at that moment, and any later `close` is a no-op.

When the parker calls `ticket.close(outcome)` (keyboard, timeout, abort, error): remove the item, add the id to the recently-closed set, and broadcast `item_closed { id, outcome }`.

**First valid answer wins** falls out of this. The parker's own one-shot guard (`customCompleted` in `ask_user`) decides the race. Once the prompt has resolved, `answer()` returns `invalid "not open"`, and pi-live has already moved the id to closed. A second client therefore gets `closed`, and a late keypress is ignored by the parker. Because the bus and the parker's `complete()` are synchronous and Node is single-threaded, there's no window where two answers are both accepted.

## 4. Outside pi: the socket

### Where

- Directory: `<agentDir>/live/`, where `agentDir` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, the same rule `ask-user.json` uses. Created with mode `0700`.
- File: `<agentDir>/live/<sessionId>.sock`, chmod `0600` right after `listen`.
- **Path length.** macOS limits Unix socket paths to 104 bytes, Linux to 108. If the full path would exceed 100 bytes, use `<os.tmpdir()>/pi-live-<uid>/<first 16 hex chars of sha256(sessionId)>.sock` instead, with the directory at `0700`. Either way, `pi-live:ready` and `pi-live:who` report the real path.
- **Windows.** Use the named pipe `\\.\pipe\pi-live-<sessionId>`. `node:net` handles both. There are no file permissions on pipes, so this is documented as "same machine; v1 tested on macOS/Linux only".

A sidecar file `<sessionId>.json` sits next to each socket so a client can list sessions without connecting to each one:

```json
{ "protocol": 1, "sessionId": "…", "sessionFile": "…", "cwd": "…", "pid": 1234, "startedAt": "…", "socketPath": "…" }
```

It's written atomically (temp file, then rename), with `0600`, and removed with the socket.

### Stale sockets

When pi-live starts, it scans `live/` for `*.sock`. For each one, it tries to connect for 200 ms. On `ECONNREFUSED`/`ENOENT`, or if the sidecar's `pid` is no longer alive (`process.kill(pid, 0)` throws `ESRCH`), it unlinks the socket and the sidecar. If its own target path already exists and is stale, it unlinks it before `listen`. If the path is live, which means another pi already holds the same session id (two pis resuming one session), it doesn't steal it. It logs a warning and stays off for this session.

### Lifecycle

pi calls `session_shutdown` for the old session, rebinds extensions, then calls `session_start` for the new one on startup, `/new`, resume, fork and `/reload` (docs/extensions.md). So: **one socket per session**.

- `session_start`: if enabled and this copy won the guard, read `ctx.sessionManager.getSessionId()`, `getSessionFile()` and `getCwd()`, open the socket, write the sidecar, emit `pi-live:ready`.
- `session_shutdown` (any reason): close every open item with `{ by: "shutdown" }`, send `goodbye` to clients, close the server, unlink the socket and sidecar, clear the registry, emit `pi-live:closed`, and release the guard.
- Process exit without shutdown (crash, `kill -9`): files are left behind and cleaned up as stale by the next pi-live start. Clients see the connection drop.

Modes: run when `ctx.mode` is `"tui"` or `"rpc"`. Skip `"print"`/`"json"`: they're one-shot and have no human to wait on.

### Single instance

pi-live may be loaded twice in one process: bundled inside `ask_user` *and* installed directly, or bundled by two packages. Separate module roots mean two separate module instances, so module-level state doesn't help. Use a process-wide key:

```ts
const KEY = Symbol.for("pi-live.host.v1");
const g = globalThis as Record<symbol, unknown>;
if (g[KEY]) return;   // another copy owns the door; this copy registers nothing
g[KEY] = { version: PKG_VERSION };
```

The claim is made in the extension factory, which runs before any event, and released in `session_shutdown` only by the copy that holds it. The losing copy subscribes to nothing, so there's never a second `pi-live:park` handler.

If two copies have different versions, the first loaded wins. That's acceptable because the bus protocol is versioned (`protocol: 1`) and kept backward compatible.

## 5. Wire protocol (v1)

NDJSON: one JSON object per line, UTF-8, `\n`-terminated. Lines are at most 1 MiB. On a longer line, or invalid JSON, send `error` and close the connection. Fields not listed below are ignored, so either side can add fields later without a version bump.

### Client → pi-live

```jsonc
{ "type": "hello", "protocol": 1, "client": { "name": "herdr-web" } }
{ "type": "answer", "reqId": "r1", "id": "call_abc", "answer": { /* parker-defined */ } }
{ "type": "ping", "reqId": "p1" }
```

`hello` must come first. Anything before it gets `error` and a close. `reqId` is any string chosen by the client and echoed back.

### pi-live → client

```jsonc
// after hello: the current view
{ "type": "welcome", "protocol": 1,
  "session": { "id": "…", "file": "…", "cwd": "…", "pid": 1234 },
  "connId": "c7",
  "items": [ /* Item, oldest first */ ] }

// then changes, in order
{ "type": "item_opened", "item": { /* Item */ } }
{ "type": "item_closed", "id": "call_abc", "outcome": { "by": "client", "client": { "connId": "c7", "name": "herdr-web" } } }

// replies
{ "type": "answer_result", "reqId": "r1", "id": "call_abc", "status": "delivered" }
{ "type": "answer_result", "reqId": "r2", "id": "call_abc", "status": "invalid", "reason": "option \"Purple\" not offered" }
{ "type": "answer_result", "reqId": "r3", "id": "call_abc", "status": "closed" }
{ "type": "answer_result", "reqId": "r4", "id": "nope",     "status": "not_found" }
{ "type": "pong", "reqId": "p1" }
{ "type": "error", "message": "…" }
{ "type": "goodbye", "reason": "session_shutdown" }
```

`Item` on the wire is `ParkRequest` without the callbacks, plus `openedAt`:

```ts
export interface Item {
  id: string; owner: string; kind: string; title: string;
  view: unknown; openedAt: number; expiresAt?: number;
}
```

If the protocol version doesn't match, the client gets `error { message: "unsupported protocol" }` and the connection closes. A future v2 server may still accept v1 hellos.

### Ordering guarantees

- `welcome` is built and written in the same tick, so no `item_opened`/`item_closed` can fall between the snapshot and the stream.
- For the client that answered, `answer_result delivered` is written **before** the `item_closed` broadcast. Other clients only get `item_closed`.
- A reconnecting client needs no replay log. `welcome.items` is the full current state, and anything it missed has already closed.

### Recently closed

pi-live keeps the last 256 closed ids per session (in insertion order, oldest dropped), so a late answer gets `closed` rather than `not_found`. That lets a UI say "already answered" instead of "unknown question".

### Backpressure and misbehaving clients

- If `socket.write` returns `false` and more than 4 MiB is buffered for a client, drop that client. It can reconnect and get a fresh `welcome`.
- At most 32 concurrent clients. Extra connections get `error` and are closed.
- No idle timeout. Clients may `ping`.

## 6. Settings

Read the same way `ask_user` reads its settings: env first, then `<agentDir>/pi-live.json`, re-read on each `session_start`.

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `enabled` | `PI_LIVE_ENABLED` (`0`/`false` = off) | `true` | Off means: claim the guard (so a second copy also stays quiet), but don't subscribe to `pi-live:park` and don't open a socket. Parkers fall back to keyboard only. |
| `dir` | `PI_LIVE_DIR` | `<agentDir>/live` | Socket and sidecar directory. Mostly for tests. |

Nothing else. No auth, ports or allowlists: the socket file permission *is* the access control.

## 7. Security

- **Who can answer:** any process running as your user on that machine. That's the same trust boundary as your terminal, your `~/.pi` config and your API keys. The README states it plainly: *"With pi-live loaded, any program running as you can see and answer what your pi session is waiting on."*
- **What leaks:** `view` contains whatever the parker puts in, which for `ask_user` is the question, the context and the options. It goes only to socket clients, never onto the network. Unlike `ask_user`'s `emitFullEvents` (issue #51), which broadcasts to every *extension*, this needs no opt-in. Clients need the full question to render it, and the socket is user-only.
- **Remote access** is the client's problem and must add its own authentication (herdr-web's login, Tailscale identity, ssh keys). pi-live never listens on TCP.
- **Robustness:** every socket handler runs inside `try/catch`, and errors are logged, never thrown into pi. A bad client can only get itself disconnected.

## 8. Packaging and distribution

- Published as its own npm package, `@dev8-npm/pi-live` (npm user scope), with `"keywords": ["pi-package"]`, `"pi": { "extensions": ["./index.ts"] }` and `"publishConfig": { "access": "public" }` (scoped packages publish private by default). People can install it alone: `pi install npm:@dev8-npm/pi-live`. The scope can move to an npm org later; the bus channels and socket paths don't depend on the npm name.
- `ask_user` (our fork) ships it as a bundled dependency, so installing `ask_user` gets the door too. See the companion doc §6. pi's `docs/packages.md` says: *"Other Pi packages used as dependencies must be included in the published tarball"*, and the dependent package must list the extension path in its own `pi.extensions`.
- The single-instance guard (§4) is what makes "bundled in several packages *and* installed directly" safe.
- `src/protocol.ts` has no imports, so clients (herdr-web, the CLI, a phone bridge) can import or copy it for types. herdr-web should pin a copy and test against it, the same way it holds `packages/agents/src/wire.ts` to the extension with `test/wire.test.ts`.

## 9. Dev CLI (`bin/pi-live.ts`)

For manual testing only, and not required by anything else. Run with `bun bin/pi-live.ts <cmd>`:

- `ls`: read the sidecars in the live dir and print session id, cwd, pid and whether it's alive.
- `watch [sessionId|path]`: connect, print `welcome` and every following message.
- `answer <sessionId|path> <id> '<json>'`: send one answer and print the `answer_result`.

## 10. Clients

### herdr-web (first client)

- **Finding the socket:** herdr-web's own pi extension (`packages/pi-extension/src/index.ts`) runs in the same pi. It asks `pi-live:who` on `session_start`, listens for `pi-live:ready`/`pi-live:closed`, and adds `liveSocket` to the `hello`/`state` it already sends over the agents socket. Fallback: scan `<agentDir>/live/*.json` and match by `pid`.
- **Backend:** connects to that path, keeps a `Map<id, Item>` from `welcome` plus changes, and pushes it to browsers over its existing stream. Answers from the browser go to `answer`, and `answer_result` goes back to the browser.
- **Rendering:** herdr-web only needs to understand the `ask_user.question` and `ask_user.batch` views (see the companion doc §5). Unknown `kind`s show their `title` with "answer in terminal".
- **"Needs You":** keeps coming from herdr-core's OSC 7501 parsing, which `ask_user` now triggers. pi-live items can add *what* is needed, but they don't decide *whether*.

### Phone app (later)

The phone never touches the socket. It talks to herdr-web's backend (or a small bridge) over Tailscale or a relay. The backend multiplexes many sessions' sockets into one authenticated stream. pi-live doesn't change for this.

## 11. Tests (bun test)

Unit tests use a fake bus (`EventEmitter` wrapped to the `EventBus` shape) and real sockets in a temp `PI_LIVE_DIR`.

- **Guard:** two factories in one process → only one subscribes to `pi-live:park`. Release on shutdown lets a new session claim it again.
- **Park:** valid park → `accept` called synchronously, `item_opened` broadcast. Bad protocol, bad fields, duplicate id or `enabled: false` → no `accept`.
- **Snapshot then changes:** a client attaching after two parks gets both in `welcome`, then later changes in order.
- **Answer outcomes:** `delivered` (parker resolves, `item_closed` follows the result), `invalid` (item stays open), a throwing `answer` → `invalid`, unknown id → `not_found`, closed id → `closed`.
- **Race:** two clients answer the same id in one tick → one `delivered`, one `closed`. Keyboard close then client answer → `closed`.
- **Close outcomes:** keyboard, timeout, abort and shutdown each broadcast `item_closed` with the right `by`, and `close` is idempotent.
- **Lifecycle:** `session_shutdown` closes items, sends `goodbye`, and removes the socket and sidecar. A new `session_start` makes a new socket.
- **Files:** socket `0600`, dir `0700`, long paths fall back to tmpdir, a stale socket (no listener / dead pid) is removed, and a live one is not stolen.
- **Wire robustness:** message before `hello`, invalid JSON, a line over 1 MiB, a wrong protocol and the 33rd client are each rejected without affecting other clients.
- **`pi-live:who`** replies synchronously with the current socket path.

## 12. Manual check

Never install into `~/.pi` and never touch the existing setup. Load from paths:

```bash
cd /Users/dev/Desktop/devendras-work/pi-extension
PI_LIVE_DIR=/tmp/pi-live-dev pi -e ./pi-live -e ./pi-ask-user
# second terminal
bun pi-live/bin/pi-live.ts ls   # with PI_LIVE_DIR=/tmp/pi-live-dev
bun pi-live/bin/pi-live.ts watch <sessionId>
```

Ask the agent to use `ask_user`. Then confirm:

1. `watch` shows `item_opened`.
2. Answering with `answer` closes the terminal prompt and shows the normal result (e.g. "✓ Green"), and the agent continues with it.
3. A keyboard answer gives `item_closed { by: "keyboard" }`, and a later CLI answer gets `closed`.
4. An invalid answer gets `invalid` and the prompt stays open.
5. With `PI_LIVE_ENABLED=0`, there's no socket and `ask_user` behaves exactly as before.
6. `/new` moves to a new socket, and quitting removes the files.

## 13. Build order

1. `protocol.ts`, `registry.ts` and their unit tests (no sockets).
2. `paths.ts` and `server.ts` with socket tests.
3. `index.ts`: guard, lifecycle, settings and bus wiring.
4. Dev CLI.
5. Integrate with the `ask_user` fork (companion doc), then the manual check.
6. herdr-web client.

## 14. Open questions

- **Name.** Published as `@dev8-npm/pi-live`; "pi-live" stays the name in bus channels (`pi-live:*`), paths and env vars. May move to an npm org scope later.
- **Other parkers.** Permission prompts (`kind: "permission"`) and plan approval (plannotator) could park the same way. Not in v1, but nothing in the API is question-specific.
- **Durable.** If Pi Durable becomes the main runtime, replace pi-live with Durable's own client attach and signals. The `ask_user` side maps `answer()` to a Durable signal handler.
- **Showing who answered.** Should the terminal show "answered from herdr-web"? v1 says no: the result is identical to a keyboard answer (companion doc §4). Revisit after use.
