/**
 * Request construction for `POST /chatbot/v3/task-agent`.
 *
 * The vendor endpoint speaks an AGENT protocol, not a model protocol
 * (design notes §2): two message roles only (`user` / `assistant`), no `system`
 * message, no tool schemas, no image parts. Everything DSH sends has to be
 * projected onto that narrow surface:
 *
 *   - `options.system` (and any system/developer message)  -> the `rules` channel
 *   - user / assistant text                                -> messages, as-is
 *   - tool history from another provider                   -> folded into text
 *   - image / file blocks                                  -> an explicit placeholder
 *
 * The `action: '自由提问'` literal and the `CLI` client shape are taken from the
 * vendor's own CLI, which is the only client whose request body is known to
 * make the server read the user's message. The desktop client's
 * `action: 'action.chat'` with `client`/`server` roles does NOT (measured: the
 * server answered a generic greeting and ignored the instruction).
 *
 * @module src/request
 */

/** Placeholder text for an image part; this route is text-only in v1. */
const IMAGE_NOTE = '[图片已省略：lanagent 路由当前只支持文本输入]'

/** Long tool payloads are folded, not reproduced; the model only needs the gist. */
const FOLD_LIMIT = 2000

/**
 * Proven-good client identity, copied from vendor CLI. The server gates on
 * this value (measured 2026-11-10: v1.0.12 is answered with a text-only block
 * "请将vendor CLI更新到最新版本（至少为1.0.16）" and the turn never reaches a
 * terminal task status; v1.0.16 works, stream shape unchanged).
 */
export const CLIENT_ID = 'CLI'
export const CLIENT_VERSION = '1.0.16'
/** The action that makes the vendor's server treat the message as a real prompt. */
export const ACTION_FREE_QUESTION = '自由提问'

const truncate = (text, limit = FOLD_LIMIT) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…[截断 ${text.length - limit} 字符]`

const safeJson = (value) => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Render one message's content blocks into plain text.
 *
 * @param {unknown} content a DSH message content value (string or block array).
 * @returns {string}
 */
export function renderContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        parts.push(String(block.text ?? ''))
        break
      case 'reasoning':
        // The vendor exposes no reasoning channel of its own; dropping it keeps
        // the projected history identical to what the model actually produced.
        break
      case 'image':
        parts.push(IMAGE_NOTE)
        break
      case 'file':
        parts.push(`[附件已省略：${String(block.attachment?.name ?? 'attachment')}]`)
        break
      case 'tool-call':
        parts.push(`[调用工具 ${String(block.name ?? '')} 参数 ${truncate(safeJson(block.arguments))}]`)
        break
      case 'tool-addition':
      case 'tool-removal':
        break
      default:
        break
    }
  }
  return parts.filter((part) => part.length > 0).join('\n')
}

/**
 * Project DSH history onto the vendor's two-role conversation.
 *
 * Consecutive same-role entries are merged: the vendor's server reads `messages`
 * as a transcript, and two adjacent `user` entries read as two turns. One
 * exception: a user message that directly follows tool results starts a fresh
 * `user` entry — merging it into the `[工具结果 …]` block makes the vendor read
 * the instruction as part of the tool output and refuse it as prompt injection
 * (measured 2026-10-19, DESIGN §30).
 *
 * @param {readonly object[]} messages DSH `GenerateOptions.messages`.
 * @returns {{ conversation: Array<{role: 'user'|'assistant', content: string}>, systemParts: string[] }}
 */
export function projectConversation(messages) {
  const conversation = []
  const systemParts = []
  const push = (role, content) => {
    if (content.length === 0) return
    const last = conversation[conversation.length - 1]
    if (last !== undefined && last.role === role) {
      last.content = `${last.content}\n\n${content}`
      return
    }
    conversation.push({ role, content })
  }
  // Whether the trailing `user` entry was started by a tool result. A user
  // message arriving after tool results is a new user input (a mid-turn splice,
  // or a new turn after an aborted call); merging it into the tool-result block
  // buries the instruction inside what reads as tool output.
  let trailingToolResults = false
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const text = renderContent(message.content)
    switch (message.role) {
      case 'system':
      case 'developer':
        if (text.length > 0) systemParts.push(text)
        break
      case 'assistant':
        push('assistant', text)
        trailingToolResults = false
        break
      case 'tool':
        push('user', `[工具结果 ${String(message.toolCallId ?? '')}]\n${text}`)
        trailingToolResults = true
        break
      case 'user':
      default:
        if (trailingToolResults && text.length > 0) {
          conversation.push({ role: 'user', content: text })
          trailingToolResults = false
        } else {
          push('user', text)
        }
        break
    }
  }
  return { conversation, systemParts }
}

/**
 * Build the `rules` array — the only system-level text channel the vendor honors
 * (measured: a marker instruction placed there is obeyed; a plain string, and
 * the same text in `agents`, are ignored).
 *
 * @param {object} options
 * @param {string} [options.system] DSH's assembled system prompt.
 * @param {string[]} [options.systemParts] system/developer messages from history.
 * @param {'rules'|'none'} [options.systemPromptMode]
 * @param {'light'|'full'} [options.purposePolicy]
 * @param {'compaction'|'session-title'} [options.purpose]
 * @returns {Array<{source: string, content: string}>}
 */
export function buildRules({ system, systemParts = [], systemPromptMode = 'rules', purposePolicy = 'light', purpose, toolboxName = 'dsh_toolbox' } = {}) {
  const rules = []
  if (systemPromptMode === 'rules') {
    // The DSH prompt documents DSH's own tool interface — including a
    // programmatic-transport section that says only `run_code` may be called
    // directly. That is true of DSH's own model, not of this agent: the vendor's
    // agent calls its OWN tools, and the bridge runs them here. Without this
    // note the vendor's model reads a rule about an interface it does not have.
    rules.push({
      source: 'user',
      content: [
        '[lanagent 桥接说明] 上面的 DSH 文档描述的是 DSH 自身模型的工具接口（例如 run_code 与其 SDK 声明）；',
        '请忽略其中"只有 run_code 能直接调用"这一句——那描述的是 DSH 自己的模型，不是你的情形：',
        '你使用的是自己的内置工具，请直接调用它们，不要因为缺少 run_code 或 SDK 而放弃：',
        '命令行 execute_command（等价：bash），读文件 read_files（等价：read），写文件 write_to_file（等价：write），',
        '改文件 replace_in_file（等价：edit），搜索内容 search_files（等价：grep），按名找文件 list_files（等价：glob），',
        'MCP 工具 use_mcp_tool（等价：mcp__<服务器>__<工具>），环境信息 get_environment_info。',
        '这些调用会由 DSH 桥接到真实工作区执行：工作目录、文件读写、命令执行都是真实的，错误信息也会原样返回。',
        '如果某个调用被拒绝，请把返回的错误原文告诉用户，而不是判断"工具没接好"。',
        `本会话还通过 MCP 服务器 ${toolboxName} 暴露了一批 DSH 工具，其中常用的三个是：`,
        `  · skill —— 加载一项"技能"（参数 {"name":"<技能名>"}）。上面技能清单里的名字就是参数值。`,
        '    需要按某项技能操作时请**调用它**，不要用 shell 去磁盘里寻找技能文件（技能目录只有名字与描述，没有路径；',
        '    而且真正的技能目录与相对资源路径只有 skill 工具能正确解析）。',
        '    加载技能请**优先**用上面这条 use_mcp_tool 调用：它返回技能正文，并给出 resourceBase（相对资源目录），',
        '    技能文档里的相对路径（如 scripts/x.py）要靠它才能解析。',
        '    你自带的原生 Skill 工具同样可用（按清单里的 filePath 读本机文件），但只回文件文本、没有 resourceBase；',
        '    两者都失败时把报错原文转达用户，不要用 shell 去猜技能目录。',
        '  · ask_user_question —— 向用户提问（需要用户决策时用它，而不是自己假设答案）。',
        '  · todo_write —— 维护待办清单。',
        `调用方式：use_mcp_tool 且 server_name="${toolboxName}"、tool_name 为上面的工具名、arguments 为它的参数对象。`,
        '你自带的 ask_followup_question 同样可用：它会被桥接成 DSH 的真实提问工具，用户的回答在同一轮里作为该调用的',
        '结果回到你手上，你可以接着干活。**不要**把问题写成纯文本后结束回合——那样这一轮就结束了，用户只能再补一句"继续"。',
        '需要用户确认、选择或补充信息时，请调用 ask_followup_question。',
        '通用原则：技能或说明里要求执行的动作，请用**你被声明的工具**来完成（工具箱里的工具，含 MCP 工具）；',
        '**不要**改用 shell、临时脚本，或自己去找/启动某个驱动来替代一个已经声明给你的工具——那样依赖具体机器上的私有',
        '脚本，既不通用，遇到下一台机器又会失败。只有当确实没有对应工具时，才退回到 shell 等手段。',
        '工具名可带 mcp__<服务器>__ 前缀，也可只写裸名，桥都会解析；不确定有哪些工具时可先向用户说明你要做什么。',
        '工具箱里声明的每一个 MCP 工具都可以直接调用；**不要**因为工具名带前缀、服务器名不同，或此前某个调用失败，',
        '就推断"该服务器未启用/工具不存在"而放弃——这类推断多数是错的。调用失败时请把返回的原文原样转达，',
        '再换一个已声明的工具继续，而不是退回 shell 或自己找驱动。',
        '需要读多个文件时，请在一次 read_files 调用里用 paths 数组给出全部路径（需要搜多处时同理），',
        '桥会把这些调用放在同一步并行执行；分成多次调用会多花一轮往返。',
      ].join(''),
    })
    const body = [system ?? '', ...systemParts].filter((part) => typeof part === 'string' && part.trim().length > 0).join('\n\n')
    if (body.length > 0) rules.push({ source: 'project', content: body })
    // A continuable subagent's DSH prompt ends with "Your parent agent id is
    // <id> … send your result … with send_message({agent_id})". On THIS route
    // that name is the vendor's OWN SendMessage, which addresses vendor *tasks*
    // (it answers "Task <id> not found"), and the vendor executes it itself:
    // the call never reaches the bridge and the child concludes it cannot
    // report (measured 2026-11-11: sessions 45ece381, 5192771e, ba9f5027).
    // Name the route that works, and say that finishing also delivers.
    const parentId = /Your parent agent id is "([^"]+)"/.exec(body)?.[1]
    if (parentId !== undefined) {
      rules.push({
        source: 'user',
        content: [
          '关于把结果交回父代理（本条优先于上面 DSH 提示里的 send_message 指引）：',
          '- 你自带的 SendMessage / send_message 是**厂商任务**工具，参数是厂商任务 id，不是 DSH 代理 id；',
          `  用它给父代理 ${parentId} 发消息会得到 "Task ... not found"，消息不会送达，不要用它。`,
          `- 正确方式：use_mcp_tool，server_name="${toolboxName}", tool_name="send_message", arguments={"agent_id":"${parentId}","message":"..."}。`,
          '  这条走 DSH 自己的代理消息通道，父代理会立刻收到。',
          '- 也可以不调用任何工具：直接把完整结果作为本回合的最后正文结束回合，DSH 会把这段收尾消息作为结算通知交给父代理。',
          '- 两种方式都可以；如果 send_message 返回失败（例如父代理已不在运行），仍以本回合的收尾正文为准。',
        ].join('\n'),
      })
    }
  }
  if (purposePolicy === 'light' && (purpose === 'session-title' || purpose === 'compaction')) {
    // Session titles and compaction summaries are internal calls. Without this
    // the vendor's agent runs its environment preflight and may reach for tools
    // mid-summary; the tool channel stays closed for these calls too.
    rules.push({
      source: 'user',
      content: '这是厂商的内部辅助调用：请只输出被要求的结果文本本身，不要调用任何工具，不要索取更多信息。',
    })
  }
  return rules
}

/**
 * Assemble the complete request body.
 *
 * @param {object} input
 * @param {string} input.token JWT (raw, no Bearer prefix).
 * @param {string} input.user account name.
 * @param {string} input.model model-group id (`glm-5.3`, …).
 * @param {string} input.chatId conversation key; stable per DSH session.
 * @param {string} input.sessionId per-call channel id; the WebSocket path uses it.
 * @param {Array<{role: string, content: string}>} input.conversation
 * @param {Array<{source: string, content: string}>} input.rules
 * @param {Array<object>} [input.skills] skill metadata `{name,description,filePath,whenToUse}`.
 * @param {'yes'|'no'} [input.think]
 * @param {object} [input.mcpServers] declared MCP servers (M2/M3: the DSH toolbox).
 * @returns {object} the JSON body.
 */
export function buildTaskAgentBody({
  token, user, model, chatId, sessionId, conversation, rules, skills = [], think = 'no', mcpServers,
}) {
  return {
    token,
    client: CLIENT_ID,
    version: CLIENT_VERSION,
    user,
    messages: conversation,
    model,
    action: ACTION_FREE_QUESTION,
    session_id: sessionId,
    chat_id: chatId,
    task_id: chatId,
    operation: 'normal',
    mode: 'action',
    think,
    max_messages: 1000000,
    config: {
      mcp_servers: mcpServers ?? {},
      agent_behavior_mode: 'action',
    },
    command: {},
    skills,
    agents: [],
    rules,
    memory: 'yes',
  }
}
