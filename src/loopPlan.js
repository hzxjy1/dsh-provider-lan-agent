/**
 * Transport details for the LOOP execution route.
 *
 * The seam (`src/vendor/registry.js`) already decided what a vendor request
 * means: which DSH calls to make, with which mapped arguments. This module owns
 * only what the loop route adds on top of that plan:
 *
 *   - a `run_code` envelope when the presentation accepts only programs, with a
 *     sentinel that survives the renderer;
 *   - refusal detection, so a PTC presentation can be learned per session;
 *   - the two text renderings the seam needs on the text-only path (`read`'s
 *     tagged window and `glob`'s path list).
 *
 * It does not translate vendor arguments and does not shape vendor answers;
 * both live in the seam so the bridge and the loop cannot drift.
 *
 * @module src/loopPlan
 */

import { toWorkspaceRelative } from './tools.js'

/** Vendor requests the loop route must not take: the preflight stays local. */
export const LOOP_EXCLUDED = Object.freeze(new Set(['get_environment_info']))

/** DSH tool names this route may target; overridable so a deployment can re-map. */
export const PLAN_TOOL_NAMES = Object.freeze({
  runCode: 'run_code',
  bash: 'bash',
  read: 'read',
  write: 'write',
  edit: 'edit',
  glob: 'glob',
  grep: 'grep',
})

/**
 * Markers the generated `run_code` program wraps its payload in.
 *
 * A PTC session only lets the model call `run_code`, so a loop-routed call is
 * handed over as a generated program. The program returns structured values as
 * JSON, and the loop hands back *rendered* text — this sentinel survives any
 * envelope or escaping the renderer applies, so the payload can always be found
 * without depending on the rendering format.
 */
export const SENTINEL_OPEN = '<<<LANAGENT-RESULT>>>'
export const SENTINEL_CLOSE = '<<<LANAGENT-END>>>'

/**
 * How a presentation refuses a name it does not offer. DSH's dispatch reports
 * `unknown tool "x"` with the structured code `UNKNOWN_TOOL`; the rendered text
 * a PTC session produces for a collapsed name is one of these phrasings.
 */
const NO_TOOLS_RE = /unknown tool|UNKNOWN_TOOL|not (?:a )?(?:known|visible|available)\b|unsupported tool|工具.{0,6}不可用/i

/**
 * The PTC collapse has its own unmistakable wording, and it has to be enough on
 * its own: the tool-result message DSH hands the adapter does NOT always carry
 * `isError` (measured — a refusal arrived as a plain tool message, was reshaped
 * as a *successful* command output, and the agent then retried the same command
 * four times). Relying on the flag alone is what made that loop possible.
 */
const REFUSAL_PHRASE_RE = /only\s+`?run_code`?\s+is\s+callable|from inside a\s+`?run_code`?\s+program/i

/**
 * Does this loop result mean the presentation refused the tool name?
 *
 * @param {{text: string, isError: boolean}} result
 */
export function isToolRefusal(result) {
  const text = String(result?.text ?? '')
  if (REFUSAL_PHRASE_RE.test(text)) return true
  return result?.isError === true && NO_TOOLS_RE.test(text)
}

/**
 * Does this result mean the tool itself failed?
 *
 * DSH renders a tool-level failure as `Error: …`, and its tool result messages
 * do not reliably carry `isError` (see {@link isToolRefusal}). Reporting a failed
 * write as `"success"` — which the agent's model then believes — is worse than
 * the small chance of mistaking command output that begins with "Error:"; for
 * `execute_command` that risk is accepted because the text is preserved inside
 * the error envelope.
 *
 * @param {{text: string, isError: boolean}} result
 */
export function looksLikeErrorText(result) {
  return result?.isError === true || /^\s*Error:\s/.test(String(result?.text ?? ''))
}

/**
 * Does this system prompt come from a PTC presentation?
 *
 * @param {string} system
 * @returns {boolean}
 */
export function looksLikePtcPrompt(system) {
  const text = typeof system === 'string' ? system : ''
  if (text.length === 0) return false
  return /`?run_code`?\s+is\s+the\s+only/i.test(text) || /only\s+`?run_code`?/i.test(text)
}

/**
 * Wrap a seam plan in the transport the presentation accepts.
 *
 * `plan.calls` stays the native plan: rendering, audit, and retry all speak that
 * vocabulary. `transportCalls` is what the loop actually executes — the same
 * calls, or one generated program that runs them and returns a sentinel payload.
 *
 * @param {object} plan the value returned by the seam's `interpret`.
 * @param {'native'|'run_code'} style
 * @returns {object} a plain plan value with `style` and `transportCalls`.
 */
export function withStyle(plan, style, { runCode = PLAN_TOOL_NAMES.runCode } = {}) {
  // `run_code` is directly callable in a PTC presentation; wrapping it in
  // another `run_code` program would nest the transport inside itself.
  if (style !== 'run_code' || plan.calls.some((call) => call.dshTool === runCode)) {
    return { ...plan, style: 'native', transportCalls: plan.calls }
  }
  return {
    ...plan,
    style: 'run_code',
    transportCalls: [{
      key: 'run_code',
      dshTool: runCode,
      arguments: {
        description: `lanagent 委派: ${plan.vendor}`,
        code: programFor(plan.calls),
      },
    }],
  }
}

/**
 * Build the program that performs every planned call and reports one JSON array.
 *
 * The plan already resolved SEARCH/REPLACE blocks to exact `edit` calls, so the
 * program is a plain sequence — no tolerant matching, no placeholder rewriting.
 * A failing call becomes an `{ok:false}` entry instead of a program-level throw,
 * so the agent's model reads the failing tool's own message.
 *
 * @param {readonly {dshTool: string, arguments: object}[]} calls
 * @returns {string}
 */
export function programFor(calls) {
  const body = calls.map((call) => [
    'try {',
    `  results.push({ ok: true, value: await tools[${JSON.stringify(call.dshTool)}](${JSON.stringify(call.arguments)}) })`,
    '} catch (error) {',
    '  results.push({ ok: false, error: String(error?.message ?? error) })',
    '}',
  ].join('\n'))
  return [
    'const results = []',
    ...body,
    `return ${JSON.stringify(SENTINEL_OPEN)} + JSON.stringify(results) + ${JSON.stringify(SENTINEL_CLOSE)}`,
  ].join('\n')
}

/**
 * Read the payload back out of whatever the loop rendered.
 *
 * @param {string} text
 * @returns {Array<{ok: boolean, value?: unknown, error?: string}>|undefined}
 */
export function parseSentinel(text) {
  const source = String(text ?? '')
  const start = source.indexOf(SENTINEL_OPEN)
  const end = source.indexOf(SENTINEL_CLOSE)
  if (start === -1 || end === -1 || end < start) return undefined
  const payload = source.slice(start + SENTINEL_OPEN.length, end)
  try {
    const parsed = JSON.parse(payload)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize the loop's tool results into the seam's outcome map.
 *
 * Native style: one result per planned call, keyed by the call key.
 * Program style: the single `run_code` result carries a sentinel JSON array, one
 * entry per planned call (in plan order); each entry's `value` is kept so the
 * seam can use structured data even on the loop route.
 *
 * @param {object} plan a plan from `withStyle` (native calls + transport calls).
 * @param {Map<string, {text: string, isError: boolean}>} results by transport call id.
 * @param {Map<string, string>} ids planned call key -> transport call id.
 * @returns {Map<string, {text: string, isError: boolean, value?: unknown}>}
 */
export function outcomesForPlan(plan, results, ids) {
  const outcomes = new Map()
  if (plan.style === 'run_code') {
    const transport = plan.transportCalls[0]
    const outer = results.get(String(ids.get(transport.key))) ?? { text: '', isError: true }
    const payload = parseSentinel(outer.text)
    plan.calls.forEach((call, index) => {
      if (payload === undefined) {
        outcomes.set(call.key, { text: outer.text, isError: true })
        return
      }
      const entry = payload[index] ?? { ok: false, error: outer.text }
      outcomes.set(call.key, {
        text: entry.ok === true ? JSON.stringify(entry.value ?? null) : String(entry.error ?? ''),
        isError: entry.ok !== true,
        ...entry.ok === true ? { value: entry.value } : {},
      })
    })
    return outcomes
  }
  for (const call of plan.calls) {
    outcomes.set(call.key, results.get(String(ids.get(call.key))) ?? { text: '', isError: true })
  }
  return outcomes
}

/**
 * Unwrap DSH's `read` rendering into bare file content.
 *
 * The rendered shape is
 *   `<path>P</path>\n<type>file</type>\n<content>\n1: line\n…\n(footer)\n</content>`
 * and the vendor's own client returns raw content, so the tags, the line-number
 * prefixes and the "End of file" footer are removed here. A truncation footer is
 * kept as a note, because the model has to know the file continues.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripReadRendering(text) {
  const source = String(text ?? '')
  const open = source.indexOf('<content>')
  if (!source.startsWith('<path>') || open === -1) return source
  let body = source.slice(open + '<content>'.length)
  const close = body.lastIndexOf('</content>')
  if (close !== -1) body = body.slice(0, close)
  body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  const lines = body.split(/\r?\n/)
  // The footer is separated from the content by a blank line.
  let footer = ''
  const blank = lines.lastIndexOf('')
  if (blank !== -1 && blank >= lines.length - 2) {
    footer = lines.slice(blank + 1).join('\n').trim()
    lines.length = blank
  }
  const content = lines.map((line) => line.replace(/^\d+: ?/, '')).join('\n')
  const truncated = /Showing lines|Output capped/i.test(footer)
  return truncated ? `${content}\n\n[已截断：${footer}]` : content
}

/** Turn DSH's rendered `glob` output into the vendor's path array. */
export function parseGlobText(text, cwd) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length === 0 || (lines.length === 1 && /^No files found$/i.test(lines[0]))) return []
  return lines.map((line) => toWorkspaceRelative(line, cwd))
}
