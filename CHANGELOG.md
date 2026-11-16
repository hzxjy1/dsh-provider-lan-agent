# Changelog

## 1.6.0 — 2026-11-16

### Added

- **The LAN Agent settings page now takes the account and password directly.**
  The section (设置 → LAN Agent) starts with an account card: when either
  credential is missing it forces the account/password inputs open, so a fresh
  deployment no longer has to know about the Models page or edit
  `.credentials.yaml` by hand. “保存并登录” logs in to the vendor FIRST and
  writes `LAN_AGENT_USER` / `LAN_AGENT_PASSWORD` only after the login succeeds,
  so a typo can never displace a working pair. When both are configured the card
  shows “凭据已配置”, whether a JWT is live, and sign-in / change / sign-out
  controls; the copy stays compact (no description, refs line, or footer note).
- **Three same-origin account routes**: `GET /lanagent/auth` (presence and
  writability, never values), `POST /lanagent/auth/login` (form submission, or
  an empty body to re-login with the stored pair after a restart), and
  `POST /lanagent/auth/logout` (drops the memory JWT; stored credentials stay).
  The write routes refuse cross-origin requests and non-JSON bodies, and the
  JSON body is bounded.
- `LanAgentAuth.login()` accepts a supplied account/password without reading the
  store first. A manual attempt skips the automatic backoff window — a human
  correcting a password is not a retry storm — while the per-hour lockout cap
  still applies. `LanAgentAuth.status()` reports configured/source/writable/
  live-JWT facts without exposing either value, and clears a stale
  “missing credential” note as soon as that half appears.

### Fixed

- The login/logout response no longer overwrites the auth `mode` with the action
  name (`form` / `stored` / `logout`). The client keys “更换账号密码” on
  `mode === 'login'`, so after signing out that button silently did nothing.
  The action now travels in a separate `source` field, and a regression test
  asserts `mode` stays `login` for every action.

### Tests

- `node --test`: 283/283, including the new `test/authSettings.test.mjs`
  (route-layer persistence order, stored re-login, token mode, same-origin
  refusal, bounded body reader, and status/login unit coverage).

## 1.5.0 — 2026-11-13

### Added

- **The vendor CLI subagent capability now lives in this package** (merged from
  the former standalone `@local/dsh-subagent-\u0063odechat`, landed as
  `src/subagent/*` plus the `./subagent` entry). The package therefore ships
  two host entries — the `lanagent` LLM route and the optional CLI
  delegation — each with its own `inject` graph, so a missing CLI can never
  take the model route down.
- **The vendor model can delegate to that CLI (B1)**: the delegation tool is
  published in the toolbox whitelist and in the passthrough names, and
  `buildRules` explains its ASYNC contract (the call answers
  `started subagent <id>`; the result arrives as a settlement notice on the
  NEXT turn). Measured end-to-end on the live instance: the vendor model called
  it, the CLI ran, the notice reached the parent session, and the model relayed
  the answer.
- **Availability is dynamic**: `fs.watch` on the binary's DIRECTORY (plus a
  mount-time check and a 15s backstop poll) registers and withdraws the
  provider as the operator installs or removes the file. No restart is needed
  in either direction, and a missing file leaves no broken tool behind.
- **A settings banner** (`settings.general.item`, yellow) names the expected
  `binaryPath` while the CLI is missing; `GET /lanagent/cli` serves its state.

### Changed

- A missing CLI binary is no longer a load-time failure (the old provider threw
  `binaryPath is not an executable file`): the row must mount in order to
  watch and report. Genuine deployment faults still fail at activation.
- Removed the dead `enableRunInBackground` row key: 0.2.1-rc.2's
  `@deepseek-ai/dsh-tool-subagent` has no such config field.
- The vendor's product name no longer appears as a literal in this package's
  code: `src/vendorName.js` assembles every occurrence, and a guard test fails
  the suite if a literal creeps back in. Runtime values are unchanged, so
  credentials, profiles, and running sessions keep working.

### Notes

- The CLI binary is **operator-supplied**. This package never downloads it and
  documents no source; put the file at the row's `binaryPath` (default
  `<package>/bin/<cli>`) and the banner clears itself.
- `bin/` and `home/` are gitignored: they are deployment state, not source.

## 1.4.2 — 2026-11-11

### Fixed

- A continuable child could not hand its result back to its parent. DSH's child
  guidance says `send_message({agent_id})`, but on this route that name is the
  vendor's OWN `SendMessage`, which addresses vendor *tasks*: the vendor runs it
  itself, answers `Task <agent-id> not found`, and the bridge never sees the
  call — so the child reported "向父会话 send_message 失败" and gave up
  (measured on children 45ece381 / 5192771e and probe ba9f5027). Three changes
  make the return channel real:
  - `send_message` is published in the DSH toolbox (row `mcpToolWhitelist` and
    `DEFAULT_WHITELIST`), so
    `use_mcp_tool(server_name="dsh_toolbox", tool_name="send_message", …)`
    reaches DSH over the bridge. The vendor's model does have `use_mcp_tool`
    even though it does not list it in its own tool recap.
  - `send_message`, `interrupt_agent` and `list_agents` are passthrough
    names, so a bare DSH spelling is routed instead of refused with
    "该名字既不是厂商内置工具".
  - `buildRules` appends a delivery note whenever the DSH prompt carries "Your
    parent agent id is …": it names the working route, says the vendor
    `SendMessage` returns `Task … not found`, and says that ending the turn
    with the full result also delivers (the settlement notice).

  Verified end-to-end on a second Web instance: the child's
  `use_mcp_tool → send_message` returned a messageId and the parent's session
  received "Agent <child-id> sent a message".

## 1.4.1 — 2026-11-10

### Fixed

- Client version gate: the vendor now rejects the request body built from CLI
  v1.0.12 — the stream answered one text block "请将vendor CLI更新到最新版本（至少为1.0.16）"
  and never reached a terminal task status, which surfaced as
  "the vendor stream ended without a terminal task status" and, intermittently,
  "task-agent answered HTTP 500". `CLIENT_VERSION` is bumped to `1.0.16`
  (measured: identical stream shape — block snapshots, `task_status`,
  `token_quota`, `thinking` — and `think` still accepts `yes`/`no`).
- The catalog endpoints joined the authenticated surface: a bare
  `GET /chatbot/v3/model_groups` now answers code `-106` "token不存在，请登录"
  under HTTP 200, so the catalog silently fell back to the static list forever.
  The catalog now fetches through an authenticated wrapper that resolves a JWT
  via the same `LanAgentAuth` the turns use; auth failures still degrade to the
  static fallback.

## 1.4.0 — 2026-10-30

### Added

- `approvalTimeoutMs` (default 120000): waiting for a human approval is now a
  separate budget from the per-tool timeout. Before, an approval that took more
  than `toolTimeoutMs` (20000) was reported to the vendor as a bogus "tool
  timeout", so an honest slow decision failed the very tool it was approving. The
  new budget bounds only the approval request, when policy is `ask` and the
  vendor call carries `requires_approval`.
- `toolAuditFile` is enabled in the shipped row at
  `$DSH_HOME/logs/lanagent-audit.jsonl`. With it empty — the plugin
  default — the JSONL writer is never created (`src/audit.js` no-ops) and every
  `logger.warn('lanagent: …')` goes to the host's stdout, which is a tty in this
  deployment, so nothing reached disk and the last investigation had to
  reverse-engineer the session JSONL instead. The writer records every vendor
  tool request as `request` / `settled` rows joined by `requestId`, plus one
  `turn` record per completed vendor turn (finish kind, answer-text and tool-call
  counts, duration), so fake completions are visible in the same file. The
  settings diagnostics panel reads that file (`AUDIT_ROUTE`). The directory must
  exist and be writable; the file is capped (~256 KiB) and truncated in place.
- The vendor's `ask_followup_question` (`{question, options?}`) is translated
  into a real DSH `ask_user_question` call
  (`{questions:[{id:'vendor-followup', question, options?}]}`) instead of being refused. The
  DSH agent loop executes it, the human answer comes back in the SAME turn as a
  normal tool result, and the vendor model continues working. A parked ask gets a
  long budget (`ASK_USER_BUDGET_MS`, 540,000 ms = 9 min, one minute under DSH's
  600,000 ms `run_code` program ceiling), so a user who walks away does not turn
  into a tool timeout.

### Changed

- `loopBudgetMs` 240000 → 360000. The row is a cap for a loop-routed parked call
  (the vendor's own declared timeout is honoured up to it) and the fallback when
  the vendor declares none. At 240000 our cap preempted the vendor's declared
  300000ms through the `Math.min(declared, cap)` clamp, while the vendor's
  measured ceiling is ~333s. 360000 exceeds that ceiling, so our budget never
  preempts the vendor's own deadline.
- `requestTimeoutMs` 300000 → 600000. The vendor has a measured cluster of
  282–312s silent waits, and our 300s deadline cut them into "the turn exceeded
  the 300s request timeout" errors (12 of 140 lan-agent turns ended in error,
  8.6%). 600s lets the vendor finish on its own schedule.
- `toolTimeoutMs` stays 20000, but its meaning is narrower now: it bounds a tool
  that is actually RUNNING on the out-of-band (bridge) route. Approval waiting no
  longer uses it.
- The remaining interaction tools — `enter_plan_mode`, `plan_mode_respond`,
  `switch_mode`, `todo_list_snapshot`, `restore_tool` — stay refused: they have no
  DSH counterpart. The rules channel (`src/request.js`) no longer tells the model
  to ask in text; the DSH toolbox already publishes `ask_user_question`.

### Fixed

- Loop-routed calls in a PTC session no longer die at DSH's default program
  deadline. A `ptc` session runs the call inside a generated `run_code` program,
  and that program's wall clock — 120000ms by default, capped at 600000ms, and
  covering nested tool and approval waits — used to expire long before the parked
  budget did. Measured in the affected session: a command budgeted for 300s ended
  as `code run failed (timeout): execution deadline reached (120000ms)`. The
  program envelope now carries `timeoutMs` from the parked call's own budget
  (clamped to DSH's 600000ms ceiling), on the loop route and on the out-of-band
  bridge route alike.
- "Fake completion" no longer masquerades as a normal stop. `src/stream.js` used
  to translate the vendor's `task_status: 'completed'` unconditionally into
  `finish: stop`, and a body EOF with no terminal status defaulted to `stop`
  unless a tool call had been seen. The mapper now tracks whether the turn
  produced answer text and whether a tool call is pending, and reports three
  protocol errors instead: `completed` with no answer text and no tool call in
  the whole turn; `completed` right after a tool call with no final answer text
  since that call; and body EOF with no terminal task status, always a protocol
  error (pending tool call / no content / connection cut) instead of a silent
  `stop`. Reasoning/thinking-only turns count as "no answer text" deliberately:
  nothing was shown to the user. The GUI now shows an error banner instead of a
  successful-but-empty turn.
- The vendor's interaction ask used to be refused by `src/vendor/registry.js`
  (`INTERACTION_TOOLS`, `REFUSAL_CODE -10001`, "current v1 does not support it;
  ask in text"). That refusal is why the vendor model fell back to a plain-text
  question and the turn ended ("it just stopped by itself"). For
  `ask_followup_question` the refusal is replaced by the translation above.

## 1.3.1 — 2026-10-27

### Changed

- The shipped row raises `mcpToolboxMaxTools` 48 → 100. Auto mode measured
  48 schemas on 2026-10-27 (7 plain + 12 browser + 12 serial + 8 remote-host + 9
  desktop) — exactly the old cap, i.e. zero headroom: one more tool anywhere
  would have silently dropped the declaration TAIL.

### Fixed

- The `skills` channel was sent **empty**: `collectSkills` called
  `ctx.skills.list()` with no lookup, so the registry answered from the host
  layer alone and found nothing while the session had 13 skills. The vendor's own
  `Skill` tool resolves a skill NAME to the `filePath` in that channel and
  answers `skill path is None` when the entry carries none — measured: the same
  call failed for every argument shape, and no `tool_use` ever reached the
  bridge. The lookup now passes the session's agent scope and workspace. Verified
  end to end: the vendor resolved the name to the very path we sent, forwarded a
  `read_files` call to the bridge, and the model quoted the skill body.
- Mapping for the vendor's own `load_skill` spelling (`src/vendor/registry.js`).
  The measured flow never uses it — the server solves `load_skill` by asking the
  client to read the file — so the entry is defensive.
- The rules channel now prefers the toolbox `skill` (it also returns
  `resourceBase`, which relative paths inside a skill need) and says the native
  `Skill` works too, instead of declaring it permanently broken.

## 1.3.0 — 2026-10-27

### Added

- `mcpToolboxMcpAuto` (default on): the MCP half of the toolbox is discovered
  from the DSH tool registry on every turn instead of being hand-listed. Every
  loaded MCP server publishes its own tools, so adding a server to the profile is
  all it takes for the vendor to see it. Measured failure this removes: the
  desktop-automation server was loaded and callable in the Web GUI but absent
  from `mcpToolWhitelist`, so the vendor's client rejected
  `use_mcp_tool(server_name:"open-computer-use", …)` locally with "MCP server is
  not enabled" before the request ever reached the bridge. Discovery reads
  `tools.schemas()` plus `tools.view().knownNames` (the complete name list,
  including tools registered in nested scopes) and resolves each name through
  `tools.get`, the same path the §27 completion fix uses.
- `mcpToolboxMcpDeny`: prefix deny list applied to declared names and to the
  names the rules advertise, so trimming a server cannot leave the model told
  about a tool it is unable to call.
- The toolbox audit record now covers EVERY declared server, not only the
  synthetic one, and its change signature includes them: an MCP server missing
  from the declaration is exactly the failure the record has to show.

### Changed

- The shipped row raises `mcpToolboxMaxTools` 36 → 48. Auto mode publishes ~41
  schemas (7 plain + 11 browser + 6 serial + 8 remote-host + 9 desktop), and the
  cap drops the whitelist TAIL — at 36 it would have silently swallowed the
  desktop tools it is meant to deliver.
- The explicit `mcp__…` whitelist entries still work and dedupe against
  discovery, so they can serve as a baseline until auto mode has proven itself.

### Fixed

- Hoist `mcpToolboxMcpAuto` / `mcpToolboxMcpDeny` above the first toolbox-name
  filter. The 1.3.0 draft read `mcpToolboxMcpDeny` through
  `isDeniedToolboxName()` before that `const` was initialized, so the plugin
  failed to activate with `ReferenceError: Cannot access 'mcpToolboxMcpDeny'
  before initialization`. An `apply(ctx, {})` mount test now covers activation.

## 1.2.3 — 2026-10-26

### Fixed

- Pass the local-usage callback from `stream()` into `#createPump`; the first
  1.2.2 cut referenced `purpose` inside the pump, where it is not in scope, so
  every turn failed with `lanagent: purpose is not defined`. An adapter-level
  completion test now runs the real `stream()` path against a fake transport.

## 1.2.2 — 2026-10-26

### Fixed

- Stop mapping the vendor agent's `token_usage.used_tokens` to DSH
  `usage.inputTokens`. That counter describes the vendor's own per-`chatId`
  conversation, not the prompt of this request. DSH's token meter treated it as
  local request pressure, so automatic compaction fired while the local surface
  was far below the threshold and repeated every turn (local compaction cannot
  shrink the vendor counter). The raw sample remains available through
  `onTokenUsage` for diagnostics. Completion now reports the host token meter's
  local request pressure as the usage sample when that service is reachable;
  otherwise it reports no usage and compaction falls back to its own estimate.

## 1.2.1 — 2026-10-22

### Fixed

- Close the open text/reasoning blocks when a tool call ends a step. They used to
  stay open until `task_status: completed`, so the final `block-end` replayed
  every earlier step's text into the last assistant message: the final summary
  was followed by the whole turn's intermediate narration. Each step's text now
  ends in its own assistant message.

## 1.2.0 — 2026-10-22

### Added

- Map the service's dedicated `thinking` blocks to DSH reasoning chunks
  (`block-start` / `reasoning-delta` / `block-end`). The GUI can now show the
  collapsible thinking section the desktop client shows, instead of dropping it.
  `thinkMode` still controls whether the service is asked to think; the shipped
  row sets `on` so the section is visible out of the box. `auto` asks only when
  DSH requests a reasoning effort; `off` never asks.

## 1.1.2 — 2026-10-22

### Fixed

- A resumed loop step now carries a deadline. The parked pump belongs to the
  controller of the step that parked it, whose request deadline is cleared on
  suspend; the resuming step's new controller is linked to the parked pump, so
  a vendor stream that never sends another chunk aborts instead of hanging the
  session forever.

## 1.1.1 — 2026-10-22

### Fixed

- Drop the second tool-progress narration variant, `Generating long tool, cost (Ns)`,
  as a whole text block. It is the same kind of server-side filler as
  `Generating N chars for tool X`; mixed or quoted blocks are still kept.

## 1.1.0 — 2026-10-21

### Migration

- This release renames the provider route and the credential references. When
  upgrading, copy the account and password values to `LAN_AGENT_USER` and
  `LAN_AGENT_PASSWORD` (the web Models page writes them), and point the default
  model provider at `lanagent`. The previous reference names are no longer read.

### Changed

- **The out-of-band bridge now runs through the vendor-request seam**
  (`src/vendor/registry.js`). One `interpret` → plan/local/refusal path, one
  `render` path, shared by vendor tools, DSH passthrough names, and the local
  environment preflight. The old 8-handler table is gone.
- `read_files` partial failure is one map with a per-path `[读取失败] …` value;
  a total failure is a top-level error naming every failing path. The private
  `__failed__` key is no longer sent.
- `replace_in_file` resolves SEARCH/REPLACE at plan time, using the same
  whitespace-tolerant match as the vendor client, and sends only exact `edit`
  calls. The hidden read→patch→write fallback and its extra write card are gone.
  An ambiguous fuzzy match now surfaces DSH's uniqueness error instead of
  silently replacing the first occurrence.
- `list_files` / Glob results are a JSON array of workspace-relative paths;
  Grep results are `path:line:text` without DSH's `Found N matches` chrome.
- `use_mcp_tool` falls back to the rendered content when the MCP value carries
  no text blocks, instead of returning raw JSON.
- Path mapping and the local preflight moved into the seam; `index.js` passes
  raw vendor arguments to the bridge.
- **The loop route now uses the same seam.** `planVendorCall` / `planNative` /
  `shapeLoopResults` are gone; the loop wraps the seam plan in the transport a
  presentation accepts (native calls or one `run_code` program) and renders with
  the same shape table as the bridge.
- The generated program no longer carries the tolerant-edit helper: the plan
  already resolved SEARCH/REPLACE to exact `edit` calls. A PTC style retry
  reuses the same plan instead of re-interpreting (and re-reading) the request.

### Added

- Trace correlation: every request carries a `requestId`; parked loop calls emit
  `request` and `settled` rows with the same id, and the bridge emits `settled`.
- `scripts.test` / `scripts.test:contract`, an MIT license, Node engine metadata,
  and the shipped documentation in `files`.
- The shipped base URL is the LAN origin over HTTP, because the service's
  certificate does not cover the IP. Use it only on a trusted network.

- `test/contract/fixtures.json`: 20 cases curated from real lanagent sessions
  (66 sessions, 455 text+value pairs), sanitized for paths/accounts/session ids.
- `test/contract/seam.test.mjs`: every case is rendered twice — with the
  bridge's structured `value` and with the loop's text-only outcome — and both
  must produce the same vendor answer.
- `scripts/contract/harvest.mjs` / `build-fixtures.mjs`: reproducible fixture
  collection from `~/.dsh/sessions` (maintainer-only; the pool is not committed).
- `src/fuzzy.js` `resolveBlock`: one definition of a SEARCH/REPLACE match, used
  by `applyBlock` and by the plan-time resolver.

### Removed

- The bridge handler table and `applyOneEdit` from `src/tools.js` (~300 lines).
  `src/tools.js` now holds formatters and the local preflight/memory readers.
