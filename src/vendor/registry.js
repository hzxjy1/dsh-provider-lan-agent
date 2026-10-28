/**
 * The vendor-request seam (A): one registry, one interpret/render pair.
 *
 * A vendor request is interpreted once — vocabulary, aliases, path mapping,
 * plan-time SEARCH/REPLACE resolution — into a plain plan value. Execution is a
 * runner's job (the loop parks the plan, the bridge runs it now); the answer is
 * rendered later from the same plan plus whatever outcome the runner produced.
 *
 * The plan deliberately holds no functions and no WebSocket responder: the loop
 * route keeps it across steps, and tests can render it from a fake outcome. That
 * is also why the registry is a value, not a plugin framework: eight tools do
 * not need one.
 *
 * This module is not wired into `index.js` yet. The contract tests exercise it
 * directly; migration happens bridge-first (see the architecture report).
 *
 * @module src/vendor/registry
 */

import { randomUUID } from 'node:crypto'

import { applyBlock, resolveBlock } from '../fuzzy.js'
import { mapCommandText, mapPath, mapVendorPaths } from '../paths.js'
import { parseSearchReplaceBlocks, PASSTHROUGH_TOOL_NAMES } from '../tools.js'
import {
  commandOutput,
  errorAnswer,
  failed,
  globPaths,
  grepText,
  jsonAnswer,
  mcpText,
  readContent,
  textAnswer,
} from './shape.js'

/** The error code the vendor's client uses for a client-side refusal. */
export const REFUSAL_CODE = -10001

/** Vendor names that are UI interactions in its desktop client; v1 refuses them. */
const INTERACTION_TOOLS = new Set([
  'ask_followup_question',
  'enter_plan_mode',
  'plan_mode_respond',
  'switch_mode',
  'todo_list_snapshot',
  'restore_tool',
])

/** Vendor spellings that mean the same tool. */
const ALIASES = Object.freeze({ Bash: 'execute_command' })

const fail = (vendor, message) => ({
  kind: 'refusal',
  vendor,
  requestId: randomUUID(),
  startedAt: Date.now(),
  error: { code: REFUSAL_CODE, message: String(message) },
})

/** Local answers may arrive as a Map or as a plain object. */
function localAnswer(ctx, vendor) {
  if (ctx?.localAnswers instanceof Map) return ctx.localAnswers.get(vendor)
  return ctx?.localAnswers?.[vendor]
}

const planFor = (vendor, calls, extra = {}) => ({
  kind: 'dsh',
  vendor,
  requestId: randomUUID(),
  startedAt: Date.now(),
  calls,
  ...extra,
})

const one = (vendor, key, dshTool, args) => planFor(vendor, [{ key, dshTool, arguments: args }])

/** `bash`'s required description is generated from the command's first line. */
const descriptionFor = (command) => `lanagent 委派: ${command.split('\n')[0].trim().slice(0, 60)}`

/** Map vendor-named paths once, before planning. */
function mapVendorInput(vendor, input, ctx) {
  const mappings = Array.isArray(ctx?.mappings) ? ctx.mappings : []
  if (mappings.length === 0) return input
  const mapper = (path) => mapPath(path, mappings)
  const mapped = mapVendorPaths(vendor, input, mapper)
  if (vendor !== 'execute_command' || typeof mapped?.command !== 'string') return mapped
  const command = mapCommandText(mapped.command, mappings)
  return command === mapped.command ? mapped : { ...mapped, command }
}

/** Read the file a diff targets: fixture documents first, then the caller's reader. */
async function documentText(path, ctx) {
  if (ctx?.documents !== undefined && Object.hasOwn(ctx.documents, path)) return ctx.documents[path]
  if (typeof ctx?.readDocument === 'function') return await ctx.readDocument(path)
  return undefined
}

/** The vendor client's own replace-failure guidance. */
function replaceGuidance(reason, nearest) {
  return [
    'SEARCH 块未能在文件中应用。请检查：',
    '1. SEARCH 内容必须与文件完全一致（含空格与缩进）；',
    '2. 如文件使用 CRLF 行尾，SEARCH 块也要一致；',
    '3. 用更多上下文行来唯一定位。',
    `原始错误：${reason}${nearest === undefined ? '' : `（${nearest}）`}`,
  ].join('\n')
}

const ENTRIES = {
  execute_command: {
    plan(input) {
      const command = String(input?.command ?? '')
      if (command.trim().length === 0) return fail('execute_command', 'execute_command: command 参数为空')
      const workdir = typeof input?.workdir === 'string' && input.workdir.length > 0 ? input.workdir : '.'
      const timeout = Number(input?.timeout)
      return one('execute_command', 'cmd', 'bash', {
        command,
        description: descriptionFor(command),
        ...workdir === '.' ? {} : { workdir },
        ...Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {},
        ...input?.run_in_background === true ? { run_in_background: true } : {},
      })
    },
    render(_plan, get) {
      const call = get('cmd')
      if (failed(call)) return errorAnswer(String(call.text ?? '').trim() || 'bash 执行失败')
      return textAnswer(commandOutput(call))
    },
  },

  read_files: {
    plan(input) {
      const paths = Array.isArray(input?.paths) ? input.paths.map(String).filter((path) => path.length > 0) : []
      if (paths.length === 0) return fail('read_files', 'read_files: paths 参数为空')
      return planFor('read_files', paths.map((path, index) => ({
        key: `read:${index}`,
        dshTool: 'read',
        arguments: { file_path: path },
      })), { continueOnError: true })
    },
    render(plan, get) {
      const calls = plan.calls.map((call) => get(call.key))
      if (calls.every((call) => failed(call))) {
        const detail = plan.calls
          .map((call, index) => `${String(call.arguments.file_path)}: ${String(calls[index]?.text ?? '').trim()}`)
          .join('\n')
        return errorAnswer(`文件读取失败：\n${detail}`)
      }
      const payload = {}
      plan.calls.forEach((call, index) => {
        const outcome = calls[index]
        const path = String(call.arguments.file_path)
        payload[path] = failed(outcome)
          ? `[读取失败] ${String(outcome.text ?? '').trim()}`
          : readContent(outcome)
      })
      return jsonAnswer(payload)
    },
  },

  list_files: {
    plan(input) {
      const path = String(input?.path ?? '.')
      const recursive = String(input?.recursive ?? 'false').toLowerCase() === 'true'
      const base = path === '.' || path === '' ? '' : path.replace(/\\/g, '/').replace(/\/+$/, '')
      const pattern = `${base === '' ? '' : `${base}/`}${recursive ? '**/*' : '*'}`
      return one('list_files', 'glob', 'glob', {
        pattern,
        ...path === '.' ? {} : { path },
      })
    },
    render(plan, get, ctx) {
      const call = get('glob')
      if (failed(call)) return errorAnswer(String(call.text ?? '').trim() || 'list_files 失败')
      return jsonAnswer(globPaths(call, ctx?.cwd))
    },
  },

  /**
   * The vendor's own skill loader.
   *
   * Its model calls `load_skill({skill: "<name>"})` (the desktop client also
   * accepts `{path}`); the CLIENT is what reads the file, which is why the
   * request's `skills` channel has to carry each command's absolute path. With
   * no path in that channel the vendor answers the call itself with
   * "skill path is None" and never forwards it — so this entry only ever runs
   * once the catalogue is populated.
   */
  load_skill: {
    plan(input) {
      const name = String(input?.skill ?? input?.name ?? '').trim()
      if (name.length > 0) return one('load_skill', 'skill', 'skill', { name })
      const path = String(input?.path ?? '').trim()
      if (path.length > 0) return one('load_skill', 'doc', 'read', { file_path: path })
      return fail('load_skill', 'load_skill: 既没有 skill 名称也没有 path 参数')
    },
    render(plan, get) {
      const call = get(plan.calls[0].key)
      if (failed(call)) return errorAnswer(`技能加载失败：${String(call.text ?? '').trim()}`)
      // A path-based load is a plain file read; a name-based load already is the
      // skill body, so it must not be run through the read rendering.
      return textAnswer(plan.calls[0].dshTool === 'read' ? readContent(call) : String(call?.text ?? ''))
    },
  },

  search_files: {
    plan(input) {
      if (String(input?.claude_name ?? '') === 'Glob') {
        const pattern = String(input?.pattern ?? '')
        if (pattern.length === 0) return fail('search_files', 'search_files(Glob): 缺少 pattern 参数')
        return one('search_files', 'glob', 'glob', {
          pattern,
          ...input?.path === undefined ? {} : { path: String(input.path) },
        })
      }
      const pattern = String(input?.claude_name === undefined ? input?.regex ?? '' : input?.pattern ?? '')
      if (pattern.length === 0) return fail('search_files', 'search_files: 缺少 regex/pattern 参数')
      const include = input?.glob ?? input?.file_pattern ?? input?.type
      return one('search_files', 'grep', 'grep', {
        pattern,
        ...input?.path === undefined ? {} : { path: String(input.path) },
        ...include === undefined ? {} : { include: String(include) },
      })
    },
    render(plan, get, ctx) {
      const call = get(plan.calls[0].key)
      if (failed(call)) return errorAnswer(String(call.text ?? '').trim() || 'search_files 失败')
      return plan.calls[0].dshTool === 'grep'
        ? textAnswer(grepText(call))
        : jsonAnswer(globPaths(call, ctx?.cwd))
    },
  },

  write_to_file: {
    plan(input) {
      const path = String(input?.path ?? '')
      const content = input?.content
      if (path.length === 0 || typeof content !== 'string') {
        return fail('write_to_file', 'write_to_file: 缺少 path 或 content 参数')
      }
      return one('write_to_file', 'write', 'write', { file_path: path, content })
    },
    render(_plan, get) {
      const call = get('write')
      return failed(call) ? errorAnswer(String(call.text ?? '').trim() || 'write_to_file 失败') : textAnswer('success')
    },
  },

  replace_in_file: {
    async plan(input, ctx) {
      const path = String(input?.path ?? '')
      if (path.length === 0) return fail('replace_in_file', 'replace_in_file: 缺少 path 参数')
      let blocks
      try {
        blocks = parseSearchReplaceBlocks(input?.diff)
      } catch (error) {
        return fail('replace_in_file', error instanceof Error ? error.message : String(error))
      }
      const original = await documentText(path, ctx)
      if (typeof original !== 'string') {
        return fail('replace_in_file', `replace_in_file: 无法读取 ${path} 以解析 SEARCH 块`)
      }
      let text = original
      const calls = []
      for (const block of blocks) {
        const resolved = resolveBlock(text, block.search, block.replace)
        if (resolved.ok !== true) {
          return fail('replace_in_file', replaceGuidance(resolved.reason, resolved.nearest))
        }
        if (resolved.oldString !== resolved.newString) {
          calls.push({
            key: `edit:${calls.length}`,
            dshTool: 'edit',
            arguments: { file_path: path, old_string: resolved.oldString, new_string: resolved.newString },
          })
        }
        const applied = applyBlock(text, block.search, block.replace)
        if (applied.ok !== true) return fail('replace_in_file', replaceGuidance(applied.reason, applied.nearest))
        text = applied.text
      }
      // A diff that changes nothing is a successful no-op, not a refusal: the
      // vendor's model sent the block it meant, and there is simply no edit to run.
      return planFor('replace_in_file', calls)
    },
    render(plan, get) {
      const failedCall = plan.calls.map((call) => get(call.key)).find((call) => failed(call))
      return failedCall === undefined
        ? textAnswer('success')
        : errorAnswer(String(failedCall.text ?? '').trim() || 'replace_in_file 失败')
    },
  },

  use_mcp_tool: {
    plan(input, ctx) {
      const server = String(input?.server_name ?? '')
      const toolName = String(input?.tool_name ?? '')
      if (server.length === 0 || toolName.length === 0) {
        return fail('use_mcp_tool', 'use_mcp_tool: 缺少 server_name 或 tool_name 参数')
      }
      const args = input?.arguments !== null && typeof input?.arguments === 'object' ? input.arguments : {}
      if (server === ctx?.toolboxName) {
        const resolved = typeof ctx?.resolveTool === 'function' ? ctx.resolveTool(toolName) : toolName
        if (resolved === undefined) {
          const list = Array.isArray(ctx?.availableTools) ? ctx.availableTools.join(', ') : ''
          return fail('use_mcp_tool', `use_mcp_tool: 工具箱 ${server} 里没有名为 "${toolName}" 的工具。可用工具：${list}`)
        }
        return one('use_mcp_tool', 'mcp', resolved, args)
      }
      return one('use_mcp_tool', 'mcp', `mcp__${server}__${toolName}`, args)
    },
    render(_plan, get) {
      const call = get('mcp')
      return failed(call) ? errorAnswer(String(call.text ?? '').trim() || 'MCP 工具调用失败') : textAnswer(mcpText(call))
    },
  },

  run_code: {
    plan(input) {
      const code = input?.code
      if (typeof code !== 'string' || code.trim().length === 0) return fail('run_code', 'run_code: 缺少 code 参数')
      return one('run_code', 'run_code', 'run_code', {
        code,
        description: typeof input?.description === 'string' && input.description.trim().length > 0
          ? input.description
          : 'lanagent 委派的程序',
      })
    },
    render(_plan, get) {
      const call = get('run_code')
      return failed(call) ? errorAnswer(String(call.text ?? '').trim() || 'run_code 执行失败') : textAnswer(String(call.text ?? ''))
    },
  },

  get_environment_info: {
    async plan(_input, ctx) {
      const answer = typeof ctx?.localAnswer === 'function'
        ? await ctx.localAnswer('get_environment_info')
        : localAnswer(ctx, 'get_environment_info')
      return {
        kind: 'local',
        vendor: 'get_environment_info',
        requestId: randomUUID(),
        startedAt: Date.now(),
        answer,
      }
    },
    render() {
      throw new Error('get_environment_info is local and never reaches render')
    },
  },
}

/** A DSH-vocabulary name the vendor may use directly (including `mcp__*`). */
function passthroughPlan(vendor, input) {
  return planFor(vendor, [{ key: 'passthrough', dshTool: vendor, arguments: input }], { passthrough: true })
}

/**
 * Interpret one vendor request.
 *
 * @param {string} name the vendor's tool name.
 * @param {object} input its argument map.
 * @param {object} [ctx]
 * @param {string} [ctx.cwd] session workspace, for relative paths.
 * @param {readonly {from: string, to: string}[]} [ctx.mappings] resolved path mappings.
 * @param {string} [ctx.toolboxName] synthetic MCP server name.
 * @param {(name: string) => string|undefined} [ctx.resolveTool] bare toolbox name -> DSH name.
 * @param {readonly string[]} [ctx.availableTools]
 * @param {Record<string,string>} [ctx.documents] fixture/plan-time file contents.
 * @param {(path: string) => Promise<string|undefined>} [ctx.readDocument]
 * @param {Map<string, object>} [ctx.localAnswers]
 * @returns {Promise<object>} a plan, a local answer, or a refusal.
 */
export async function interpret(name, input, ctx = {}) {
  const vendor = ALIASES[String(name ?? '')] ?? String(name ?? '')
  const requestId = ctx.requestId ?? randomUUID()
  const finish = (plan, mapped) => {
    if (plan !== null && typeof plan === 'object') {
      plan.requestId = requestId
      if (mapped !== undefined) plan.mappedArguments = mapped
    }
    return plan
  }
  const args = input !== null && typeof input === 'object' ? input : {}
  if (INTERACTION_TOOLS.has(vendor)) {
    return finish(fail(vendor, `工具 ${vendor} 是厂商的交互类工具，当前 v1 不支持；请直接用文字向用户提问。`))
  }
  const entry = ENTRIES[vendor]
  if (entry === undefined) {
    if (PASSTHROUGH_TOOL_NAMES.has(vendor) || vendor.startsWith('mcp__')) return finish(passthroughPlan(vendor, args), args)
    const available = [...Object.keys(ENTRIES), ...PASSTHROUGH_TOOL_NAMES].join(', ')
    return finish(fail(vendor, `工具 ${vendor} 在当前配置下不可用：该名字既不是厂商内置工具，也不是 DSH 声明的工具。可用工具：${available}`))
  }
  const mapped = mapVendorInput(vendor, args, ctx)
  // The trace records what the DSH side actually saw, not the vendor spelling
  // (design notes §23): keep the mapped arguments on the plan as a plain value.
  return finish(await entry.plan(mapped, ctx), mapped)
}

/**
 * Render one outcome into the vendor's answer.
 *
 * @param {object} plan the value returned by {@link interpret}.
 * @param {Map<string, {text: string, isError: boolean, value?: unknown}>} [outcomes] by call key.
 * @param {object} [ctx] same context shape as {@link interpret}, plus `cwd`.
 * @returns {{content: Array<{type: 'text', text: string}>} | {error: {code: number, message: string}}}
 */
export function render(plan, outcomes = new Map(), ctx = {}) {
  if (plan === undefined || plan === null) return errorAnswer('没有可渲染的厂商请求')
  if (plan.kind === 'refusal') return errorAnswer(plan.error?.message ?? '请求被拒绝')
  if (plan.kind === 'local') return plan.answer ?? localAnswer(ctx, plan.vendor) ?? textAnswer('')
  const get = (key) => outcomes.get(key) ?? { text: '', isError: true }
  if (plan.passthrough === true) {
    const call = get('passthrough')
    if (failed(call)) return errorAnswer(String(call.text ?? '').trim() || `${plan.vendor} 执行失败`)
    const text = String(call?.text ?? '').trim()
    return textAnswer(text.length > 0 ? text : JSON.stringify(call?.value ?? null))
  }
  const entry = ENTRIES[plan.vendor]
  if (entry === undefined) return errorAnswer(`工具 ${plan.vendor} 没有渲染器`)
  return entry.render(plan, get, ctx)
}

/** The names the registry can interpret (for refusal text and tests). */
export const REGISTRY_TOOLS = Object.freeze([...Object.keys(ENTRIES)])
