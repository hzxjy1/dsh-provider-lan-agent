# Changelog

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

- `test/contract/fixtures.json`: 19 cases harvested from real lanagent sessions
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
