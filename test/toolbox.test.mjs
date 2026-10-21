/**
 * Offline tests for the synthetic MCP toolbox (`src/toolbox.js`).
 *
 *   node --test test/toolbox.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_TOOLBOX_NAME, buildToolboxServers, completeToolboxSchemas, matchesWhitelist, selectToolboxTools } from '../src/toolbox.js'

const objectSchema = (properties = { command: { type: 'string', description: 'cmd' } }) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
})

const tool = (name, parameters = objectSchema()) => ({ name, description: `${name} tool`, parameters })

test('whitelist matching supports exact names and prefix patterns', () => {
  assert.equal(matchesWhitelist('bash', ['bash']), true)
  assert.equal(matchesWhitelist('bash', ['read']), false)
  assert.equal(matchesWhitelist('mcp__serial__list_ports', ['mcp__*']), true)
  assert.equal(matchesWhitelist('mcp__claw__claw_bash', ['mcp__*']), true)
  assert.equal(matchesWhitelist('subagent', ['mcp__*']), false)
})

test('selection keeps whitelisted tools with real JSON Schema parameters', () => {
  const tools = selectToolboxTools([tool('bash'), tool('read'), tool('plugin_manager')], ['bash', 'read'])
  assert.deepEqual(tools.map((entry) => entry.name), ['bash', 'read'])
  assert.equal(tools[0].description, 'bash tool')
  assert.equal(tools[0].inputSchema.type, 'object')
})

test('run_code is never published, whatever the whitelist says', () => {
  const tools = selectToolboxTools([tool('run_code'), tool('bash')], ['*', 'run_code'])
  assert.deepEqual(tools.map((entry) => entry.name), ['bash'])
})

test('a tool without object JSON Schema parameters is skipped, not guessed at', () => {
  const debug = []
  const tools = selectToolboxTools([tool('odd', { command: { type: 'string' } }), tool('bash')], ['odd', 'bash'], { logger: { debug: (m) => debug.push(m) } })
  assert.deepEqual(tools.map((entry) => entry.name), ['bash'])
  assert.match(debug.join(' '), /odd/)
})

test('an argument-less tool is published with an empty properties map', () => {
  // Measured case: mcp__serial__list_ports declares {type:'object'} with no
  // properties. The first version of this selector dropped it.
  const bare = { name: 'mcp__serial__list_ports', description: 'List ports', parameters: { type: 'object', title: 'EmptyObject' } }
  const tools = selectToolboxTools([bare, tool('bash')], ['mcp__serial__list_ports', 'bash'])
  assert.deepEqual(tools.map((entry) => entry.name), ['mcp__serial__list_ports', 'bash'])
  assert.deepEqual(tools[0].inputSchema.properties, {})
  assert.equal(tools[0].inputSchema.title, 'EmptyObject')
})

test('duplicates and missing names are ignored, and the cap is enforced', () => {
  const many = [tool('a'), tool('a'), { description: 'nameless' }, tool('b'), tool('c'), tool('d')]
  assert.deepEqual(selectToolboxTools(many, ['*'], { maxTools: 3 }).map((entry) => entry.name), ['a', 'b', 'c'])
  const warnings = []
  selectToolboxTools([tool('a'), tool('b')], ['*'], { maxTools: 1, logger: { warn: (m) => warnings.push(m) } })
  assert.match(warnings.join(' '), /cap/)
})

test('the server entry has the shape the vendor accepts', () => {
  const servers = buildToolboxServers({ schemas: [tool('bash'), tool('mcp__serial__list_ports')], whitelist: ['bash', 'mcp__*'] })
  const entry = servers[DEFAULT_TOOLBOX_NAME]
  assert.equal(entry.type, 'stdio')
  assert.equal(entry.enabled, true)
  assert.equal(entry.command, 'dsh')
  // Plain DSH tools stay in the toolbox; MCP-backed ones move to a declaration
  // named after their real server (with the bare tool name).
  assert.deepEqual(entry.tools.map((t) => t.name), ['bash'])
  assert.deepEqual(servers.serial.tools.map((t) => t.name), ['list_ports'])
  assert.deepEqual(Object.keys(servers).sort(), ['dsh_toolbox', 'serial'])
})

test('an empty selection declares no server at all', () => {
  assert.deepEqual(buildToolboxServers({ schemas: [tool('plugin_manager')], whitelist: ['bash'] }), {})
  assert.deepEqual(buildToolboxServers({ schemas: [], whitelist: ['*'] }), {})
})

test('a custom server name is honoured', () => {
  const servers = buildToolboxServers({ schemas: [tool('bash')], whitelist: ['bash'], serverName: 'dsh' })
  assert.deepEqual(Object.keys(servers), ['dsh'])
})

test('the whitelist completes a schema list that omits nested-scope tools', () => {
  // The scope view can lack every MCP tool (they register in nested scopes), so
  // named entries are resolved individually — otherwise the toolbox reaches the
  // vendor without the browser tools a skill tells it to use.
  const visible = [{ name: 'skill', description: 'load a skill', parameters: { type: 'object' } }]
  const registry = new Map([
    ['mcp__playwright-edge__browser_navigate', { description: 'navigate', parameters: { type: 'object', properties: { url: { type: 'string' } } } }],
    ['skill', { description: 'duplicate of the visible one', parameters: { type: 'object' } }],
  ])
  const completed = completeToolboxSchemas({
    schemas: visible,
    whitelist: ['skill', 'mcp__playwright-edge__browser_navigate', 'mcp__serial__*'],
    get: (name) => registry.get(name),
  })
  assert.deepEqual(completed.map((schema) => schema.name), ['skill', 'mcp__playwright-edge__browser_navigate'])
  // The visible definition wins over a second lookup of the same name…
  assert.equal(completed[0].description, 'load a skill')
  // …and a definition without `parameters` still gets a usable object schema.
  const fallback = completeToolboxSchemas({ schemas: [], whitelist: ['x'], get: () => ({ description: 'd' }) })
  assert.deepEqual(fallback[0].parameters, { type: 'object', properties: {} })
  // A throwing or missing lookup never breaks the build.
  assert.deepEqual(completeToolboxSchemas({ schemas: [], whitelist: ['y'], get: () => { throw new Error('nope') } }), [])
})

test('MCP tools are published under their real server, with bare names', () => {
  // The vendor validates `server_name` against the declared servers, so a tool
  // hidden inside the synthetic toolbox made it declare "MCP server isn't
  // enabled" and fall back to shell before the call ever reached the bridge.
  const servers = buildToolboxServers({
    schemas: [
      { name: 'skill', description: 's', parameters: { type: 'object' } },
      { name: 'mcp__playwright-edge__browser_navigate', description: 'n', parameters: { type: 'object' } },
      { name: 'mcp__playwright-edge__browser_click', description: 'c', parameters: { type: 'object' } },
      { name: 'mcp__serial__list_ports', description: 'p', parameters: { type: 'object' } },
    ],
    whitelist: ['skill', 'mcp__playwright-edge__browser_navigate', 'mcp__playwright-edge__browser_click', 'mcp__serial__list_ports'],
    serverName: 'dsh_toolbox',
  })
  assert.deepEqual(Object.keys(servers).sort(), ['dsh_toolbox', 'playwright-edge', 'serial'])
  assert.deepEqual(servers.dsh_toolbox.tools.map((tool) => tool.name), ['skill'])
  assert.deepEqual(servers['playwright-edge'].tools.map((tool) => tool.name), ['browser_navigate', 'browser_click'])
  assert.deepEqual(servers.serial.tools.map((tool) => tool.name), ['list_ports'])
  // Each entry must stay stdio-shaped: the vendor's parser requires it.
  for (const value of Object.values(servers)) assert.equal(value.type, 'stdio')
})
