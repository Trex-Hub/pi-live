Hook events recorded from a live pi 1.5.2 (local model, a probe extension that logged every event), used by
`test/chat.test.ts` to replay what a real pi sends.

- `events-<case>.jsonl`: one `{name, t, payload}` per line. Trimmed: no streaming (`message_update`) events,
  no system prompts or provider details, tool and message payloads cut down to the fields a listener reads.
  `probe_loaded` and `session_start_ctx` are the probe's own notes, not pi events.
- Cases: `00-startup`, `b-tools` (two tool calls, one failing), `c-escape` (a reply stopped), `d-steer`
  (a message sent while working), `e-compact` (a compaction), `e0-compact-too-small` (`/compact` refused),
  `f-tree` (`/tree` back to an earlier message, then a new turn), `g-new` (`/new`), `h-model-thinking`
  (model and effort changes), `i-reload` (`/reload`).
- No secrets: prompts, model names and /tmp paths only.
