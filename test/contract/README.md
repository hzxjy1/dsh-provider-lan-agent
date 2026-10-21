# Contract fixtures (step 1 of the vendor-request seam)

These fixtures are the **input side** of the contract tests for A (the
vendor-request seam). The data lives here; `seam.test.mjs` is the contract suite
that drives it. The fixtures prove that real requests and real tool outcomes are
captured, sanitized, and shaped so the seam can be tested without a live vendor.

## Why these exist

The seam has to answer one question the same way on two routes that see
different data:

- **bridge**: `ToolExecutionResult.value` (structured) plus rendered text.
- **loop**: only the rendered text from DSH's `ToolResultMessage`; no `value`.

So every DSH call in a fixture is stored **once**, with an optional `value`.
The contract test derives two outcomes from it:

```
withValue = call                          // bridge
textOnly  = { ...call, value: undefined } // loop
```

The seam must produce the same vendor answer from both. If it cannot, the
fixture is telling us the contract is unspecified — which is the case for
several tools today (`read_files` failure shape, `search_files` Glob, fuzzy
edits).

## Layout

```
test/contract/
├── fixtures.json        # committed, sanitized, reviewable (~17 KB)
├── fixtures.test.mjs    # integrity only; knows nothing about the seam
└── README.md

Maintainer scripts live in `scripts/contract/` so `node --test` does not try to
run them as tests.
```

## Case schema

```jsonc
{
  "id": "read_files/partial",     // "<vendor tool>/<scenario>"
  "kind": "dsh",                  // dsh | local | refusal
  "vendor": "read_files",         // the name the vendor sends
  "cwd": "/workspace",
  "arguments": { "paths": ["…"] },
  "calls": [                      // one per planned DSH call, in plan order
    {
      "key": "read:0",
      "dshTool": "read",
      "isError": false,
      "text": "<path>…</path>\n<content>\n1: …",
      "value": { "path": "…", "offset": 1, "lines": […], "totalLines": 1 }
    }
  ],
  "documents": { "…": "file content" },  // plan-time inputs (replace_in_file only)
  "expectedPlan": { "calls": […] },      // only where the plan is already decided
  "observed": { "isError": true, "text": "…" } // evidence for refusal cases
}
```

`kind: "local"` (preflight) and `kind: "refusal"` cases have no `calls`; they
test interpretation, not execution.

## Coverage

| Vendor request | Cases |
|---|---|
| `execute_command` | success (real), timeout (synthetic shape) |
| `read_files` | success, partial failure, all-fail |
| `list_files` | success, empty |
| `search_files` | Grep, Glob |
| `write_to_file` | success |
| `replace_in_file` | exact, fuzzy (real trailing-space sample) |
| `use_mcp_tool` | synthetic toolbox name, external `mcp__` server |
| `run_code` | DSH passthrough |
| `get_environment_info` | local answer |
| refusal | interaction tool, empty arguments, unknown name |

## Regenerating

```bash
# 1. harvest real outcomes (reads ~/.dsh/sessions, writes one JSON file)
node scripts/contract/harvest.mjs --sessions ~/.dsh/sessions --out /tmp/lanagent-pool.json

# 2. curate the committed fixtures from the pool
node scripts/contract/build-fixtures.mjs --pool /tmp/lanagent-pool.json --out test/contract/fixtures.json

# 3. prove the fixtures are coherent and sanitized
node --test test/contract/fixtures.test.mjs
```

The pool is **not committed**: it contains user commands and file content. The
harvest script replaces home paths, account names, IPs, and session ids; the
fixture test fails if any of them survive.

## What is deliberately absent

Expected vendor answers. They are added with the seam, after the canonical
shapes are implemented, because writing them now would just duplicate today's
two divergent implementations. When the seam exists, each case gains an
`expected` block and the same fixture feeds both outcome variants.
