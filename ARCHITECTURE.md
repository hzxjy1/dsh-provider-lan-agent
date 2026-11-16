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
- `kind: 'refusal'` — unknown tool, unmapped interaction-only tool, or missing
  arguments

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

## Reasoning

The service streams its hidden reasoning as separate `thinking` blocks next to
the visible answer. The stream mapper turns them into DSH `reasoning` blocks
(one reasoning block per service block id), so the GUI can render them in its
collapsible thinking section. `thinkMode` decides whether the request asks for
thinking at all (`auto` follows DSH's reasoning effort, `on` always asks, `off`
never does). Projected history drops reasoning blocks: the service has no
reasoning channel of its own, so sending them back would be invented context.

## Trace

A parked step clears the request deadline; the step that resumes it links its own
abort signal to the parked pump (`linkParkedAbort`), so a silent vendor stream is
still bounded by the resuming step's request timeout.

Each interpreted request carries a `requestId`. A parked loop call emits two
rows with that id — `event: "request"` when it parks and `event: "settled"` when
the answer is known — so "parked and never resumed" is visible without guessing
from timestamps. The bridge answers in the same step and emits `settled` only.
The JSONL writer persists `requestId` and `event`; the panel can join them.

## Interaction and completion

The only interaction tool with a DSH counterpart is the vendor's
`ask_followup_question`. `interpret` maps it to a real DSH `ask_user_question`
call (`{questions:[{id:'vendor-followup', question, options?}]}`); the DSH agent loop executes
it, and the human answer returns in the same turn as a normal tool result, so the
vendor model continues instead of falling back to a plain-text question and ending
the turn. A parked ask gets a nine-minute budget (`ASK_USER_BUDGET_MS`,
540,000 ms — one minute under DSH's 600,000 ms `run_code` program ceiling, which
covers nested waits), so a user who walks away does not become a tool timeout.
In a `ptc` session the call travels inside a generated `run_code` program, whose
envelope now carries `timeoutMs` from the parked call's budget: DSH's program
deadline defaults to 120000ms and covers nested waits, so without it any call
longer than two minutes (question included) was cancelled by the transport.

`enter_plan_mode`, `plan_mode_respond`, `switch_mode`, `todo_list_snapshot` and
`restore_tool` stay refusals — they have no DSH equivalent. The rules channel no
longer tells the model to ask in text, because the DSH toolbox already publishes
`ask_user_question`.

`src/stream.js` reports completion honestly. `task_status: 'completed'` used to
become `finish: stop` unconditionally, and a body EOF with no terminal status
defaulted to `stop` unless a tool call had been seen — so a fake completion looked
like a successful empty turn. The mapper now tracks whether the turn produced
answer text and whether a tool call is pending, and reports three protocol errors
instead: `completed` with no answer text and no tool call in the whole turn,
`completed` right after a tool call with no final answer since that call, and a
body EOF with no terminal status (pending call / no content / connection cut).
Reasoning-only turns count as no answer text by design: nothing was shown to the
user. The GUI now shows an error banner instead of a normal-looking stop.

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
- `toolAuditFile` is normally disabled (empty). This deployment enables it at
  `$DSH_HOME/logs/lanagent-audit.jsonl`, because otherwise the host's stdout — a
  tty here — is the only trace. Path-valued fields (`toolAuditFile`, the CLI's
  `binaryPath`/`homeDir`/`tokenFile`/`cwd`) accept `~` and `$DSH_HOME`
  (`src/configPath.js`), and the CLI fields default to package-relative
  locations, so no row has to spell a machine home. The JSONL carries a
  `request` / `settled` pair per vendor tool request, joined by `requestId`, plus
  one `turn` record per completed vendor turn.

## Tests

- `node --test` — offline suite (protocol, auth, catalog, projection, tool
  translation, dispatch, audit, and contract fixtures).
- `test/contract/` — 20 cases (success/failure/multi-path/fuzzy edit/MCP/
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

## The optional CLI subagent entry

The package exposes a SECOND host entry, `./subagent` (row `subagent-\u0063odechat`),
beside the model route. It registers a `ctx.subagents` provider for the
vendor's CLI and is paired with the shipped `@deepseek-ai/dsh-tool-subagent`
row (row `tool-subagent-\u0063odechat`, `maxDepth: provider-managed`), which
contributes the model-facing tool.

Two properties shape the code:

- **Availability is a watch, not a config check.** The binary is
  operator-supplied, so `src/subagent/watch.js` watches its DIRECTORY
  (`fs.watch`), checks once at mount, and keeps a low-frequency unref'd poll
  as a backstop. The provider is registered and withdrawn as the file appears
  and disappears; withdrawing it unmounts the tool through the tool row's own
  `subagent/provider-removed` listener. A missing file therefore leaves no
  broken tool for any agent to call, and no restart is needed in either
  direction.
- **The two entries share only a tiny status store.** `src/subagent/status.js`
  is deliberately dependency-free: the subagent entry writes
  `{known, present, path}` and the model-route entry serves it over
  `GET /lanagent/cli` for the settings banner. `known` keeps a deployment
  that never mounts the subagent row from rendering a false "missing" banner.

The delegation itself is a one-shot subprocess run
(`src/subagent/runner.js`): isolated `HOME`, seeded JWT, banner stripping,
process-deadline and cancellation classified apart. `config.js` is
dependency-free on purpose so `node --test` works without a module anchor;
only `provider.js`/`runner.js` reach the real `@deepseek-ai/*` seams.
