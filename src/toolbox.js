/**
 * The synthetic MCP toolbox.
 *
 * The vendor's model only learns about tool *execution* through its own
 * vocabulary (`execute_command`, `read_files`, …). Everything DSH can do that
 * the vendor has no equivalent for — `mcp__serial__*`, `mcp__claw__*`,
 * `subagent`, `todo_write` — is invisible to it unless we declare it, and the
 * only channel the vendor accepts for a tool list is `config.mcp_servers`
 * (measured in design notes §2: those declarations DO reach the model, and
 * `use_mcp_tool` calls them back over the WebSocket).
 *
 * So this module turns real DSH tool schemas into one declared MCP server. The
 * shape is the vendor's own: `{type:'stdio', command, args, enabled, tools}`
 * where each tool is `{name, description, inputSchema}`. The schemas come from
 * `ctx.tools.schemas(agent)`, which is presentation-agnostic — a `ptc` session
 * still publishes every visible tool here even though the model is shown only
 * `run_code`.
 *
 * Two guards keep the request small and honest: only whitelisted names are
 * published (the vendor pays tokens for every schema), and entries whose
 * parameters are not object JSON Schema are skipped rather than guessed at.
 *
 * @module src/toolbox
 */

/** The declared server name the bridge also recognises in `use_mcp_tool`. */
export const DEFAULT_TOOLBOX_NAME = 'dsh_toolbox'

/**
 * Tools published by default.
 *
 * Measured against a real 86-tool deployment: a broad `mcp__*` list publishes
 * 64 schemas — 46KB, about 11.8K tokens on EVERY request, which nearly doubles
 * the vendor's own per-request cost. This list publishes 14 schemas (~8.2KB,
 * ~2.1K tokens) and keeps only what the vendor agent cannot do by itself:
 * serial hardware, remote hosts over SSH, delegation, and planning. The plain
 * file/command/search tools are left out because the vendor already owns
 * equivalents (`execute_command`, `read_files`, …), and the browser/desktop MCP
 * servers are left out on top of their size — an agent acting through the
 * vendor's server-side loop is the wrong home for driving a real browser.
 *
 * Widen it in the row's config (`mcpToolWhitelist`); `prefix*` matches by prefix.
 */
export const DEFAULT_WHITELIST = Object.freeze([
  // The vendor's agent can ask the DSH user a question; the loop route turns it
  // into the real question UI, and the answer is projected into the session.
  'ask_user_question',
  // The skill loader and the web tools, so the agent can follow a skill instead
  // of guessing (and so "fetch this page / find that PDF" needs no shell).
  'skill', 'web_fetch', 'web_search',
  // Serial: the hardware gap the vendor agent cannot cover itself.
  'mcp__serial__list_ports',
  'mcp__serial__open',
  'mcp__serial__read',
  'mcp__serial__write',
  'mcp__serial__close',
  'mcp__serial__set_control_lines',
  // Remote hosts over SSH (small schemas, real capability).
  'mcp__claw__*',
  // Planning and delegation.
  'subagent',
  'subagent_fork',
  'todo_write',
])

/** Names never published, whatever the whitelist says. */
const NEVER_PUBLISHED = new Set(['run_code'])

/**
 * Whether a tool name matches any whitelist entry (exact, or a `prefix*`).
 *
 * @param {string} name
 * @param {readonly string[]} whitelist
 * @returns {boolean}
 */
export function matchesWhitelist(name, whitelist) {
  for (const entry of whitelist) {
    if (entry === name) return true
    if (entry.endsWith('*') && name.startsWith(entry.slice(0, -1))) return true
  }
  return false
}

/**
 * Normalize a tool's parameters into vendor-ready object JSON Schema.
 *
 * An argument-less tool legitimately carries `{type:'object'}` with no
 * `properties` (measured: `mcp__serial__list_ports`), so that case is completed
 * rather than rejected — the first version of this selector dropped exactly
 * that tool.
 *
 * @param {unknown} parameters
 * @returns {object|undefined} the schema, or undefined when it is not an object schema.
 */
function toInputSchema(parameters) {
  if (parameters === null || typeof parameters !== 'object' || parameters.type !== 'object') return undefined
  if (parameters.properties === undefined) return { ...parameters, properties: {} }
  if (parameters.properties === null || typeof parameters.properties !== 'object') return undefined
  return parameters
}

/**
 * Pick the tool entries to publish.
 *
 * @param {readonly object[]} schemas `ctx.tools.schemas(agent)` output.
 * @param {readonly string[]} whitelist
 * @param {object} [options]
 * @param {number} [options.maxTools] hard cap, so one add-on cannot flood the prompt.
 * @param {{warn?: Function, debug?: Function}} [options.logger]
 * @returns {Array<{name: string, description: string, inputSchema: object}>}
 */
/**
 * Complete a scope-filtered schema list with the whitelist's named entries.
 *
 * `ctx.tools.schemas(agent)` returns the schemas one scope SEES, and MCP tools
 * are registered in nested scopes (one per server) — so a PTC session's list can
 * omit every `mcp__*` tool. The whitelist is the authority for what to publish,
 * so each named entry missing from that list is resolved individually through
 * `tools.get(name, agent)` (documented as presentation-agnostic).
 *
 * Measured: the vendor reported our toolbox as holding only `skill`,
 * `ask_user_question` and `todo_write` — every MCP-backed tool, including the
 * browser tools a skill tells it to use, was silently absent (design notes §27).
 *
 * @param {object} options
 * @param {readonly object[]} options.schemas the scope's visible schemas.
 * @param {readonly string[]} options.whitelist configured names/patterns.
 * @param {(name: string) => object|undefined} [options.get] registry lookup.
 * @returns {object[]} schemas, including the resolved missing entries.
 */
export function completeToolboxSchemas({ schemas, whitelist, get }) {
  const byName = new Map()
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    if (typeof schema?.name === 'string' && schema.name.length > 0) byName.set(schema.name, schema)
  }
  if (typeof get !== 'function') return [...byName.values()]
  for (const entry of Array.isArray(whitelist) ? whitelist : []) {
    const name = String(entry)
    // Patterns still expand from the visible list: a name we cannot guess.
    if (name.length === 0 || name.includes('*') || byName.has(name)) continue
    let definition
    try {
      definition = get(name)
    } catch {
      definition = undefined
    }
    if (definition === undefined || definition === null) continue
    const parameters = definition.parameters ?? definition.inputSchema ?? definition.schema ?? { type: 'object', properties: {} }
    byName.set(name, {
      name,
      description: typeof definition.description === 'string' ? definition.description : '',
      parameters,
    })
  }
  return [...byName.values()]
}

export function selectToolboxTools(schemas, whitelist, { maxTools = 60, logger } = {}) {
  const chosen = []
  const seen = new Set()
  // Iterate the WHITELIST, not the schema list: the cap must drop the operator's
  // tail, never an arbitrary slice of registry order. (Measured: a 24-tool cap over
  // a 32-candidate whitelist silently decided which tools the vendor received, and
  // the browser tools were among the casualties, design notes §27.)
  const available = (Array.isArray(schemas) ? schemas : []).filter((schema) => typeof schema?.name === 'string' && schema.name.length > 0)
  const ordered = []
  const wanted = Array.isArray(whitelist) ? whitelist.map(String) : []
  for (const entry of wanted) {
    if (entry.includes('*')) continue
    const hit = available.find((schema) => schema.name === entry)
    if (hit !== undefined) ordered.push(hit)
  }
  for (const schema of available) {
    if (wanted.some((entry) => entry.includes('*') && matchesWhitelist(schema.name, [entry]))) ordered.push(schema)
  }
  const dropped = []
  for (const schema of ordered) {
    const name = typeof schema?.name === 'string' ? schema.name : ''
    if (name.length === 0 || seen.has(name) || NEVER_PUBLISHED.has(name)) continue
    if (!matchesWhitelist(name, whitelist)) continue
    const inputSchema = toInputSchema(schema.parameters)
    if (inputSchema === undefined) {
      logger?.debug?.(`lanagent: not publishing "${name}" in the toolbox: its parameters are not object JSON Schema`)
      continue
    }
    if (chosen.length >= maxTools) {
      dropped.push(name)
      continue
    }
    seen.add(name)
    chosen.push({
      name,
      description: typeof schema.description === 'string' ? schema.description : '',
      inputSchema,
    })
  }
  if (dropped.length > 0) {
    logger?.warn?.(`lanagent: toolbox cap ${maxTools} dropped ${dropped.length} whitelisted tool(s): ${dropped.join(', ')}`)
  }
  return chosen
}

/**
 * Build the `config.mcp_servers` value for one turn.
 *
 * `command` is only a label: nothing spawns it. The vendor's server asks us to
 * run a tool over the WebSocket and the bridge answers — which is exactly what
 * `use_mcp_tool` means for a server the client already knows how to reach.
 *
 * @param {object} options
 * @param {readonly object[]} options.schemas
 * @param {readonly string[]} [options.whitelist]
 * @param {string} [options.serverName]
 * @param {number} [options.maxTools]
 * @param {{warn?: Function, debug?: Function}} [options.logger]
 * @returns {Record<string, object>} the `mcp_servers` map, empty when nothing qualifies.
 */
export function buildToolboxServers({ schemas, whitelist = DEFAULT_WHITELIST, serverName = DEFAULT_TOOLBOX_NAME, maxTools, logger }) {
  const tools = selectToolboxTools(schemas, whitelist, { maxTools, logger })
  if (tools.length === 0) return {}

  /** The vendor's client requires a stdio-shaped declaration; our bridge executes. */
  const entry = (list) => ({
    type: 'stdio',
    command: 'dsh',
    args: [],
    enabled: true,
    tools: list,
  })

  /**
   * Split `mcp__<server>__<tool>` into its parts.
   *
   * The vendor's client validates `use_mcp_tool`'s `server_name` against the
   * servers it was DECLARED — so a tool published as `mcp__playwright-edge__…`
   * inside `dsh_toolbox` invites the call `{server_name:"playwright-edge"}`,
   * which its client rejects locally as "MCP server isn't enabled" before the
   * request ever reaches us (measured: no audit record at all for the browser
   * call it claimed to make, design notes §27). Publishing one entry per REAL
   * server, with the bare tool names the model expects, makes that natural call
   * valid — and the bridge maps `server + bare tool` back to the DSH name.
   */
  const split = (name) => {
    if (typeof name !== 'string' || !name.startsWith('mcp__')) return undefined
    const parts = name.slice('mcp__'.length).split('__')
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0 ? { server: parts[0], tool: parts[1] } : undefined
  }

  const plain = []
  const grouped = new Map()
  for (const tool of tools) {
    const parts = split(tool?.name)
    if (parts === undefined) { plain.push(tool); continue }
    const list = grouped.get(parts.server) ?? []
    // The declared tool carries the BARE name its server really exposes.
    list.push({ ...tool, name: parts.tool })
    grouped.set(parts.server, list)
  }

  const servers = {}
  if (plain.length > 0) servers[serverName] = entry(plain)
  for (const [server, list] of grouped) servers[server] = entry(list)
  return servers
}
