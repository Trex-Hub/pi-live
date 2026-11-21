# pi-live

A Pi extension that opens a per-session local socket so programs outside pi can see and answer what the session is waiting on, such as an `ask_user` question. The first client is herdr-web.

pi-live owns no UI. Extensions *park* a waiting item on pi's event bus. pi-live shows it to socket clients and passes a client's answer back to the parker. The terminal prompt stays open the whole time, and whichever answer comes first, keyboard or client, wins.

Design and contracts: [docs/architecture.md](docs/architecture.md).

## Security

**With pi-live loaded, any program running as you can see and answer what your pi session is waiting on.**

The socket is a Unix socket under a `0700` directory with mode `0600`, so it's reachable only by your user on that machine. That's the same trust boundary as your terminal and your `~/.pi` config. pi-live never listens on TCP. Remote access is the client's job, and the client must add its own authentication. On Windows a named pipe is used (v1 is tested on macOS and Linux only).

## Install

```bash
pi install npm:@dev8-npm/pi-live
```

Or try it from a checkout without installing:

```bash
PI_LIVE_DIR=/tmp/pi-live-dev pi -e ./pi-live
```

It runs in `tui` and `rpc` modes and does nothing in `print`/`json` mode. If several packages bundle pi-live, only the first loaded copy is active.

## Settings

Env first, then `<agentDir>/pi-live.json` (`agentDir` is `$PI_CODING_AGENT_DIR` or `~/.pi/agent`), re-read on every session start.

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `enabled` | `PI_LIVE_ENABLED` (`0`/`false` = off) | `true` | Off: no socket, and parkers fall back to keyboard only. |
| `dir` | `PI_LIVE_DIR` | `<agentDir>/live` | Socket and sidecar directory. |

```json
{ "enabled": true }
```

## Files

Each session gets `<dir>/<sessionId>.sock` and a sidecar `<dir>/<sessionId>.json` (`sessionId`, `sessionFile`, `cwd`, `pid`, `startedAt`, `socketPath`). If the socket path would exceed 100 bytes, the socket goes to `<tmpdir>/pi-live-<uid>/<hash>.sock`, and the sidecar's `socketPath` points there. Both files are removed on session shutdown or process exit, and leftovers from a crash are removed by the next pi-live start.

## For parkers (bus API)

Emit `pi-live:park` with a `ParkRequest` (see `src/protocol.ts`). If pi-live is listening, it calls `accept(ticket)` synchronously during the emit. If `accept` wasn't called, there's no door, so keep the keyboard-only path. Call `ticket.close(outcome)` exactly once when your wait ends. `answer(answer, from)` must be synchronous and return `{ status: "delivered" }` or `{ status: "invalid", reason }`.

Other channels: `pi-live:ready` and `pi-live:closed` (session socket up/down), and `pi-live:who` (`reply(info)` is called synchronously with `{ protocol, sessionId, socketPath }` when a socket is open).

## For clients (wire protocol)

NDJSON over the socket. Send `{"type":"hello","protocol":1,"client":{"name":"…"}}` first, within 5 seconds. You get a `welcome` with the session and all open items, then `item_opened`/`item_closed` as they happen. Answer with `{"type":"answer","reqId":"r1","id":"<item id>","answer":…}` and you get an `answer_result` (`delivered`, `invalid`, `closed` or `not_found`). Full spec: docs/architecture.md §5. Types: `src/protocol.ts` (no imports, so you can copy it).

## Dev CLI

For manual testing. It uses the same settings, so set `PI_LIVE_DIR` as you did for pi.

```bash
bun bin/pi-live.ts ls                                # sessions: id, alive/dead, pid, cwd
bun bin/pi-live.ts watch [sessionId|path]            # print welcome and every message
bun bin/pi-live.ts answer <sessionId|path> <id> '<json>'  # print answer_result; exit 0 if delivered
```

## Development

```bash
bun install
bun test
bun run typecheck
```

## License

MIT
