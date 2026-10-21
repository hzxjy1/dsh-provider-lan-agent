/**
 * Planning and shaping for the LOOP execution route.
 *
 * The out-of-band route (`src/tools.js`) calls `ctx.tools.execute()` itself and
 * reads each tool's structured `value`. The loop route hands the call to DSH's
 * agent loop instead — which is what draws the native "run command" card, keeps
 * approvals in the loop, and records `tool/call` + `tool/result` in the session
 * — and the loop gives the result back as *rendered content blocks*, not as a
 * structured value (design notes §21).
 *
 * So this module owns the two things the loop route needs and the out-of-band
 * route gets for free:
 *
 *   1. **planVendorCall** — one vendor request (its own vocabulary) becomes one
 *      or more DSH tool calls (a `replace_in_file` diff is several `edit`s, a
 *      multi-path `read_files` is several `read`s). The argument mapping is the
 *      same one the out-of-band route uses; it lives here so both routes agree.
 *   2. **shapeLoopResults** — the loop's rendered text for each call becomes the
 *      payload the vendor's model was trained to read (`{success,output,error}`
 *      for a command, `{path: content}` for a read, the literal `"success"` for
 *      an edit, …). The `read` tool's rendering is unwrapped here, because the
 *      vendor expects bare file content while DSH renders a tagged, numbered
 *      window.
 *
 * @module src/loopPlan
 */

import { formatExecuteCommand, formatGrepValue, formatReadValue, parseSearchReplaceBlocks, toWorkspaceRelative } from './tools.js'

/** Vendor requests the loop route must not take: the preflight stays local. */
export const LOOP_EXCLUDED = Object.freeze(new Set(['get_environment_info']))

/** DSH tool names this planner may target; overridable so a deployment can re-map. */
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
 * handed over as a generated program. That program returns structured values as
 * JSON, and the loop hands back *rendered* text — this sentinel survives any
 * envelope or escaping the renderer applies, so the payload can always be found
 * without depending on the rendering format.
 */
export const SENTINEL_OPEN = '<<<LANAGENT-RESULT>>>'
export const SENTINEL_CLOSE = '<<<LANAGENT-END>>>'

/** DSH's own vocabulary, published in the injected system prompt. */
const PASSTHROUGH = new Set([
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'present', 'todo_write',
  'ask_user_question', 'subagent', 'subagent_fork', 'job_list', 'job_output', 'job_kill',
  'skill', 'web_fetch', 'web_search',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
])

const fail = (message) => ({ error: message })
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
 * as a *successful* command output, and the vendor then retried the same command
 * four times). Relying on the flag alone is what made that loop possible.
 */
const REFUSAL_PHRASE_RE = /only\s+`?run_code`?\s+is\s+callable|from inside a\s+`?run_code`?\s+program/i

/**
 * Does this loop result mean the presentation refused the tool name?
 *
 * A PTC session presents only `run_code`, so the first native-style call comes
 * back as an unknown-tool refusal. That is the signal to switch this session to
 * the generated-program style instead of asking the user to change presets.
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
 * write as `"success"` — which the vendor's model then believes — is worse than
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
 * A PTC session presents only `run_code` and says so in the prompt the adapter
 * receives as `options.system` — e.g. "`run_code` is the only tool you can call
 * directly — a tool call naming any other tool fails". Reading it here means the
 * first tool call already uses the generated-program style, so the user never
 * sees a refused call card just to discover the presentation. The refusal-based
 * learner stays as the safety net for prompts that do not announce it.
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
 * The whitespace-tolerant fallback the generated program carries.
 *
 * The vendor's client matches a SEARCH block loosely (whitespace, line endings),
 * DSH's `edit` matches exactly, so an edit the vendor expects to succeed can fail
 * here. The program therefore tries the edit, and on failure reads the file,
 * patches only the matched run of lines, and writes it back — mirroring
 * `src/fuzzy.js` (which the out-of-band route uses) inside the sandbox, where the
 * file content is only reachable through the SDK.
 */
const FUZZY_HELPERS = [
  'const __lines = (value) => (Array.isArray(value?.lines) ? value.lines.map((line) => String(line?.text ?? "")).join("\\n") : undefined)',
  'const __norm = (line) => String(line ?? "").replace(/\\r$/, "").replace(/[ \\t]+$/, "")',
  'const __split = (text) => { const body = String(text ?? "").replace(/\\r\\n?/g, "\\n"); const out = body.split("\\n"); if (out.length > 1 && out[out.length - 1] === "") out.pop(); return out }',
  'const __patch = (fileText, search, replace) => {',
  '  const file = __split(fileText)',
  '  const want = __split(search).map(__norm)',
  '  let __lead = 0',
  '  while (want.length > 0 && want[0] === "") { want.shift(); __lead += 1 }',
  '  let __tail = 0',
  '  while (want.length > 0 && want[want.length - 1] === "") { want.pop(); __tail += 1 }',
  '  if (want.length === 0) return { ok: false, reason: "SEARCH 块为空" }',
  '  const have = file.map(__norm)',
  '  for (let start = 0; start + want.length <= have.length; start += 1) {',
  '    let same = true',
  '    for (let index = 0; index < want.length; index += 1) { if (have[start + index] !== want[index]) { same = false; break } }',
  '    if (!same) continue',
  '    const __raw = __split(replace)',
  '    let __from = 0',
  '    while (__from < __lead && __from < __raw.length && __norm(__raw[__from]) === "") __from += 1',
  '    let __to = __raw.length',
  '    while (__raw.length - __to < __tail && __to > __from && __norm(__raw[__to - 1]) === "") __to -= 1',
  '    const __replacement = __raw.slice(__from, __to)',
  '    const __joined = [...file.slice(0, start), ...__replacement, ...file.slice(start + want.length)].join("\\n")',
  '    return { ok: true, text: /\\n$/.test(String(fileText)) ? __joined + "\\n" : __joined }',
  '  }',
  '  return { ok: false, reason: "SEARCH 块在文件中找不到（含空白容错后仍找不到）" }',
  '}',
].join('\n')

/** One planned call as program statements: `edit` gets the tolerant fallback. */
function statementsFor(call, index) {
  const tool = JSON.stringify(call.dshTool)
  const args = JSON.stringify(call.arguments)
  const plain = `try { results.push({ ok: true, value: await tools[${tool}](${args}) }) } catch (error) { results.push({ ok: false, error: String(error?.message ?? error) }) }`
  if (call.dshTool !== PLAN_TOOL_NAMES.edit) return [plain]
  const { file_path: filePath, old_string: search, new_string: replace } = call.arguments
  return [
    `try { results.push({ ok: true, value: await tools[${tool}](${args}), via: "edit" }) } catch (error) {`,
    '  try {',
    `    const __file = await tools[${JSON.stringify(PLAN_TOOL_NAMES.read)}](${JSON.stringify({ file_path: filePath })})`,
    '    const __text = __lines(__file)',
    `    const __fixed = __text === undefined ? { ok: false, reason: "read 结果里没有 lines" } : __patch(__text, ${JSON.stringify(search)}, ${JSON.stringify(replace)})`,
    '    if (!__fixed.ok) { results.push({ ok: false, error: String(error?.message ?? error) + "；" + __fixed.reason }) }',
    `    else { await tools[${JSON.stringify(PLAN_TOOL_NAMES.write)}](${JSON.stringify({ file_path: filePath, content: '__LAN_AGENT_FUZZY__' })})`,
    '      results.push({ ok: false, error: "__LAN_AGENT_FUZZY_PLACEHOLDER__" }) }',
    '  } catch (inner) { results.push({ ok: false, error: String(inner?.message ?? inner) }) }',
    '}',
  ]
}

/** Build the program that runs each planned call and reports one JSON array. */
export function programFor(calls) {
  const needsFuzzy = calls.some((call) => call.dshTool === PLAN_TOOL_NAMES.edit)
  const bodies = calls.flatMap((call, index) => statementsFor(call, index))
  // The fuzzy write reuses the already-computed text: emit it through a variable
  // rather than stringifying the whole file twice.
  const source = bodies.join('\n').replace(
    /await tools\["write"\]\(\{"file_path":("(?:[^"\\]|\\.)*"),"content":"__LAN_AGENT_FUZZY__"\}\)\n\s*results\.push\(\{ ok: false, error: "__LAN_AGENT_FUZZY_PLACEHOLDER__" \}\)/g,
    'await tools["write"]({ file_path: $1, content: __fixed.text })\n      results.push({ ok: true, value: { file_path: $1, fuzzy: true } })',
  )
  return [
    'const results = []',
    ...(needsFuzzy ? [FUZZY_HELPERS] : []),
    source,
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
const asString = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

/** The one-line description DSH's `bash` requires, derived from the command. */
const descriptionFor = (command) => `lanagent 委派: ${command.split('\n')[0].trim().slice(0, 60)}`

/**
 * Plan one vendor tool request.
 *
 * @param {string} name the vendor's tool name (or a DSH name used directly).
 * @param {object} input the vendor's argument map.
 * @param {object} [options]
 * @param {string} [options.cwd] session workspace, for pattern/relative fixes.
 * @param {string} [options.toolboxName] synthetic toolbox server name.
 * @param {object} [options.names] DSH tool-name overrides.
 * @returns {{ vendorTool: string, calls: Array<{key: string, dshTool: string, arguments: object}> }
 *   | { vendorTool: string, error: string }}
 */
export function planVendorCall(name, input = {}, { cwd, toolboxName = 'dsh_toolbox', names = {}, style = 'native', resolveTool, availableTools } = {}) {
  const tool = { ...PLAN_TOOL_NAMES, ...names }
  const vendorTool = String(name ?? '')
  const one = (key, dshTool, args) => ({ vendorTool, calls: [{ key, dshTool, arguments: args }] })

  if (LOOP_EXCLUDED.has(vendorTool)) return fail(`${vendorTool} 不走 loop（环境预检保持本地应答）`)

  const planned = planNative(vendorTool, input, { cwd, toolboxName, names, tool, resolveTool, availableTools })
  if (planned.error !== undefined) return planned
  if (style !== 'run_code') return planned
  // PTC sessions present only `run_code`: hand the same calls over as one
  // generated program, keeping the native plan for shaping.
  return {
    vendorTool,
    style: 'run_code',
    vendorArgs: input,
    nativeCalls: planned.calls,
    calls: [{
      key: 'run_code',
      dshTool: tool.runCode,
      arguments: {
        description: `lanagent 委派: ${vendorTool}`,
        code: programFor(planned.calls),
      },
    }],
  }
}

/** The vocabulary mapping both styles share. */
function planNative(vendorTool, input, { cwd, toolboxName, tool, resolveTool, availableTools }) {
  const one = (key, dshTool, args) => ({ vendorTool, calls: [{ key, dshTool, arguments: args }] })
  switch (vendorTool) {
    case 'execute_command': {
      const command = asString(input.command)
      if (command.trim().length === 0) return fail('execute_command: command 参数为空')
      const workdir = asString(input.workdir, '.')
      const timeout = Number(input.timeout)
      return one('cmd', tool.bash, {
        command,
        description: descriptionFor(command),
        ...workdir === '.' || workdir === '' ? {} : { workdir },
        ...Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {},
        ...input.run_in_background === true ? { run_in_background: true } : {},
      })
    }
    case 'read_files': {
      const paths = Array.isArray(input.paths) ? input.paths.map(String).filter((p) => p.length > 0) : []
      if (paths.length === 0) return fail('read_files: paths 参数为空')
      return { vendorTool, calls: paths.map((path, index) => ({ key: `read:${index}`, dshTool: tool.read, arguments: { file_path: path }, path })) }
    }
    case 'list_files': {
      const path = asString(input.path, '.')
      const recursive = String(input.recursive ?? 'false').toLowerCase() === 'true'
      const base = path === '.' || path === '' ? '' : path.replace(/\\/g, '/').replace(/\/+$/, '')
      return one('glob', tool.glob, { pattern: `${base === '' ? '' : `${base}/`}${recursive ? '**/*' : '*'}`, ...path === '.' ? {} : { path } })
    }
    case 'search_files': {
      if (String(input.claude_name ?? '') === 'Glob') {
        const pattern = asString(input.pattern)
        if (pattern.length === 0) return fail('search_files(Glob): 缺少 pattern 参数')
        return one('glob', tool.glob, { pattern, ...input.path === undefined ? {} : { path: String(input.path) } })
      }
      const pattern = asString(input.claude_name === undefined ? input.regex : input.pattern)
      if (pattern.length === 0) return fail('search_files: 缺少 regex/pattern 参数')
      const include = input.glob ?? input.file_pattern ?? input.type
      return one('grep', tool.grep, {
        pattern,
        ...input.path === undefined ? {} : { path: String(input.path) },
        ...include === undefined ? {} : { include: String(include) },
      })
    }
    case 'write_to_file': {
      if (asString(input.path).length === 0 || typeof input.content !== 'string') return fail('write_to_file: 缺少 path 或 content 参数')
      return one('write', tool.write, { file_path: String(input.path), content: input.content })
    }
    case 'replace_in_file': {
      const path = asString(input.path)
      if (path.length === 0) return fail('replace_in_file: 缺少 path 参数')
      let blocks
      try {
        blocks = parseSearchReplaceBlocks(input.diff)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      return {
        vendorTool,
        calls: blocks.map((block, index) => ({
          key: `edit:${index}`,
          dshTool: tool.edit,
          arguments: { file_path: path, old_string: block.search, new_string: block.replace },
          path,
        })),
      }
    }
    case 'use_mcp_tool': {
      const server = asString(input.server_name)
      const toolName = asString(input.tool_name)
      if (server.length === 0 || toolName.length === 0) return fail('use_mcp_tool: 缺少 server_name 或 tool_name 参数')
      let dshTool = server === toolboxName ? toolName : `mcp__${server}__${toolName}`
      // The vendor splits an MCP tool the way its own client does: a bare tool
      // name under the server it came from. Our synthetic toolbox publishes DSH's
      // own names, where an MCP-backed tool keeps its `mcp__<server>__<tool>`
      // prefix — so `browser_navigate` has to resolve back to
      // `mcp__playwright-edge__browser_navigate`, or the program dies with
      // "tools.browser_navigate is not a function" (measured, design notes §27).
      if (server === toolboxName && typeof resolveTool === 'function') {
        const resolved = resolveTool(toolName)
        if (resolved === undefined) {
          const list = Array.isArray(availableTools) ? availableTools.join(', ') : ''
          return fail(`use_mcp_tool: 工具箱 ${toolboxName} 里没有名为 "${toolName}" 的工具。可用工具：${list}`)
        }
        dshTool = resolved
      }
      return one('mcp', dshTool, input.arguments !== null && typeof input.arguments === 'object' ? input.arguments : {})
    }
    default: {
      if (PASSTHROUGH.has(vendorTool) || vendorTool.startsWith('mcp__')) {
        return one('passthrough', vendorTool, input)
      }
      return fail(`工具 ${vendorTool} 无法走 loop：既不是 厂商内置工具，也不是 DSH 声明的工具`)
    }
  }
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

/**
 * Shape the loop's results into the vendor's expected payload.
 *
 * @param {{vendorTool: string, calls: Array<{key: string, dshTool: string, arguments: object, path?: string}>}} plan
 * @param {Map<string, {text: string, isError: boolean}>} results by call key.
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {{content: Array<{type: 'text', text: string}>} | {error: {code: number, message: string}}}
 */
export function shapeLoopResults(plan, results, { cwd } = {}) {
  if (plan.style === 'run_code') return shapeProgramResults(plan, results, { cwd })
  const get = (key) => results.get(key) ?? { text: '', isError: true }
  /** A call that failed, whether DSH flagged it or merely rendered `Error: …`. */
  const errored = (key) => looksLikeErrorText(get(key))
  const failed = plan.calls.filter((call) => errored(call.key))
  const say = (text) => ({ content: [{ type: 'text', text }] })
  const firstError = () => get(failed[0].key).text.trim()

  switch (plan.vendorTool) {
    case 'execute_command':
      // A refused name or a tool-level failure must NOT be reported as a command
      // that ran: the vendor's model reads `output` and would simply retry.
      if (isToolRefusal(get('cmd')) || errored('cmd')) return { error: { code: -10001, message: get('cmd').text.trim() } }
      // Otherwise the vendor reports success even for a non-zero exit; its own
      // client puts the failure inside `output`, and DSH's text carries it.
      return say(JSON.stringify({ success: true, output: get('cmd').text.trimEnd(), error: '' }))
    case 'read_files': {
      const payload = {}
      for (const call of plan.calls) {
        const result = get(call.key)
        if (looksLikeErrorText(result)) payload[call.arguments.file_path] = `[读取失败] ${result.text.trim()}`
        else payload[call.arguments.file_path] = stripReadRendering(result.text)
      }
      return say(JSON.stringify(payload))
    }
    case 'list_files':
      return errored('glob') ? { error: { code: -10001, message: firstError() } } : say(JSON.stringify(parseGlobText(get('glob').text, cwd)))
    case 'search_files':
      return errored(plan.calls[0].key) ? { error: { code: -10001, message: firstError() } } : say(get(plan.calls[0].key).text)
    case 'write_to_file':
      // Never claim success for a write that failed: the model believes it.
      return errored('write') ? { error: { code: -10001, message: firstError() } } : say('success')
    case 'replace_in_file':
      // One failing block fails the vendor's request: its model reads the
      // guidance text and retries with an exact SEARCH block.
      return failed.length > 0 ? { error: { code: -10001, message: firstError() } } : say('success')
    case 'use_mcp_tool':
    default:
      return errored(plan.calls[0].key)
        ? { error: { code: -10001, message: firstError() } }
        : say(get(plan.calls[0].key).text)
  }
}

/**
 * Shape a generated program's result into the vendor's payload.
 *
 * The program reports one entry per planned call, so a multi-file read still
 * answers a `{path: content}` map and a failed slot is reported in place — the
 * same contract the out-of-band route keeps — while a single failing call
 * becomes the vendor's error envelope.
 *
 * @param {object} plan a `style: 'run_code'` plan.
 * @param {Map<string, {text: string, isError: boolean}>} results
 */
function shapeProgramResults(plan, results, { cwd }) {
  const say = (text) => ({ content: [{ type: 'text', text }] })
  const envelope = (message) => ({ error: { code: -10001, message } })
  const result = results.get('run_code') ?? { text: '', isError: true }
  const payload = parseSentinel(result.text)
  const calls = plan.nativeCalls ?? []
  const at = (index) => payload?.[index] ?? { ok: false, error: result.text.trim() || '工具没有返回结果' }
  if (isToolRefusal(result) && payload === undefined) {
    return envelope(result.text.trim())
  }
  if (payload === undefined) {
    const text = result.text.trim()
    return envelope(text.length === 0 ? 'run_code 没有返回可解析的结果' : `run_code 没有返回可解析的结果：${text}`)
  }
  const allOk = calls.every((_, index) => at(index).ok === true)

  switch (plan.vendorTool) {
    case 'execute_command':
      return at(0).ok ? say(formatExecuteCommand(at(0).value)) : envelope(String(at(0).error))
    case 'read_files': {
      const map = {}
      calls.forEach((call, index) => {
        const entry = at(index)
        map[call.arguments.file_path] = entry.ok ? formatReadValue(entry.value) : `[读取失败] ${String(entry.error)}`
      })
      return say(JSON.stringify(map))
    }
    case 'list_files': {
      const entry = at(0)
      return entry.ok
        ? say(JSON.stringify((entry.value?.paths ?? []).map((path) => toWorkspaceRelative(String(path), cwd))))
        : envelope(String(entry.error))
    }
    case 'search_files': {
      const entry = at(0)
      if (!entry.ok) return envelope(String(entry.error))
      return say(calls[0]?.dshTool === PLAN_TOOL_NAMES.grep
        ? formatGrepValue(entry.value)
        : JSON.stringify((entry.value?.paths ?? []).map((path) => toWorkspaceRelative(String(path), cwd))))
    }
    case 'write_to_file':
    case 'replace_in_file':
      return allOk ? say('success') : envelope(String(calls.findIndex((_, index) => !at(index).ok) >= 0 ? at(calls.findIndex((_, index) => !at(index).ok)).error : '工具执行失败'))
    default: {
      const entry = at(0)
      if (!entry.ok) return envelope(String(entry.error))
      return say(typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value))
    }
  }
}
