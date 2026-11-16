/**
 * Vendor-facing formatters and the local preflight/memory readers.
 *
 * The translation itself now lives in `src/vendor/registry.js`; this module is
 * the shared vocabulary both sides use:
 *
 *   - result formatting from DSH's structured `value` (`formatExecuteCommand`,
 *     `formatReadValue`, `formatGrepValue`, `toWorkspaceRelative`);
 *   - `parseSearchReplaceBlocks`, the vendor's diff grammar;
 *   - `readMemoryInfo` / `collectEnvironment`, the local answers the seam and
 *     the memory responder need.
 *
 * The formatters are deliberately pure: the seam calls them for the bridge and,
 * through its text fallback, for the loop. Keeping them here avoids a cycle
 * (registry -> tools) while `src/vendor/shape.js` owns the choice between value
 * and text.
 *
 * @module src/tools
 */

import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

import { LanAgentError, FailureCode } from './errors.js'
import { SUBAGENT_TOOL_NAME } from './vendorName.js'

const execFileAsync = promisify(execFile)

/* ── diff markers ───────────────────────────────────────────────────────── */

/**
 * The vendor's SEARCH/REPLACE spelling (read out of its own client): a search
 * marker of three or more `-` or `<`, a separator of three or more `=`, and a
 * replace marker of three or more `+` or `>`, each optionally followed by a
 * trailing `>`. Its own error copy calls the seven-dash form canonical.
 */
const SEARCH_START = /^(?:-{3,}|<{3,}) SEARCH>?$/
const SEPARATOR = /^={3,}$/
const REPLACE_END = /^(?:\+{3,}|>{3,}) REPLACE>?$/

/**
 * Parse a vendor `replace_in_file` diff into literal replacement pairs.
 *
 * @param {string} diff
 * @returns {Array<{search: string, replace: string}>}
 * @throws {LanAgentError} when a block is unterminated or a separator has no search.
 */
export function parseSearchReplaceBlocks(diff) {
  const lines = String(diff ?? '').split(/\r?\n/)
  const blocks = []
  let state = 'idle'
  let current = { search: '', replace: '' }
  for (const line of lines) {
    if (SEARCH_START.test(line)) {
      if (state !== 'idle') throw new LanAgentError('replace_in_file: 上一个 SEARCH 块没有 REPLACE 结束标记', { code: FailureCode.badRequest })
      state = 'search'
      current = { search: '', replace: '' }
      continue
    }
    if (SEPARATOR.test(line) && state === 'search') {
      state = 'replace'
      continue
    }
    if (REPLACE_END.test(line) && state === 'replace') {
      blocks.push(current)
      state = 'idle'
      continue
    }
    if (state === 'search') current.search += `${line}\n`
    else if (state === 'replace') current.replace += `${line}\n`
  }
  if (state !== 'idle') throw new LanAgentError('replace_in_file: diff 在块内结束，缺少 REPLACE 结束标记', { code: FailureCode.badRequest })
  if (blocks.length === 0) throw new LanAgentError('replace_in_file: diff 里没有找到 SEARCH/REPLACE 块', { code: FailureCode.badRequest })
  return blocks
}

/* ── result shaping ─────────────────────────────────────────────────────── */

/** Join the text blocks of a DSH tool result. */
export function contentText(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  return content
    .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' ? String(block.text ?? '') : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

/** Path relative to the session workspace when it is inside it. */
export function toWorkspaceRelative(path, cwd) {
  if (typeof path !== 'string' || path.length === 0) return ''
  if (!isAbsolute(path)) return path
  if (typeof cwd !== 'string' || cwd.length === 0) return path
  const rel = relative(cwd, path)
  if (rel.length === 0) return '.'
  if (rel === '..' || rel.startsWith(`..${sep}`)) return path
  return rel.split(sep).join('/')
}

/**
 * Shape a DSH `bash` result for the vendor's `execute_command`.
 *
 * The vendor reports `success: true` even for a non-zero exit (its client puts
 * the failure in the output text), so a non-zero code is surfaced as output
 * rather than as an error — the model reads the code instead of losing it.
 *
 * @param {object} value `bash`'s structured output.
 * @returns {string} the JSON text the vendor's model expects.
 */
export function formatExecuteCommand(value) {
  if (value?.kind === 'background') {
    return JSON.stringify({ success: true, output: `命令已在后台运行，job id: ${String(value.jobId)}`, error: '' })
  }
  if (value?.kind === 'promoted') {
    return JSON.stringify({
      success: true,
      output: `命令超过 ${String(value.timeoutMs)}ms 被转入后台，job id: ${String(value.jobId)}\n${String(value.output ?? '')}`,
      error: '',
    })
  }
  const stdout = String(value?.stdout?.text ?? '')
  const stderr = String(value?.stderr?.text ?? '')
  const parts = []
  if (stdout.trim().length > 0) parts.push(stdout.trimEnd())
  if (stderr.trim().length > 0) parts.push(stderr.trimEnd())
  let output = parts.join('\n')
  if (value?.timedOut === true) output = `${output}\n[命令超时]`.trim()
  if (value?.aborted === true) output = `${output}\n[命令已取消]`.trim()
  if (typeof value?.exitCode === 'number' && value.exitCode !== 0) {
    output = `${output}\n[退出码 ${value.exitCode}]`.trim()
  }
  if (output.length === 0) output = `命令执行完成，退出码: ${String(value?.exitCode ?? 0)}`
  if (value?.stdout?.truncated === true || value?.stderr?.truncated === true) {
    output += '\n[输出已被截断]'
  }
  return JSON.stringify({ success: true, output, error: '' })
}

/**
 * Rebuild raw file text from `read`'s structured output.
 *
 * `read` numbers lines in its rendered text but publishes the raw line text in
 * `value.lines`, so no prefix stripping is needed. The vendor's own client
 * returns bare content; a truncation note is appended because DSH reads a
 * bounded window and the model has to know the file continues.
 *
 * @param {object} value `read`'s structured output.
 * @returns {string}
 */
export function formatReadValue(value) {
  const lines = Array.isArray(value?.lines) ? value.lines : []
  const text = lines.map((line) => String(line?.text ?? '')).join('\n')
  const last = lines.at(-1)?.number ?? 0
  const total = Number(value?.totalLines ?? last)
  if (last < total) {
    return `${text}\n\n[已截断：文件共 ${total} 行，本次返回第 ${String(value?.offset ?? 1)}-${String(last)} 行]`
  }
  return text
}

/** Render `grep`'s structured matches the way the vendor's own search does. */
export function formatGrepValue(value) {
  const matches = Array.isArray(value?.matches) ? value.matches : []
  if (matches.length === 0) return 'No matches found'
  return matches.map((match) => `${String(match?.path ?? '')}:${String(match?.lineNumber ?? 0)}:${String(match?.line ?? '')}`).join('\n')
}

/* ── environment preflight ──────────────────────────────────────────────── */

/** Run one read-only git command; any failure is simply missing information. */
async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 2500, windowsHide: true, maxBuffer: 1 << 20 })
    return String(stdout).trim()
  } catch {
    return ''
  }
}

/**
 * Answer `get_environment_info` locally.
 *
 * This is the vendor's very first call on every turn, and the desktop client
 * answers it from its own process without any user-visible tool. Going through
 * DSH's `bash` here would mean several commands per turn through the approval
 * pipeline; read-only git metadata is cheap and side-effect free, so it is
 * gathered directly (the vendor's own client does the same).
 *
 * @param {string|undefined} cwd the session workspace.
 * @returns {Promise<string>} JSON text in the vendor's `systemInfo` shape.
 */
/**
 * Read the vendor's own memory so its preflight can be answered truthfully.
 *
 * The vendor asks the CLIENT where its memory lives and what is in it
 * (`get_environment_info` carries `memoryPath` / `memoryContent` /
 * `sessionNotesContent`). We used to answer with empty strings, so the agent
 * fell back to its own convention (the CLI's home directory
 * that runs as root in its world) and — because the content always came back
 * empty — believed its memory never persisted, rewriting it over and over
 * (design notes §28).
 *
 * @param {string} root the mapped directory the vendor's memory lives in.
 * @returns {Promise<{path: string, content: string, notes: string}>}
 */
export async function readMemoryInfo(root) {
  if (typeof root !== 'string' || root.length === 0) return { path: '', content: '', notes: '' }
  const clip = (text) => (text.length <= 8000 ? text : `${text.slice(0, 8000)}\n[已截断]`)
  const readIfPresent = async (file) => {
    try {
      return clip(await readFile(file, 'utf8'))
    } catch {
      return ''
    }
  }
  const content = await readIfPresent(join(root, 'MEMORY.md'))
  let notes = ''
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const candidates = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const file = join(root, entry.name, 'session_notes.md')
      try {
        // NOT `const stat = await stat(file)`: the shadowed name put the call in
        // its own TDZ, the throw was swallowed by this catch, and the notes came
        // back empty (caught by the unit test).
        const info = await stat(file)
        candidates.push({ file, at: info.mtimeMs })
      } catch {
        // no notes for this session
      }
    }
    candidates.sort((left, right) => right.at - left.at)
    if (candidates[0] !== undefined) notes = await readIfPresent(candidates[0].file)
  } catch {
    // the directory does not exist yet: an empty memory is the truth
  }
  return { path: root, content, notes }
}

export async function collectEnvironment(cwd, memory) {
  const directory = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
  const [branch, mainBranchRaw, user, status, commits] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], directory),
    git(['symbolic-ref', 'refs/remotes/origin/HEAD'], directory),
    git(['config', 'user.name'], directory),
    git(['status', '--short'], directory),
    git(['log', '-5', '--oneline'], directory),
  ])
  const mainBranch = mainBranchRaw.replace(/^refs\/remotes\/origin\//, '') || 'master'
  return JSON.stringify({
    ide: 'DeepSeek Harness',
    ide_version: '',
    build: '',
    os: `${process.platform},${process.arch}`,
    sign: '123',
    shell: process.env.SHELL ?? process.env.ComSpec ?? 'bash',
    cwd: directory,
    memoryPath: typeof memory?.path === 'string' ? memory.path : '',
    memoryContent: typeof memory?.content === 'string' ? memory.content : '',
    sessionNotesContent: typeof memory?.notes === 'string' ? memory.notes : '',
    repoInfo: {
      current_branch: branch,
      main_branch: mainBranch,
      git_user: user,
      status: status.length > 4000 ? `${status.slice(0, 4000)}\n[已截断]` : status,
      recent_commits: commits,
    },
  })
}

/**
 * DSH's OWN tool names, passed straight through.
 *
 * The system prompt this plugin forwards declares these names (its SDK section
 * and its toolcalling guidance), so the vendor's model may reach for them
 * instead of its own vocabulary. Refusing a name the model just read in its own
 * instructions is what made a live session conclude "I have no way to execute
 * `bash` (or any other tool)" — the call never reached DSH, so nothing was
 * logged anywhere and the model simply gave up.
 *
 * Arguments are forwarded unchanged: a model asking for `bash` read DSH's own
 * declaration, so it sends DSH's own argument names.
 */
export const PASSTHROUGH_TOOL_NAMES = Object.freeze(new Set([
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'present', 'todo_write',
  // Loading a skill is a DSH tool. Without it the vendor's agent can see the
  // skill CATALOG (DSH injects it into the conversation) but has no way to load
  // one — it ends up searching the disk with shell commands instead.
  'skill', 'web_fetch', 'web_search',
  'ask_user_question', 'subagent', 'subagent_fork', SUBAGENT_TOOL_NAME, 'job_list', 'job_output', 'job_kill',
  // A continuable child's DSH prompt tells it to return its result with
  // `send_message({agent_id})`. The name must reach DSH when the vendor sends it
  // to the bridge, or the child has no way to report (see the rules note in
  // src/request.js for the vendor's own SendMessage shadowing it).
  'send_message', 'interrupt_agent', 'list_agents',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
]))
