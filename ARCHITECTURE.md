# Architecture

`@local/dsh-provider-lan-agent` is a DSH LLM provider route (`lanagent`) for a
LAN agent service. This is not a plain model adapter: the service runs its own
agent server-side and delegates tool calls back to the client over a WebSocket.

The first half is how the adapter works; the second half is the operating
reference — deployment values, credentials, tool vocabulary, budgets, install,
troubleshooting, limitations, packaging, and the optional CLI delegation.

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
- The plugin's own settings section is the account surface. `GET
  /lanagent/auth` reports presence, source, writability, and whether a JWT is
  live (never the values); `POST /lanagent/auth/login` logs in FIRST and writes
  the refs only after the vendor accepts them, so a typo cannot displace a
  working pair; `POST /lanagent/auth/logout` drops the memory-only JWT. The
  writes are same-origin only, and an empty login submission means "reuse the
  stored pair" (the post-restart case). When either half is missing the settings
  page forces the account/password inputs open.
- The credential store can be edited while the page is open (the Models page
  writes the same refs). A stale "missing account/password" note is therefore
  cleared as soon as that half resolves; a rejected login stays visible.
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

The package exposes a SECOND host entry, `./subagent` (row `subagent-vendor-cli`),
beside the model route. It registers a `ctx.subagents` provider for the
vendor's CLI and is paired with the shipped `@deepseek-ai/dsh-tool-subagent`
row (row `tool-subagent-vendor-cli`, `maxDepth: provider-managed`), which
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

## Operating reference

Deployment and operations material: what an operator sets, what to expect at run
time, and where it goes wrong. The protocol, the seam, and the module layout are
above.

### Deployment values

The package ships no vendor domain, staff account, or token path: those name one
deployment. The row may set them; otherwise they resolve at run time
(`src/deployment.js`) in this order:

1. the row's own value;
2. the environment — `LAN_AGENT_BASE_URL`, `LAN_AGENT_SERVER_URL`,
   `LAN_AGENT_USERNAME`, `LAN_AGENT_TOKEN_FILE`;
3. `$DSH_HOME/lan-agent.deployment.json` (mode 600, never committed):

```json
{ "baseURL": "<optional: another segment's origin>",
  "serverUrl": "<optional: CLI origin>", "username": "<optional: CLI account>" }
```

A missing value does not block mounting: the settings surface still renders. A
request with no origin fails with `no origin configured`; a CLI run with no
`username` leaves the CLI's own login state alone instead of overwriting it
with blanks.

Both origins default in source to the LAN address `http://10.219.9.56`. The
vendor's host name resolves to the same machine, so the name never appears in
the package.

### Behaviour switches

| Field | Default | Effect |
|---|---|---|
| `auth.mode` | `login` | `login` exchanges the credential pair for a JWT; `token` reads an existing JWT and never logs in |
| `toolBridge` | `dsh` | `dsh` sends the vendor's calls through `ctx.tools.execute()`; `refuse` answers every call with an error — useful for separating protocol faults from execution faults |
| `toolDispatch` | `auto` | `auto` chooses direct dispatch or a generated `run_code` program per session; pin `direct` / `run_code` when debugging |

### Vendor tool vocabulary

| Vendor tool | DSH tool | Notes |
|---|---|---|
| `get_environment_info` | local | called every turn; local answer, read-only git metadata, no approval |
| `execute_command` | `bash` | adds the required `description`; `.` becomes the session cwd |
| `read_files` | `read` | prefers structured `value.lines`; text-only loop results are parsed by line number |
| `list_files` | `glob` | `recursive` becomes `**/*`; absolute paths are made workspace-relative |
| `search_files` | `grep` / `glob` | dispatched by `claude_name` (Grep / Glob / legacy) |
| `write_to_file` | `write` | |
| `replace_in_file` | `edit` | the plan parses the vendor's whitespace-tolerant diff and sends exact edits only |
| `use_mcp_tool` | `mcp__<server>__<tool>` | |
| `ask_followup_question` | `ask_user_question` | real DSH question; the answer returns as a tool result in the same turn |

Result text keeps the shape the vendor's model expects: `list_files` answers a
JSON array of paths, writes answer the literal `success`, `read_files` answers
`{path: content}`, `execute_command` answers `{success, output, error}`.

### Timeouts and budgets

| Field | Default | Meaning |
|---|---|---|
| `toolExecution` | `loop` | `loop` runs the call through the DSH agent loop (native card, approvals, transcript, audit); `out-of-band` lets the bridge execute and answer immediately, invisible in the conversation |
| `loopCallStyle` | `auto` | `native` hands the real tool name to the loop, `run_code` hands a generated program, `auto` learns per session (a PTC preset only allows `run_code`) |
| `loopBudgetMs` | 360000 | cap for a parked loop call; the vendor's declared timeout is honoured under it, and it is the fallback when none is declared. Above the vendor's measured ~333 s shutdown, so our budget never preempts its 300000 ms |
| `approvalTimeoutMs` | 120000 | how long an approval (policy `ask`) may wait before the vendor is told the command was not approved |
| `toolTimeoutMs` | 20000 | soft deadline for a tool actually running on the out-of-band route; approval waiting no longer uses it |
| `requestTimeoutMs` | 600000 | hard deadline for one turn; the vendor has 282–312 s silent gaps |
| `toolAuditFile` | `$DSH_HOME/logs/lanagent-audit.jsonl` | empty disables it; the shipped row enables it (absolute path, because the host's cwd is not stable) |

A failed call is reported as a failure — a refused or errored write is never
reported as `success`. A call is retried in the other style at most once.

### MCP toolbox and the skill channel

`mcpToolbox: enabled` declares DSH's tools to the vendor as one synthetic MCP
server, so `use_mcp_tool` can reach serial ports, remote `claw`, subagents,
planning, and desktop automation.

- `mcpToolboxMcpAuto: true` discovers every loaded MCP server each turn and
  declares it under its real name (`mcp__<server>__<tool>`); a newly installed
  server needs no whitelist edit. Explicit `mcp__…` entries still work and dedupe.
- `mcpToolWhitelist` therefore names only the non-MCP tools
  (`ask_user_question`, `skill`, `web_*`, `subagent`…).
- Every schema is sent on every request: the full `mcp__*` set measured 64
  schemas ≈ 11.8K tokens, the current mix 48. `mcpToolboxMaxTools` (100) is a
  hard cap and drops from the TAIL of the list, so auto-discovered entries go
  first and one extra tool can silently drop a whole server. `mcpToolboxMcpDeny`
  cuts a server by prefix.
- The vendor's own `Skill` tool works through a `skills` channel in the request
  (`{name, description, filePath, whenToUse}`); the server resolves the name and
  asks the client for `read_files(path)`. An empty channel makes it answer
  `skill path is None`. The toolbox's `skill` entry is the better route: it also
  returns `resourceBase`, which resolves relative paths inside a skill.

### Credentials

Three ways to write the pair, all landing on the same refs:

```yaml
# 1. credential store (~/.dsh/.credentials.yaml, mode 600)
refs:
  LAN_AGENT_USER: <account>
  LAN_AGENT_PASSWORD: <password>
```
```sh
# 2. environment (the seam's first layer)
export LAN_AGENT_USER='<account>'
export LAN_AGENT_PASSWORD='<password>'
```

3. The Models page, whose `userRef` / `passwordRef` carry
   `role: credential-ref`, or the plugin's own settings section.

Older reference names are no longer read, so copy the pair across when upgrading. The credential
ref wins over the row's plain `user` field; if both exist and disagree the
plugin warns instead of silently using the wrong account. Resolution re-reads on
every operation, so a new value applies to the next request without a restart.

Failed logins back off exponentially (30 s → 30 min, six attempts per hour).
The vendor's wrong-password behaviour has never been measured — the concern is
an SSO lockout — so a failure must not become a retry storm.

Names only, no values:

```sh
grep -o '^  LAN_AGENT_[A-Z_]*' ~/.dsh/.credentials.yaml
```

### Install

The package is installed from a local path (a symlink under the profile's
`node_modules/@local`), never from a public registry:

```sh
pnpm test     # offline suite
```

A link install does not resolve `peerDependencies`, which is why the model
route imports no `@deepseek-ai/*` at the top level: the adapter is structural
(it does not extend `LlmAdapter`), and schemastery is loaded lazily (bare
import first, then a walk up from `process.argv[1]`). Without schemastery the
plugin still loads; the settings surface just cannot list its fields.

The `./subagent` entry is the one exception: it imports
`@deepseek-ai/dsh-subagent` and `@deepseek-ai/dsh-subprocess` directly (as the
upstream CLI-wrapping provider does). Under a profile install dsh's own anchor
resolves them; the offline suite never imports them; running
`scripts/subagent-harness.mjs` directly needs `test/make-anchor.sh` first.

`Config.listConfigs` should report `status: schema` for the row. If the package
is already in the profile manifest, `install_bundle` fails with
`ambiguous-install` (the `pnpm add` is a no-op): run `remove_bundle` first, then
`install_bundle <absolute dir>`.

### Troubleshooting

- `MISSING_CREDENTIAL` carries a parenthetical: `credentials service is not
  reachable from this plugin` means the plugin cannot see the seam at all;
  `reachable, but that reference resolves to nothing` means the ref exists but
  has no value. The fixes are different.
- Code changes do not hot-load: re-enable the plugin or restart dsh. A field you
  just added showing up in `Config.listConfigs` is the proof it loaded.
- The audit file is capped at ~256 KiB and truncated in place (with a
  `truncated` record); refused requests are recorded too, because nothing else
  sees them. The settings diagnostics panel reads the same file.
- The plugin's own `logger` output still goes to the host's stdout. Redirect it
  at start if you need it on disk:

```sh
dsh web >> ~/.dsh/logs/host.log 2>&1
```

### Known limitations

- Tool calls do not enter DSH's model-visible transcript by default
  (`ctx.tools.execute()` does not write `tool/call` — that is the agent loop's
  job). In a PTC session they do appear as `run_code` sub-dispatches
  (`tool/ptc-dispatch-start`).
- The vendor's SEARCH/REPLACE matching is fuzzy (exact → per-line trim → first
  occurrence); DSH's `edit` is literal. The bridge retries the common
  trailing-newline near miss and otherwise returns the vendor's own "make the
  SEARCH block match the file exactly" message to the model.
- Every turn carries ~15.8K tokens of vendor system prompt, independent of the
  turn's content.
- Text only: the request body has no image field, and v1 announces
  `inputModalities: ['text']`.
- Context 204800, output 16384 (measured from the vendor's 25 model definitions).
- `token_usage.used_tokens` is the vendor agent's own session counter for a
  `chatId`, not this request's prompt. The plugin reports it through
  `onTokenUsage` for observation only and uses the host's local
  `tokenMeter.measure()` for the context gauge; without a reachable tokenMeter
  it reports no usage at all.
- The target is private and moving: the `action` literal,
  `config.agent_behavior_mode`, and the eight tool names were reverse-engineered.

### Optional CLI delegation

A second host entry (`./subagent`, row `subagent-vendor-cli`) plus the shipped
`@deepseek-ai/dsh-tool-subagent` row (`tool-subagent-vendor-cli`) turn the
operator-supplied CLI into a one-shot subagent. The runtime contract names are
assembled in `src/vendorName.js` and kept stable; the shipped YAML states the
vendor spelling only as escapes.

Delegation is asynchronous from both callers: DSH agents get
`started subagent <id>` and the answer arrives as a settlement notice on the
next turn, and the vendor's model gets the same contract through the toolbox.

The CLI is not downloaded and its source is not documented. Put the binary at
`binaryPath` (default `<package>/bin/<cli>`), with `homeDir` (default
`<package>/home`) as its isolated HOME.

Row fields: `binaryPath`, `homeDir`, `model` (mandatory — without
`--model` the backend never produces an answer), `mode`,
`fullDelegation` / `permissionMode`, `allowedTools`, `maxBudgetUsd`,
`timeoutMs`, `graceMs`, `cwd`, `tokenFile`, `credentialsRef`.
Credential priority: `credentialsRef` (DSH store) → `tokenFile`.

The harness exercises the real subprocess path:

```sh
test/make-anchor.sh
LAN_AGENT_TOKEN_FILE=<path to a JWT file> node scripts/subagent-harness.mjs
```
