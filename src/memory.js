/**
 * The vendor's own memory tree, answered by the plugin itself.
 *
 * Why local, in one paragraph: every route through DSH's tools ties these
 * calls to the session sandbox and the agent loop, and both turned the
 * vendor's memory feature into a stream of GUI errors (measured
 * 2026-10-14/15, audit `lan-agent-tool-audit.jsonl`):
 *   - a `write_to_file` under the mapping target was answered with
 *     "[sandbox: file access denied under workspace-write mode]" whenever the
 *     session workspace was not `~/.dsh` — the vendor retried, failed, retried;
 *   - a `read_files` of a not-yet-existing note was parked for the loop, ran
 *     as a `run_code` program, and drew an error card the vendor then retried.
 *
 * The tree is plugin-owned bookkeeping — only paths a mapping redirected reach
 * this module — so it is read and written directly: no DSH tool runs, no card
 * is drawn, no sandbox is consulted, and the answers keep the vendor client's
 * own shapes. The audit record (route "memory-local") is the only trace.
 *
 * A missing file reads as EMPTY CONTENT, not an error: the vendor's agent reads
 * its memory before writing it, so on a fresh tree the truthful answer is
 * "nothing persisted yet" — an error there is what started the retry spiral.
 *
 * @module src/memory
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { applyBlock } from './fuzzy.js'
import { isMappedPath } from './paths.js'
import { parseSearchReplaceBlocks } from './tools.js'

const say = (text) => ({ content: [{ type: 'text', text }] })
const fail = (message, code = -10001) => ({ error: { code, message } })

/** Reads are unbounded in the vendor's own client; clip only the absurd. */
const MAX_READ_BYTES = 512 * 1024

/**
 * One memory file's content.
 *
 * @param {string} file
 * @returns {Promise<string|undefined>} the content; '' when the file has not
 *   been written yet; undefined when the path is a directory (the caller turns
 *   that into the vendor's own error shape).
 */
async function readMemoryFile(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    if (error?.code === 'EISDIR') return undefined
    throw error
  }
}

/** Write with parent creation; the target tree already exists, so a plain
 * recursive mkdir is safe here (the /proc hang in paths.js was about creating
 * ARBITRARY mapping targets at mount time). */
async function writeMemoryFile(path, text, logger) {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
    return undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger?.warn?.(`lanagent: memory write ${path} failed: ${message}`)
    return message
  }
}

/** The vendor client's own replace-failure guidance, so its model can fix the
 * block instead of concluding the tool is broken. */
const replaceGuidance = (reason, nearest) => [
  'SEARCH 块未能在文件中应用。请检查：',
  '1. SEARCH 内容必须与文件完全一致（含空格与缩进）；',
  '2. 如文件使用 CRLF 行尾，SEARCH 块也要一致；',
  '3. 用更多上下文行来唯一定位。',
  `原始错误：${reason}${nearest === undefined ? '' : `（${nearest}）`}`,
].join('\n')

/**
 * Answer one vendor tool call against the mapped memory tree, locally.
 *
 * `undefined` means "not mine": the call then takes its normal route, so files
 * outside the tree keep the sandbox, approval, and loop semantics they always
 * had. Only a request whose every path is inside a mapped tree is answered
 * here (a mixed `read_files` still goes the normal route for the same reason).
 *
 * @param {string} vendorTool
 * @param {object} input the vendor's arguments, ALREADY path-mapped.
 * @param {readonly {from: string, to: string}[]} mappings resolved mappings.
 * @param {{warn?: Function, debug?: Function}} [logger]
 * @returns {Promise<{content?: Array, error?: {code: number, message: string}}|undefined>}
 */
export async function answerMemoryOp(vendorTool, input, mappings, logger) {
  if (!Array.isArray(mappings) || mappings.length === 0) return undefined

  if (vendorTool === 'read_files') {
    const paths = Array.isArray(input?.paths) ? input.paths.map((entry) => String(entry)) : []
    if (paths.length === 0) return undefined
    if (!paths.every((path) => isMappedPath(path, mappings))) return undefined
    const payload = {}
    for (const path of paths) {
      const content = await readMemoryFile(path)
      if (content === undefined) return fail(`read_files: ${path} 是一个目录，不是文件`)
      payload[path] = content.length > MAX_READ_BYTES
        ? `${content.slice(0, MAX_READ_BYTES)}\n[已截断：文件超过 ${MAX_READ_BYTES} 字节]`
        : content
    }
    logger?.debug?.(`lanagent: answered read_files locally (${paths.length} path(s) in the memory tree)`)
    return say(JSON.stringify(payload))
  }

  if (vendorTool === 'write_to_file') {
    const path = String(input?.path ?? '')
    const content = input?.content
    // Missing arguments are the bridge's error to report, and a path outside
    // the tree is a normal write: both fall through.
    if (path.length === 0 || typeof content !== 'string' || !isMappedPath(path, mappings)) return undefined
    const error = await writeMemoryFile(path, content, logger)
    if (error !== undefined) return fail(`write_to_file: 写入 ${path} 失败：${error}`)
    logger?.debug?.(`lanagent: memory write ${path} answered locally (${content.length} bytes)`)
    return say('success')
  }

  if (vendorTool === 'replace_in_file') {
    const path = String(input?.path ?? '')
    if (path.length === 0 || !isMappedPath(path, mappings)) return undefined
    let blocks
    try {
      blocks = parseSearchReplaceBlocks(input?.diff)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    let text = await readMemoryFile(path)
    if (text === undefined) return fail(`replace_in_file: ${path} 是一个目录，不是文件`)
    let fuzzy = 0
    for (const block of blocks) {
      const outcome = applyBlock(text, block.search, block.replace)
      if (outcome.ok !== true) {
        return fail(replaceGuidance(outcome.reason, outcome.nearest))
      }
      if (outcome.exact !== true) fuzzy += 1
      text = outcome.text
    }
    const error = await writeMemoryFile(path, text, logger)
    if (error !== undefined) return fail(`replace_in_file: 写回 ${path} 失败：${error}`)
    return say(fuzzy === 0 ? 'success' : `success（其中 ${fuzzy} 个 SEARCH 块通过与厂商客户端一致的空白容错匹配后应用；文件其余部分未改动）`)
  }

  return undefined
}
