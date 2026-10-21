# Architecture

`@local/dsh-provider-lan-agent` is a DSH LLM provider route (`lanagent`) for a
LAN agent service. This is not a plain model adapter: the service runs its own
agent server-side and delegates tool calls back to the client over a WebSocket.

## One turn, two channels

```
HTTP  POST /chatbot/v3/task-agent      → answer stream (cumulative snapshots)
WS    /ws-api/coagent/<session-id>     → tool calls, answered by this plugin
```

- The HTTP body carries only `user` / `assistant` messages; the system prompt
  travels through `rules`, skill metadata through `skills`.
- The server agent asks the client to run a tool over the WebSocket and waits for
  the answer. The budget is the tool's own `timeout`, not a fixed 30 seconds.
- The stream is a sequence of cumulative block snapshots, so the decoder
  differences blocks by id instead of appending blindly.

## The vendor-request seam

Every tool request — the eight agent tools, DSH passthrough names, and `mcp__*`
tools — goes through one seam in `src/vendor/registry.js`:

```
raw vendor request
  → interpret   (map paths, resolve vocabulary, plan a DSH call, or refuse)
  → runner      (loop parks the plan; bridge executes it now)
  → render      (one vendor-facing shape, from value or text)
```

`interpret` returns a plain plan value:

- `kind: 'dsh'` — one or more DSH calls with keys and mapped arguments
- `kind: 'local'` — an answer that needs no DSH call (environment preflight)
- `kind: 'refusal'` — unknown tool, interaction-only tool, or missing arguments

Plans hold no functions and no WebSocket responder. The loop route can therefore
keep a plan across two DSH steps; the bridge runner executes it in the same step.
Both runners feed the same `render`.

### Result fidelity

The bridge receives a structured `value` from `ctx.tools.execute()`; the loop
receives the rendered `text` from DSH's tool-result message. A loop call wrapped
in a program also carries a structured value inside the sentinel payload, which
`outcomesForPlan` recovers. The seam normalizes both routes to
`{ text, isError, value? }`; `src/vendor/shape.js` prefers `value`, falling back
to parsing the exact DSH renderings. The contract tests render every fixture
twice and require the same answer.

### Path mapping

The agent names paths from its own CLI's world. `src/paths.js` maps that home
directory into the session workspace (`.lan-agent-memory` by default), respecting
path-segment boundaries. Shell commands get the same rewrite. A relative mapping
target is resolved per session, which keeps writes inside the file sandbox.

## Runners

| Module | Role |
|---|---|
| `src/vendor/registry.js` | vocabulary, planning, local answers, refusals, rendering |
| `src/vendor/shape.js` | value/text normalization and vendor-facing formatters |
| `src/vendor/bridge.js` | out-of-band runner: execute the plan now, answer the WebSocket |
| `src/loopRoute.js` + `index.js` | loop runner: park the plan, resume on the next step |
| `src/dispatch.js` | direct vs `run_code` dispatch inside the DSH tool scope |
| `src/tools.js` | shared formatters, diff parser, local preflight/memory readers |
| `src/memory.js` | local read/write for the mapped memory tree |
| `src/toolbox.js` | publish whitelisted DSH tools as one synthetic MCP server |

`toolExecution: loop` is the default: the call appears as a native tool row and
approvals/sandbox policy stay in DSH. `out-of-band` uses the bridge and answers
immediately.

## Trace

Each interpreted request carries a `requestId`. A parked loop call emits two
rows with that id — `event: "request"` when it parks and `event: "settled"` when
the answer is known — so "parked and never resumed" is visible without guessing
from timestamps. The bridge answers in the same step and emits `settled` only.
The JSONL writer persists `requestId` and `event`; the panel can join them.

## Memory policy

The agent keeps a memory tree under its own CLI's home. Path mapping redirects
that prefix into the session workspace (`.lan-agent-memory`). Requests whose
paths all land inside that tree are answered locally by `src/memory.js`, before
approval and before either runner: missing reads are empty rather than errors,
writes create parents, and no DSH card is drawn. This is an explicit policy, not
a second general-purpose execution path — mixed or outside paths take the normal
route.

## Configuration and credentials

- The row is `llm-lan-agent` in `cordis.patch.yml`; the base URL is the LAN
  address. The service's certificate does not cover the IP, so the LAN origin is
  plain HTTP: run it only on a trusted network.
- Account and password are credential references (`LAN_AGENT_USER`,
  `LAN_AGENT_PASSWORD`), never plaintext in the patch.
- `pathMappings` defaults to the agent CLI's home mapped to
  `.lan-agent-memory` under the session workspace. Override it only when the
  deployment's spelling differs.
- `toolAuditFile` is disabled by default; set it to an absolute JSONL path to
  enable the translation-diagnostics panel.

## Tests

- `node --test` — offline suite (protocol, auth, catalog, projection, tool
  translation, dispatch, audit, and contract fixtures).
- `test/contract/` — 19 real cases (success/failure/multi-path/fuzzy edit/MCP/
  local preflight/refusal) rendered twice, with and without a structured value.
- `scripts/contract/` — maintainer-only fixture collection from local session
  logs; the raw pool is not committed.

## Design constraints

- The service serializes its own tool calls; the client cannot force parallel
  execution.
- A session scope may present only `run_code`; the dispatcher learns that per
  session and wraps calls in a program.
- Tool results are shaped for the service's own model, not for DSH's transcript:
  a wrong shape does not fail loudly, it teaches the model to misread output.
