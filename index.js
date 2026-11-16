/**
 * Host half of `@local/dsh-provider-lan-agent`.
 *
 * WHAT THIS IS
 * ------------
 * A DSH model-provider route (`lanagent`) backed by the vendor's `task-agent`
 * endpoint. That endpoint is an AGENT protocol, not a model protocol: the
 * vendor runs the loop server-side and delegates every tool execution back to
 * the client over a WebSocket. So this adapter owns both lanes of one turn:
 *
 *   HTTP  POST /chatbot/v3/task-agent   -> the answer stream (cumulative blocks)
 *   WS    /ws-api/coagent/<session_id>  -> the vendor's tool calls, answered here
 *
 * Every fact in the comments below was measured against the live service; the
 * probe scripts that produced them are archived under `test/probe/`, and
 * design notes holds the full contract table.
 *
 * CURRENT SCOPE (M1)
 * ------------------
 * Authentication, model catalog, request projection, stream decoding, and a
 * tool channel that answers every vendor tool call with an explicit refusal.
 * The refusal is not a placeholder for its own sake: an unanswered call stalls
 * the vendor's turn until the tool's deadline, so the channel answers SOMETHING from
 * the very first version. M2 replaces that handler with real DSH tool execution.
 *
 * @module @local/dsh-provider-lan-agent
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { LanAgentAuth, configValue } from './src/auth.js'
import { LanAgentCatalog, INPUT_MODALITIES } from './src/catalog.js'
import { LanAgentError, FailureCode, isVendorTaskBusy } from './src/errors.js'
import { buildRules, buildTaskAgentBody, projectConversation } from './src/request.js'
import { createJsonStreamParser, createStreamMapper } from './src/stream.js'
import { createAuditWriter } from './src/audit.js'
import { readAuditTail } from './src/auditFeed.js'
import { cliHint, getCliStatus } from './src/subagent/status.js'
import { expandConfigPath } from './src/configPath.js'
import { DispatchMode, createToolDispatcher } from './src/dispatch.js'
import { requestApproval, requiresApproval } from './src/approval.js'
import { LOOP_EXCLUDED, PTC_PROGRAM_MAX_MS, isToolRefusal, linkParkedAbort, looksLikePtcPrompt, outcomesForPlan, withStyle } from './src/loopPlan.js'
import { mapCommandText, mapPath, mapVendorPaths, resolveMappings, VENDOR_MEMORY_ROOT } from './src/paths.js'
import { answerMemoryOp } from './src/memory.js'
import { createLoopRoute, drainWithSuspension, extractToolResults, isLoopContinuation, toolCallChunks, ASK_USER_BUDGET_MS } from './src/loopRoute.js'

/** Backoff between retries of a fresh POST rejected with "-200 上一个任务仍在执行中". */
const VENDOR_BUSY_RETRY_MS = 3000
import { DEFAULT_TOOLBOX_NAME, DEFAULT_WHITELIST, buildToolboxServers, collectMcpToolSchemas, completeToolboxSchemas } from './src/toolbox.js'
import { createToolBridge } from './src/vendor/bridge.js'
import { createDocumentReader } from './src/vendor/documents.js'
import { interpret, render } from './src/vendor/registry.js'
import { collectEnvironment, readMemoryInfo } from './src/tools.js'
import { ToolChannel, createRefusingHandler } from './src/ws.js'

/**
 * Resolve `@deepseek-ai/schemastery` without a bare import.
 *
 * WHY NOT `import z from '@deepseek-ai/schemastery'`
 * --------------------------------------------------
 * A profile install links this package into the profile's `node_modules`, and
 * pnpm does NOT materialize peer dependencies for a linked directory (it warns
 * about exactly this). There is no `@deepseek-ai` anywhere on the resolution
 * path from this file, so a bare import is an `ERR_MODULE_NOT_FOUND` and, with
 * it, the whole entry fails to activate.
 *
 * That is also why the installed third-party providers import NOTHING from
 * `@deepseek-ai/*` (`@mars-sea/dsh-commandcode-provider` has no `node_modules`
 * and no such import at all), and why `dsh-our-free-model` reaches the one
 * package it needs through a lazy, failure-tolerant import.
 *
 * So this follows the same discipline: try the bare specifier first (correct
 * when the bundle is installed from a registry, where pnpm does link peers),
 * then walk up from the running CLI's entry to find the dsh installation's own
 * `node_modules`, and give up quietly when neither works.
 *
 * @returns {Promise<object|undefined>} the schemastery module, when reachable.
 */
async function loadSchemastery() {
  try {
    return await import('@deepseek-ai/schemastery')
  } catch {
    // Fall through to the installation-derived candidates.
  }
  const seeds = [process.argv[1], process.argv[0]].filter((value) => typeof value === 'string' && value.length > 0)
  for (const seed of seeds) {
    let dir = dirname(seed)
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, 'node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs')
      if (existsSync(candidate)) {
        try {
          return await import(pathToFileURL(candidate).href)
        } catch {
          break
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

const schemastery = await loadSchemastery()

/** Stable Cordis plugin name. */
export const name = 'llm-lan-agent'

/** The LLM service is the only hard requirement; everything else is optional. */
export const inject = ['llm']

const DEFAULT_ROUTE = 'lanagent'
/** Same-origin route the settings panel reads the audit tail from. */
const AUDIT_ROUTE = '/lanagent/audit'

/** Same-origin route the settings banner reads the optional CLI state from. */
const CLI_STATUS_ROUTE = '/lanagent/cli'
const DEFAULT_BASE_URL = 'http://10.219.9.56'

/**
 * The vendor's memory tree maps into the session workspace by default.
 *
 * A RELATIVE target is deliberate: it lands inside whatever workspace the
 * session has, which is where the file sandbox allows writes. The real target
 * is resolved per session by `resolveMappings`; nothing here is machine-specific.
 */
const DEFAULT_PATH_MAPPINGS = Object.freeze([{ from: VENDOR_MEMORY_ROOT, to: '.lan-agent-memory' }])

/**
 * Plugin configuration. Credential fields carry `.role('credential-ref')` so the
 * Models settings surface knows they name a credential reference and can offer
 * to write it — the reference itself is never a secret (design notes §5.1.1).
 *
 * Built only when schemastery is reachable; see {@link loadSchemastery}. Without
 * it the row's config is read as a plain object (all defaults still apply), and
 * the credential reference has to be stored from the file or the environment
 * rather than from the settings page.
 *
 * @param {object} z the schemastery module.
 */
function buildConfig(z) {
  return z.object({
    route: z.string().default(DEFAULT_ROUTE).description('Provider route name requests select.'),
    baseURL: z.string().default(DEFAULT_BASE_URL).description('Vendor origin; beta is http://10.219.9.56.'),
    user: z.string().default('').description('Optional plain-config account name. Prefer auth.userRef, which keeps the account out of deployment files; this field is only a fallback.'),
    auth: z.object({
      mode: z.union([z.const('login'), z.const('token')]).default('login')
        .description('login: password -> JWT. token: read an existing JWT and never log in.'),
      userRef: z.string().role('credential-ref').default('LAN_AGENT_USER').volatile(),
      passwordRef: z.string().role('credential-ref').default('LAN_AGENT_PASSWORD').volatile(),
      tokenRef: z.string().role('credential-ref').default('LAN_AGENT_TOKEN').volatile(),
      tokenFile: z.string().default(''),
      loginBackoff: z.object({
        initialMs: z.natural().default(30_000),
        maxMs: z.natural().default(1_800_000),
        maxAttemptsPerHour: z.natural().default(6),
      }).default({ initialMs: 30_000, maxMs: 1_800_000, maxAttemptsPerHour: 6 }),
    }).default({ mode: 'login', userRef: 'LAN_AGENT_USER', passwordRef: 'LAN_AGENT_PASSWORD', tokenRef: 'LAN_AGENT_TOKEN', tokenFile: '' }),
    catalogTtlMs: z.natural().default(21_600_000),
    systemPromptMode: z.union([z.const('rules'), z.const('none')]).default('rules')
      .description('rules: send the DSH system prompt through the vendor rules channel.'),
    thinkMode: z.union([z.const('auto'), z.const('on'), z.const('off')]).default('auto'),
    purposePolicy: z.union([z.const('light'), z.const('full')]).default('light')
      .description('light: session-title/compaction calls run without the tool channel and with a no-tools rule.'),
    toolChannel: z.union([z.const('enabled'), z.const('disabled')]).default('enabled'),
    toolBridge: z.union([z.const('dsh'), z.const('refuse')]).default('dsh')
      .description('dsh: run the vendor\'s tool calls through ctx.tools.execute(). refuse: answer every call with an error.'),
    toolDispatch: z.union([z.const('auto'), z.const('direct'), z.const('run_code')]).default('auto')
      .description('auto: call tools directly, falling back to a run_code program when the session presents PTC. direct/run_code: pin one route.'),
    mcpToolbox: z.union([z.const('enabled'), z.const('disabled')]).default('enabled')
      .description('Publish whitelisted DSH tools to the vendor as one synthetic MCP server.'),
    mcpToolboxName: z.string().default(DEFAULT_TOOLBOX_NAME),
    mcpToolWhitelist: z.array(z.string()).default([...DEFAULT_WHITELIST])
      .description('Names (or prefix*) published to the vendor; it pays tokens for every schema. With mcpToolboxMcpAuto on, MCP tools need no entry here — the loaded servers supply them.'),
    mcpToolboxMaxTools: z.natural().default(24),
    mcpToolboxMcpAuto: z.boolean().default(true)
      .description('Publish every tool of every MCP server DSH has loaded, discovered from the tool registry each turn. false: publish only the manual whitelist.'),
    mcpToolboxMcpDeny: z.array(z.string()).default([])
      .description('Prefixes never published, listed or discovered (for example mcp__playwright-edge__); the toolbox trim when a server\'s schemas are not worth their per-request tokens.'),
    toolExecution: z.union([z.const('loop'), z.const('out-of-band')]).default('loop')
      .description('loop: the agent loop runs the tools (native card, approvals, transcript). out-of-band: the bridge runs them and answers immediately.'),
    loopCallStyle: z.union([z.const('auto'), z.const('native'), z.const('run_code')]).default('auto')
      .description('auto learns per session whether the presentation accepts direct names or only run_code; native/run_code pin it.'),
    loopCollectMs: z.natural().default(40)
      .description('Grace window (ms) for sibling tool requests so co-arriving calls share one agent step.'),
    loopBudgetMs: z.natural().default(360_000)
      .description('CAP for a loop-routed parked call, and the fallback budget when the vendor declares no timeout. The vendor declares 300000ms and its measured ceiling is ~333s, so this must stay above it or our budget preempts the vendor\'s own deadline.'),
    approvalTimeoutMs: z.natural().default(120_000)
      .description('How long an approval request may wait (policy=ask) before the call is refused. Independent of toolTimeoutMs, which used to cut honest slow approvals off at 20s.'),
    pathMappings: z.array(z.object({ from: z.string(), to: z.string() })).default([...DEFAULT_PATH_MAPPINGS])
      .description('Prefix mappings for paths the vendor names in its own world. A relative target is resolved against the session workspace.'),
    requireApprovalFor: z.array(z.string()).default([])
      .description('Vendor tool names that always require approval, on top of the vendor\'s own requires_approval flag.'),
    honorRequiresApproval: z.boolean().default(true)
      .description('Ask the user through the approval seam when the vendor marks a call requires_approval.'),
    toolAuditFile: z.string().default('')
      .description('Optional JSONL path recording every vendor tool request, each turn\'s outcome, and feeding the diagnostics panel. Empty disables it.'),
    toolTimeoutMs: z.natural().default(20_000)
      .description('Deadline for a tool that is actually RUNNING on the out-of-band (bridge) route; the loop route and approval waits have their own budgets.'),
    requestTimeoutMs: z.natural().default(600_000)
      .description('Whole-request deadline. The vendor has measured 282-312s silent gaps, so a 300s deadline used to cut its turns into errors.'),
  })
}

/** Present only when schemastery resolves; `undefined` means "no schema to validate against". */
export const Config = schemastery === undefined ? undefined : buildConfig(schemastery.default ?? schemastery)

/** 16 hex characters, the id shape the vendor's own clients generate. */
const randomId = () => randomBytes(8).toString('hex')

/** Stable 16-hex conversation key derived from a DSH session id. */
function chatIdFor(sessionKey, purpose) {
  const scope = purpose === undefined ? sessionKey : `${sessionKey}#${purpose}`
  return createHash('sha256').update(scope).digest('hex').slice(0, 16)
}

/** Reasoning effort ids that mean "do not think". */
const THINK_OFF = new Set(['', 'off', 'none', 'no', 'disabled', 'minimal'])

/**
 * The adapter: one turn = one HTTP stream plus one tool channel.
 *
 * Deliberately NOT an `LlmAdapter` subclass. The service calls every method
 * below directly (no optional chaining), so this object has to carry the whole
 * surface — but extending the base class would mean importing
 * `@deepseek-ai/dsh-llm`, which a linked bundle cannot resolve (see
 * {@link loadSchemastery}). Implementing the surface structurally keeps the
 * plugin loadable with zero `@deepseek-ai/*` imports, which is exactly what the
 * installed third-party providers do.
 */
class LanAgentAdapter {
  constructor({ route, baseURL, user, auth, catalog, logger, systemPromptMode, thinkMode, purposePolicy, toolChannel, toolTimeoutMs, approvalTimeoutMs, requestTimeoutMs, collectSkills, collectToolbox, createToolHandler, loopRoute, loopMode, loopCallStyle, loopBudgetMs, toolboxName, audit, resolveCwd, resolveTool, availableTools, measurePressure }) {
    this.route = route
    this.baseURL = baseURL.replace(/\/+$/, '')
    this.user = user
    this.auth = auth
    this.catalog = catalog
    this.logger = logger
    this.systemPromptMode = systemPromptMode
    this.thinkMode = thinkMode
    this.purposePolicy = purposePolicy
    this.toolChannel = toolChannel
    this.toolTimeoutMs = toolTimeoutMs
    this.approvalTimeoutMs = approvalTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.collectSkills = collectSkills
    this.collectToolbox = collectToolbox
    this.createToolHandler = createToolHandler
    this.loopRoute = loopRoute
    this.loopMode = loopMode
    this.loopCallStyle = loopCallStyle
    /** learned per session: 'native' until a refusal proves it is a PTC session. */
    this.loopStyle = new Map()
    this.loopBudgetMs = loopBudgetMs
    this.toolboxName = toolboxName
    this.resolveTool = resolveTool
    this.availableTools = availableTools
    this.audit = audit
    this.resolveCwd = resolveCwd
    this.measurePressure = measurePressure
    /** Live turn controllers, aborted on dispose. */
    this.active = new Set()
  }

  providerInfo(provider) {
    return { id: provider, name: 'LAN Agent' }
  }

  /** No provider-owned retry policy: DSH's normal defaults are what we want. */
  providerRetryPolicy() {
    return undefined
  }

  /** No request-image pricing: this route advertises text-only input. */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Image projection added to the `llm` adapter surface in DSH 0.2.1-rc.2.
   *
   * This route advertises text-only input, so no image is ever projected for
   * it; the identity projection below matches the base class default and keeps
   * this duck-typed object structurally complete (the service calls adapter
   * methods without optional chaining).
   *
   * @param {string} _provider
   * @param {string} _model
   * @param {{width: number, height: number, bytes: number}} image
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async listModels(provider) {
    const models = await this.catalog.list()
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
    }))
  }

  async resolveModel(provider, model) {
    const entry = await this.catalog.resolve(model)
    return {
      provider,
      id: model,
      name: entry.name,
      inputModalities: entry.inputModalities ?? INPUT_MODALITIES,
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: entry.maxTokens,
    }
  }

  /**
   * Bind one resolved model to this adapter generation, as the base class does.
   *
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Stream one turn.
   *
   * The generator always ends with exactly one terminal `finish` chunk, as the
   * `llm` service requires: success, vendor failure, transport failure, and
   * cancellation all close the same way.
   *
   * @param {object} options DSH `GenerateOptions`.
   */
  async *stream(options) {
    const purpose = options.purpose
    const light = this.purposePolicy === 'light' && (purpose === 'session-title' || purpose === 'compaction')
    const sessionKey = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : 'anonymous'
    // Parked turns are keyed by session AND purpose. The title/compaction turns
    // run CONCURRENTLY with the interactive one on the same session, and they
    // used to find that turn's parked state through the shared session key —
    // then consume it (answering the vendor from the wrong context and taking
    // over its stream), leaving the interactive turn hung forever (design notes §23).
    const routeKey = purpose === undefined ? sessionKey : `${sessionKey}#${purpose}`
    const chatId = chatIdFor(sessionKey, purpose)
    const sessionId = randomId()

    const controller = new AbortController()
    let timedOut = false
    let timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('lanagent: request timeout'))
    }, this.requestTimeoutMs)
    timeout.unref?.()
    const onAbort = () => {
      controller.abort(options.signal?.reason)
      // A stop must also retire a parked turn right away: the vendor's own task
      // would otherwise keep waiting for a tool result nobody will send, and
      // every fresh POST is rejected with "-200 上一个任务仍在执行中" until some
      // later generate() drops the state (measured 2026-10-19: ~30 s).
      this.loopRoute?.drop(routeKey)
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    this.active.add(controller)

    let channel
    let toolCalls = 0
    let toolExecuted = 0
    /** When this stream started; the turn record's duration is measured from it. */
    const turnStartedAt = Date.now()
    /** Set when this stream parks its turn: the parked state owns the cleanup. */
    let suspended = false
    try {
      // ── A resumed turn: the agent loop ran the tools this stream parked.
      //    Nothing new goes to the vendor; we answer the parked calls and keep
      //    reading the vendor stream that was left open (design notes §21).
      //
      //    Only a call whose last message IS this parked call's tool result is a
      //    continuation. Claiming the parked turn for anything else drops the
      //    user's new text on the floor — it never reaches the projection below,
      //    so the vendor keeps running the old task (design notes §29). `resume()`
      //    clears the parked state, so look BEFORE claiming, not after.
      const parked = this.loopRoute?.peek(routeKey)
      if (parked !== undefined && isLoopContinuation(parked, options.messages)) {
        this.loopRoute.resume(routeKey)
        yield* this.#resumeParked({ parked, options, routeKey, controller })
        return
      }

      // A fresh user turn means any parked turn was abandoned (the user cancelled
      // it, or its step never resumed): cancel it here instead of letting the
      // vendor finish a whole turn nobody will read.
      if (parked !== undefined) {
        this.logger?.warn?.('lanagent: a new turn arrived while a loop-routed call was still parked; abandoning it')
        this.loopRoute.drop(routeKey)
      }

      const { conversation, systemParts } = projectConversation(options.messages)

      // Pick the call style from the prompt itself when it announces a PTC
      // presentation, so the very first call is already correct.
      //
      // `options.system` is NOT enough: dsh-llm documents it as "system prompt
      // text for one-shot callers … loop-built requests leave it undefined", and
      // the agent loop (our only caller in practice) delivers the prompt as a
      // `system` role message instead. Reading only the field is what let PTC
      // sessions keep calling `bash` and get refused four times in a row.
      if (this.loopCallStyle === 'auto' && this.#styleFor(routeKey) !== 'run_code'
        && looksLikePtcPrompt([typeof options.system === 'string' ? options.system : '', ...systemParts].join('\n'))) {
        this.loopStyle.set(routeKey, 'run_code')
        this.logger?.debug?.('lanagent: the prompt presents only run_code; using the generated-program style from the first call')
      }

      const rules = buildRules({
        system: options.system,
        systemParts,
        systemPromptMode: this.systemPromptMode,
        purposePolicy: this.purposePolicy,
        purpose,
        toolboxName: this.toolboxName ?? DEFAULT_TOOLBOX_NAME,
      resolveTool: this.resolveTool,
      availableTools: this.availableTools,
      })
      const skills = light || this.systemPromptMode === 'none' ? [] : await this.collectSkills(sessionId)
      // Auxiliary calls stay light: a title or summary has no business seeing
      // the toolbox (design notes §6, purposePolicy).
      const mcpServers = light ? {} : await this.collectToolbox(sessionKey)
      const think = this.#thinkFor(options.reasoningEffort)

      // A token failure is worth exactly one retry. Replay is only safe while no
      // tool has run: once a tool has produced side effects, a second attempt
      // would repeat them, so the error is reported instead.
      for (let attempt = 0; ; attempt += 1) {
        let streamedAny = false
        try {
          const token = await this.auth.token(controller.signal)
          // The channel opens for auxiliary calls too: the vendor runs its
          // environment preflight on every turn, and an unanswered call costs
          // regardless of what the turn is for. What auxiliary calls lose
          // is the MCP toolbox, not the refusal path.
          if (this.toolChannel === 'enabled') {
            channel = await this.#openChannel(sessionId, token, controller.signal, () => { toolExecuted += 1 }, sessionKey, routeKey, purpose)
          }
          const body = buildTaskAgentBody({
            token, user: this.user, model: options.model, chatId, sessionId, conversation, rules, skills, think, mcpServers,
          })
          this.logger?.debug?.(`lanagent: POST task-agent route=${this.route} model=${options.model} chat=${chatId} session=${sessionId} purpose=${purpose ?? 'chat'}`)

          const holder = {}
          const pump = this.#createPump({
            body,
            controller,
            onToolUse: () => { toolCalls += 1 },
            // The vendor turn's local request pressure. Auxiliary calls (title,
            // compaction) have no assistant settlement of their own, so they leave
            // the sample alone.
            localUsage: purpose === undefined && this.measurePressure !== undefined
              ? () => this.measurePressure(sessionKey, options.tools)
              : undefined,
            // One audit line per finished vendor turn: the finish kind, whether
            // the turn ever showed answer text or called a tool, and how long it
            // took. Without it, an "it stopped by itself" turn left no trace on
            // disk at all (the plugin's logger goes to the host's tty).
            onTerminal: (info) => this.#auditTurn({
              sessionKey,
              purpose,
              model: options.model,
              startedAt: turnStartedAt,
              toolCalls,
              toolExecuted,
              info,
            }),
          }, holder)
          const suspension = this.loopRoute?.arm(routeKey)
          let pendingRead
          let parkedHere = false
          for await (const chunk of drainWithSuspension({
            pump,
            suspension: suspension === undefined ? new Promise(() => {}) : suspension.promise,
            onSuspend: (pending) => { pendingRead = pending; parkedHere = true },
          })) {
            streamedAny = true
            yield chunk
          }
          if (parkedHere && suspension !== undefined) {
            // The turn is now owned by the parked state: stop following this
            // stream's deadline (the parked budget takes over) and keep the
            // vendor stream and the tool channel alive. The turn's CANCELLATION
            // stays wired: a stop while parked must kill the stream and retire
            // the parked state at once — detaching it made a stop wait for the
            // vendor's next park point (measured 2026-10-19: 15 s of delay).
            clearTimeout(timeout)
            const state = this.loopRoute.suspend(routeKey, {
              pump,
              pendingRead,
              mapper: holder.mapper,
              controller,
              cancel: () => controller.abort(new Error('lanagent: parked turn abandoned')),
              release: async () => {
                options.signal?.removeEventListener?.('abort', onAbort)
                clearTimeout(timeout)
                this.active.delete(controller)
                await channel?.close()
              },
            })
            suspended = true
            for (const chunk of this.#emitToolCalls(state, holder.mapper)) yield chunk
          }
          return
        } catch (error) {
          const isAuth = error instanceof LanAgentError && error.code === FailureCode.unauthorized
          if (isAuth && attempt === 0 && toolExecuted === 0 && !controller.signal.aborted) {
            this.logger?.warn?.('lanagent: the vendor rejected the JWT; re-authenticating and replaying the turn once')
            this.auth.invalidate()
            await channel?.close()
            channel = undefined
            continue
          }
          // The vendor's previous task for this chat is still finishing (it gets
          // answered as soon as the aborted turn's parked state is dropped, and
          // wraps up within seconds). Nothing has streamed, so replaying is safe.
          if (isVendorTaskBusy(error) && attempt < 4 && !streamedAny && toolExecuted === 0 && !controller.signal.aborted) {
            this.logger?.warn?.(`lanagent: the vendor's previous task is still finishing; retrying in ${VENDOR_BUSY_RETRY_MS}ms (${attempt + 1}/4)`)
            await channel?.close()
            channel = undefined
            await new Promise((resolve) => setTimeout(resolve, VENDOR_BUSY_RETRY_MS))
            if (controller.signal.aborted) throw error
            continue
          }
          throw error
        }
      }
    } catch (error) {
      const turnInfo = (kind, failure) => ({
        reason: { kind, failure },
        message: failure?.message,
        sawAnswerText: undefined,
        sawToolCalls: undefined,
      })
      if (timedOut) {
        const failure = new LanAgentError(
          `lanagent: the turn exceeded the ${Math.round(this.requestTimeoutMs / 1000)}s request timeout`,
          { code: FailureCode.network },
        )
        this.logger?.warn?.(`lanagent: ${failure.message}`)
        this.#auditTurn({
          sessionKey, purpose, model: options.model, startedAt: turnStartedAt, toolCalls, toolExecuted,
          info: turnInfo('error', failure.toFailure()),
        })
        yield { type: 'finish', reason: { kind: 'error', failure: failure.toFailure() } }
      } else if (controller.signal.aborted && !(error instanceof LanAgentError)) {
        const failure = new LanAgentError('lanagent: the turn was cancelled', { code: FailureCode.network }).toFailure()
        this.#auditTurn({
          sessionKey, purpose, model: options.model, startedAt: turnStartedAt, toolCalls, toolExecuted,
          info: turnInfo('aborted', failure),
        })
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure,
          },
        }
      } else {
        const failure = error instanceof LanAgentError
          ? error
          : new LanAgentError(`lanagent: ${error instanceof Error ? error.message : String(error)}`, {
            code: FailureCode.network,
            cause: error,
          })
        this.logger?.warn?.(`lanagent: turn failed (${failure.code}): ${failure.message}`)
        this.#auditTurn({
          sessionKey, purpose, model: options.model, startedAt: turnStartedAt, toolCalls, toolExecuted,
          info: turnInfo('error', failure.toFailure()),
        })
        yield { type: 'finish', reason: { kind: 'error', failure: failure.toFailure() } }
      }
    } finally {
      if (!suspended) {
        clearTimeout(timeout)
        options.signal?.removeEventListener?.('abort', onAbort)
        this.active.delete(controller)
        this.logger?.debug?.(
          `lanagent: turn closed (tool calls asked=${toolCalls}, executed=${toolExecuted}, channel=${channel === undefined ? 'none' : channel.calls})`,
        )
        await channel?.close()
      }
    }
  }

  /**
   * End the assistant message with the tool calls the agent loop must run.
   *
   * The call ids are `<vendor block id>:<plan slot>`, so the results coming back
   * on the next step map straight onto the plan without guessing.
   */
  *#emitToolCalls(state, mapper) {
    let index = mapper?.nextBlockIndex?.() ?? 0
    for (const call of state.calls) {
      const transport = call.plan.transportCalls ?? call.plan.calls
      for (const planned of transport) {
        const callId = `${call.baseCallId}:${planned.key}`
        call.ids.set(planned.key, callId)
        for (const chunk of toolCallChunks({ callId, name: planned.dshTool, arguments: planned.arguments, index })) {
          yield chunk
        }
        index += 1
      }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  /** One resumed step: answer the parked vendor calls, then keep the stream. */
  async *#resumeParked({ parked, options, routeKey, controller }) {
    const wanted = parked.calls.flatMap((call) => [...call.ids.values()])
    const results = extractToolResults(options.messages, wanted)
    const cwd = this.resolveCwd?.(routeKey.split('#')[0])
    let reparked = false
    // True when this step handed the parked turn on again (re-park): the channel
    // and the stream belong to the NEXT step then, so the finally must not
    // release them. (While release was accidentally always undefined this
    // finally was a no-op; wiring it through made the misplaced call close a
    // channel the next step still needs.)
    let handedOn = false
    for (const call of parked.calls) {
      clearTimeout(call.timer)
      const plan = call.plan
      const outcomes = outcomesForPlan(plan, results, call.ids)
      if (call.answered) {
        // The budget already answered this call. The loop's result still arrives
        // here — record it, or "parked and never resumed" stays indistinguishable
        // from "executed too late to matter" (design notes §28).
        const answer = render(plan, outcomes, { cwd })
        this.audit?.({
          name: call.vendorTool,
          args: plan.mappedArguments ?? plan.calls[0]?.arguments,
          ok: answer.error === undefined && !String(answer.content?.[0]?.text ?? '').includes('未完成'),
          route: 'loop-late',
          requestId: plan.requestId,
          event: 'settled',
          dshTool: plan.calls.map((planned) => planned.dshTool).join(','),
          detail: `结果在预算到期后才返回（${Date.now() - (call.parkedAt ?? Date.now())}ms）`,
          ...answer.error === undefined
            ? { summary: String(answer.content?.[0]?.text ?? '').slice(0, 240) }
            : { detail: `迟到且失败：${answer.error.message}` },
        })
        continue
      }
      // A PTC session presents only `run_code`, so the first native-style call
      // comes back as an unknown-tool refusal. Learn that and hand the SAME plan
      // over as a generated program: no re-interpretation, no second file read.
      const outer = plan.style === 'run_code'
        ? results.get(String(call.ids.get(plan.transportCalls[0].key)))
        : undefined
      const refused = plan.style === 'run_code'
        ? isToolRefusal(outer ?? { text: '', isError: true })
        : plan.calls.some((planned) => isToolRefusal(outcomes.get(planned.key)))
      const attempts = call.attempts ?? 1
      if (attempts < 2 && call.vendorArgs !== undefined && refused) {
        const nextStyle = plan.style === 'run_code' ? 'native' : 'run_code'
        const spent = Date.now() - (call.parkedAt ?? Date.now())
        const budgetMs = Math.max(15_000, (call.budgetMs ?? 360_000) - spent)
        // The retry's program envelope gets the REMAINING budget, not the
        // original one, so a PTC session cannot run the call twice over.
        const replan = withStyle(plan, nextStyle, { timeoutMs: budgetMs })
        this.loopStyle.set(routeKey, nextStyle)
        this.logger?.warn?.(`lanagent: ${call.vendorTool} was refused by the presentation; re-running it with the ${nextStyle} style`)
        this.loopRoute.park(routeKey, {
          ...call,
          plan: replan,
          attempts: attempts + 1,
          budgetMs,
        })
        reparked = true
        continue
      }
      if (attempts >= 2 && refused) {
        // Both styles were refused: stop retrying and tell the agent's model the
        // truth, instead of feeding it a refusal as if it were a tool result.
        this.logger?.warn?.(`lanagent: ${call.vendorTool} is refused in every call style this session offers; reporting the refusal`)
      }
      call.answered = true
      const shaped = render(plan, outcomes, { cwd })
      const summary = shaped.content?.[0]?.text ?? ''
      this.audit?.({
        name: call.vendorTool,
        args: plan.mappedArguments ?? plan.calls[0]?.arguments,
        ok: shaped.error === undefined,
        route: 'loop',
        requestId: plan.requestId,
        event: 'settled',
        dshTool: plan.calls.map((planned) => planned.dshTool).join(','),
        durationMs: Date.now() - (call.parkedAt ?? Date.now()),
        ...shaped.error === undefined
          ? { summary: summary.length <= 240 ? summary : `${summary.slice(0, 240)}…` }
          : { detail: shaped.error.message },
      })
      this.logger?.debug?.(
        `lanagent: loop route answered ${call.vendorTool} with ${shaped.error === undefined ? 'a result' : 'an error'}`,
      )
      call.respond(shaped)
    }
    if (reparked) {
      // Still suspended, one step later: emit the new calls and keep the vendor
      // stream open. The release stays deferred to the step that finishes it.
      handedOn = true
      const state = this.loopRoute.suspend(routeKey, { pump: parked.pump, pendingRead: parked.pendingRead, mapper: parked.mapper, cancel: parked.cancel, release: parked.release })
      for (const chunk of this.#emitToolCalls(state, parked.mapper)) yield chunk
      return
    }
    // The parked pump belongs to the OLD controller; the resuming step's
    // deadline lives on the NEW one. Link them, or a silent vendor stream has
    // no deadline and the session hangs forever (measured: a 60s tool timeout
    // was answered, then the next step never produced another event).
    const unlinkAbort = linkParkedAbort(controller?.signal, () => parked.cancel?.())
    try {
      if (parked.mode === 'draining') await parked.drainPromise
      if (parked.mode === 'drained') {
        // The vendor's budget ran out while the loop was still working, so the
        // parked stream was already drained in the background: replay it.
        for (const chunk of parked.buffer) yield chunk
        return
      }
      const suspension = this.loopRoute.arm(routeKey)
      let pendingRead
      for await (const chunk of drainWithSuspension({
        pump: parked.pump,
        suspension: suspension.promise,
        resumeWith: parked.pendingRead,
        onSuspend: (pending) => { pendingRead = pending },
      })) {
        yield chunk
      }
      if (pendingRead !== undefined) {
        handedOn = true
        const state = this.loopRoute.suspend(routeKey, { pump: parked.pump, pendingRead, mapper: parked.mapper, cancel: parked.cancel, release: parked.release })
        for (const chunk of this.#emitToolCalls(state, parked.mapper)) yield chunk
      }
    } finally {
      unlinkAbort()
      if (!handedOn) await parked.release?.()
    }
  }

  /**
   * Keep reading a parked vendor stream whose budget expired.
   *
   * The vendor was answered with a timeout error, so its turn continues on its
   * own; draining it here means the next step can still deliver that answer
   * instead of dropping it — the alternative is losing a whole vendor turn.
   */
  #drainParked(routeKey) {
    const parked = this.loopRoute?.peek(routeKey)
    if (parked === undefined || parked.mode !== 'live') return
    parked.mode = 'draining'
    parked.drainPromise = (async () => {
      try {
        for await (const chunk of drainWithSuspension({
          pump: parked.pump,
          suspension: new Promise(() => {}),
          resumeWith: parked.pendingRead,
        })) {
          parked.buffer.push(chunk)
        }
      } catch (error) {
        this.logger?.warn?.(`lanagent: draining the parked vendor stream failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      parked.mode = 'drained'
    })()
  }

  /**
   * One audit line per finished vendor turn.
   *
   * The audit file used to carry only tool requests, so a turn that ended
   * without an answer left no trace anywhere: `logger.warn` goes to the host's
   * stdout, which is a tty in a GUI deployment. This record carries the finish
   * kind, whether the turn ever showed answer text, whether it called a tool, and
   * how long it ran — enough to tell a real stop from the three failure shapes
   * `src/stream.js` now reports, without replaying the session log.
   *
   * @param {object} input
   * @param {string} input.sessionKey the DSH session.
   * @param {string} [input.purpose] `session-title`/`compaction` for auxiliary calls.
   * @param {string} [input.model]
   * @param {number} input.startedAt
   * @param {number} input.toolCalls
   * @param {number} input.toolExecuted
   * @param {object} input.info from the stream mapper (or a synthesized reason).
   */
  #auditTurn({ sessionKey, purpose, model, startedAt, toolCalls, toolExecuted, info }) {
    if (this.audit === undefined) return
    const kind = info?.reason?.kind ?? 'unknown'
    const message = typeof info?.message === 'string'
      ? info.message
      : info?.reason?.failure?.message
    try {
      this.audit({
        name: 'turn',
        args: {
          session: sessionKey,
          purpose: purpose ?? 'chat',
          model,
          finish: kind,
          ...info?.sawAnswerText === undefined ? {} : { answerText: info.sawAnswerText === true },
          ...info?.sawToolCalls === undefined ? {} : { hadToolCall: info.sawToolCalls === true },
        },
        ok: kind === 'stop' || kind === 'max-tokens',
        route: 'turn',
        durationMs: Date.now() - startedAt,
        dshTool: `calls=${toolCalls} executed=${toolExecuted}`,
        ...typeof message === 'string' && message.length > 0 ? { detail: message } : {},
      })
    } catch (error) {
      this.logger?.warn?.(`lanagent: recording the turn outcome failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Turn one HTTP attempt into a resumable generator of DSH chunks. */
  #createPump({ body, controller, onToolUse, localUsage, onTerminal }, holder) {
    const logger = this.logger
    const run = async function* run() {
      const response = await fetch(`${this.baseURL}/chatbot/v3/task-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: body.token },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        throw new LanAgentError(`lanagent: task-agent answered HTTP ${response.status}`, {
          code: FailureCode.network,
          status: response.status,
        })
      }
      const parser = createJsonStreamParser()
      const mapper = createStreamMapper({
        logger,
        onToolUse: (block) => onToolUse?.(block),
        localUsage,
        onTerminal,
      })
      holder.mapper = mapper
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          for (const object of parser(decoder.decode(value, { stream: true }))) {
            for (const chunk of mapper.mapObject(object)) yield chunk
          }
        }
      } finally {
        reader.releaseLock?.()
      }
      for (const chunk of mapper.end()) yield chunk
    }
    return run.call(this)
  }

  /** The vendor's `think` flag is a boolean, so an effort id only picks a side. */
  #thinkFor(effort) {
    if (this.thinkMode === 'on') return 'yes'
    if (this.thinkMode === 'off') return 'no'
    const id = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
    return THINK_OFF.has(id) ? 'no' : 'yes'
  }

  /** The call style learned (or pinned) for one session. */
  #styleFor(sessionKey) {
    return this.loopStyle.get(sessionKey) ?? 'native'
  }

  /** Everything the tool handler needs to park a call for the agent loop. */
  #loopContext(routeKey, purpose) {
    if (this.loopRoute === undefined || this.loopMode !== 'loop') return undefined
    // Auxiliary turns (session title, compaction) must not park tool calls: they
    // exist to summarize, they never inject the toolbox, and a parked turn would
    // leave a half-finished vendor stream behind a summary (design notes §23).
    if (purpose !== undefined) {
      this.logger?.debug?.(`lanagent: purpose=${purpose} stays out of the loop route`)
      return undefined
    }
    return {
      route: this.loopRoute,
      sessionKey: routeKey,
      mode: this.loopMode,
      toolboxName: this.toolboxName ?? DEFAULT_TOOLBOX_NAME,
      resolveTool: this.resolveTool,
      availableTools: this.availableTools,
      styleFor: () => (this.loopCallStyle === 'auto' ? this.#styleFor(routeKey) : this.loopCallStyle),
      budgetMs: this.loopBudgetMs ?? 360_000,
      onBudgetExhausted: () => this.#drainParked(routeKey),
    }
  }

  /**
   * Open the turn's tool channel, or degrade with a warning.
   *
   * The handler is the whole difference between M1 and M2: M2 routes the
   * vendor's calls into `ctx.tools.execute()`, M1 refused them.
   *
   * @param {string} channelId per-turn channel id (the WebSocket path).
   * @param {string} token JWT carried inside every frame.
   * @param {AbortSignal} signal the turn's signal.
   * @param {() => void} onExecuted counts real tool executions, so a replayed
   *   turn never repeats a side effect.
   * @param {string} dshSessionId the DSH session this turn belongs to. It is NOT
   *   the channel id: tool dispatch resolves the initiating Agent and its
   *   workspace by this id, and a random channel id resolves to no agent at all
   *   — which silently drops the call into the default tool scope (where a
   *   `ptc` presentation refuses everything, `run_code` included).
   */
  async #openChannel(channelId, token, signal, onExecuted, dshSessionId, routeKey, purpose) {
    const url = `${this.baseURL.replace(/^http/, 'ws')}/ws-api/coagent/${channelId}`
    const handler = this.createToolHandler === undefined
      ? createRefusingHandler(this.logger)
      : this.createToolHandler({ sessionId: dshSessionId, turnSignal: signal, onExecuted, loop: this.#loopContext(routeKey, purpose) })
    try {
      return await new ToolChannel({
        url,
        token,
        logger: this.logger,
        handler,
      }).open({ signal })
    } catch (error) {
      this.logger?.warn?.(
        `lanagent: tool channel unavailable (${error instanceof Error ? error.message : String(error)}); the vendor's tool calls will time out instead of being refused`,
      )
      return undefined
    }
  }

}

/**
 * Mount the route.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config validated plugin configuration.
 */
export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const route = String(configValue(config, 'route', DEFAULT_ROUTE))
  const baseURL = String(configValue(config, 'baseURL', DEFAULT_BASE_URL))
  const user = String(configValue(config, 'user', ''))
  const authConfig = configValue(config, 'auth', {})
  const authMode = configValue(authConfig, 'mode', 'login')
  const backoff = configValue(authConfig, 'loginBackoff', {})
  const catalogTtlMs = Number(configValue(config, 'catalogTtlMs', 21_600_000))
  const requestTimeoutMs = Number(configValue(config, 'requestTimeoutMs', 600_000))
  const toolTimeoutMs = Number(configValue(config, 'toolTimeoutMs', 20_000))
  const approvalTimeoutMs = Number(configValue(config, 'approvalTimeoutMs', 120_000))
  const toolBridgeMode = String(configValue(config, 'toolBridge', 'dsh'))
  const toolExecutionMode = String(configValue(config, 'toolExecution', 'loop'))
  const loopBudgetMs = Number(configValue(config, 'loopBudgetMs', 360_000))
  const loopCallStyle = String(configValue(config, 'loopCallStyle', 'auto'))
  const loopCollectMs = Number(configValue(config, 'loopCollectMs', 40))
  // `loopBudgetMs` is a CAP, not just a fallback: a parked call must never
  // outlive our own bound, whatever timeout the vendor declares. It sits above
  // the vendor's measured ~333s ceiling on purpose, so the cap only ever bounds
  // a turn the vendor itself has given up on. The env override exists so one
  // instance can be tested without touching the shared config.
  const loopBudgetCapMs = (() => {
    const fromEnv = Number(process.env.DSH_LAN_AGENT_LOOP_BUDGET_MS)
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
    const configured = Number(configValue(config, 'loopBudgetMs', 360_000))
    return Number.isFinite(configured) && configured > 0 ? configured : 360_000
  })()
  // The `run_code` envelope must outlive the call it carries. DSH's program
  // default is 120s and the deadline covers nested waits, so a bridged LONG call
  // died at two minutes whatever budget was parked for it (measured: a 300s
  // command wrapped in run_code ended "execution deadline reached (120000ms)").
  // Ask for the larger of our own budgets; DSH clamps it to its 600s ceiling.
  const programTimeoutMs = Math.min(PTC_PROGRAM_MAX_MS, Math.max(loopBudgetCapMs, ASK_USER_BUDGET_MS))
  const pathMappings = Array.isArray(configValue(config, 'pathMappings', [...DEFAULT_PATH_MAPPINGS])) ? configValue(config, 'pathMappings', [...DEFAULT_PATH_MAPPINGS]) : [...DEFAULT_PATH_MAPPINGS]
  const honorRequiresApproval = configValue(config, 'honorRequiresApproval', true) !== false
  // The environment override exists so one instance can be tested without
  // changing the shared profile config every other instance reads.
  const requireApprovalFor = (() => {
    const fromEnv = typeof process.env.DSH_LAN_AGENT_REQUIRE_APPROVAL === 'string' && process.env.DSH_LAN_AGENT_REQUIRE_APPROVAL.trim().length > 0
      ? process.env.DSH_LAN_AGENT_REQUIRE_APPROVAL.split(',').map((name) => name.trim()).filter((name) => name.length > 0)
      : undefined
    if (fromEnv !== undefined) return fromEnv
    const configured = configValue(config, 'requireApprovalFor', [])
    return Array.isArray(configured) ? configured.map(String) : []
  })()
  /**
   * Resolve a bare MCP tool name the way the vendor names it.
   *
   * The vendor splits an MCP tool into its server and a bare tool name, while our
   * synthetic toolbox publishes DSH's own names (MCP-backed tools keep their
   * `mcp__<server>__<tool>` prefix). Without this, a skill that tells the model to
   * use `browser_navigate` dies with "tools.browser_navigate is not a function"
   * (measured, design notes §27).
   */
  const toolboxBaseTools = (() => {
    const configured = configValue(config, 'mcpToolWhitelist', undefined)
    const list = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_WHITELIST
    return list.map(String)
  })()
  // Read these BEFORE the first name filter: the deny helper is called while
  // building `toolboxTools` below, and a `const` read before its initializer
  // throws a temporal-dead-zone ReferenceError at mount.
  const mcpToolboxMcpAuto = configValue(config, 'mcpToolboxMcpAuto', true) !== false
  const mcpToolboxMcpDeny = (() => {
    const configured = configValue(config, 'mcpToolboxMcpDeny', [])
    return Array.isArray(configured) ? configured.map(String).filter((prefix) => prefix.length > 0) : []
  })()
  /** A name the operator excluded from the toolbox, listed or discovered. */
  const isDeniedToolboxName = (name) => mcpToolboxMcpDeny.some((prefix) => String(name).startsWith(prefix))
  /**
   * The live list of tools the vendor may name.
   *
   * Mutated IN PLACE on purpose: `availableTools` and `resolveTool` below hand
   * this very array to the rules builder and the loop route, so auto-discovered
   * MCP tools become nameable without threading a new value through them.
   * Configured entries keep their positions; discovered names are appended, so
   * a bare-name suffix clash resolves the operator's own entry first.
   */
  const toolboxTools = toolboxBaseTools.filter((name) => !isDeniedToolboxName(name))
  const refreshToolboxTools = (mcpNames) => {
    if (!mcpToolboxMcpAuto) return
    const next = toolboxBaseTools.filter((name) => !isDeniedToolboxName(name))
    const seen = new Set(next)
    for (const name of Array.isArray(mcpNames) ? mcpNames : []) {
      const text = String(name ?? '')
      if (text.length === 0 || seen.has(text)) continue
      seen.add(text)
      next.push(text)
    }
    toolboxTools.splice(0, toolboxTools.length, ...next)
  }
  const resolveToolboxTool = (name) => {
    const wanted = String(name ?? '')
    if (wanted.length === 0) return undefined
    if (toolboxTools.includes(wanted)) return wanted
    const suffix = `__${wanted}`
    const matches = toolboxTools.filter((entry) => entry.startsWith('mcp__') && entry.endsWith(suffix))
    return matches.length === 1 ? matches[0] : undefined
  }

  /** One mapping function shared by both execution routes (design notes §23). */
  const mapVendorPath = (path) => mapPath(path, pathMappings)

  /** Cross-stream rendezvous for the loop execution route (design notes §21). */
  const loopRoute = createLoopRoute({ logger, defaultBudgetMs: loopBudgetMs, collectMs: loopCollectMs })
  const toolDispatchMode = String(configValue(config, 'toolDispatch', DispatchMode.auto))
  const mcpToolboxMode = String(configValue(config, 'mcpToolbox', 'enabled'))
  const mcpToolboxName = String(configValue(config, 'mcpToolboxName', DEFAULT_TOOLBOX_NAME))
  const mcpToolboxMaxTools = Number(configValue(config, 'mcpToolboxMaxTools', 60))
  const mcpToolWhitelist = configValue(config, 'mcpToolWhitelist', [...DEFAULT_WHITELIST])
  // `~` and `$DSH_HOME` are understood so a row need not spell a machine home.
  const toolAuditFile = expandConfigPath(configValue(config, 'toolAuditFile', ''))
  /** One line per vendor tool request; without it a refused name leaves no trace. */
  const audit = toolAuditFile.length === 0 ? undefined : createAuditWriter(toolAuditFile, { logger })
  /** Remembered dispatch route per session: PTC sessions pay the refusal once. */
  const dispatchRoutes = new Map()
  /**
   * The credentials service is looked up PER OPERATION, never captured here.
   *
   * This plugin mounts before the credentials service is necessarily
   * registered, and `ctx.get()` answered at mount time would freeze that
   * `undefined` for the life of the fiber — which is exactly how the first live
   * run failed with MISSING_CREDENTIAL while the credential store was correct
   * and every other provider resolved fine. The seam also requires re-reading
   * per operation, so a rotated secret reaches the next request.
   */
  const credentialsService = () => ctx.get('credentials')

  /**
   * Tool-bridge capabilities, reached two ways on purpose.
   *
   * PRIMARY: `ctx.get(name)` at the moment a turn needs it. The installed
   * third-party providers resolve `credentials` exactly this way from a fiber
   * that only injects `llm`, so the lookup is not restricted to declared
   * services — and looking it up per turn cannot freeze a service that
   * registers later (the bug that made the first live run fail).
   *
   * FALLBACK: nested `ctx.inject` holders, for a composition where the service
   * lives in a scope the direct lookup cannot see. These are split so that a
   * missing optional service (`agents`, `sessions`) cannot keep the essential
   * `tools` holder from activating — a silent degradation to "refuse
   * everything" would be worse than a loud one.
   *
   * @type {{tools?: object, agents?: object, sessions?: object}}
   */
  const injected = {}
  const injectInto = (services, apply) => {
    if (typeof ctx.inject !== 'function') return
    ctx.inject(services, (scoped) => { apply(scoped) })
  }
  injectInto(['tools'], (scoped) => { injected.tools = scoped.tools ?? scoped.get?.('tools') })
  injectInto(['agents'], (scoped) => { injected.agents = scoped.get?.('agents') })
  injectInto(['sessions'], (scoped) => { injected.sessions = scoped.get?.('sessions') })
  const lookup = (name) => {
    const direct = ctx.get?.(name)
    if (direct !== undefined) return { service: direct, source: 'direct' }
    const fallback = injected[name]
    return fallback === undefined ? { service: undefined, source: 'none' } : { service: fallback, source: 'injected' }
  }

  const auth = new LanAgentAuth({
    baseURL,
    user,
    mode: authMode,
    userRef: String(configValue(authConfig, 'userRef', 'LAN_AGENT_USER')),
    passwordRef: String(configValue(authConfig, 'passwordRef', 'LAN_AGENT_PASSWORD')),
    tokenRef: String(configValue(authConfig, 'tokenRef', 'LAN_AGENT_TOKEN')),
    tokenFile: String(configValue(authConfig, 'tokenFile', '')),
    backoff: {
      initialMs: configValue(backoff, 'initialMs', 30_000),
      maxMs: configValue(backoff, 'maxMs', 1_800_000),
      maxAttemptsPerHour: configValue(backoff, 'maxAttemptsPerHour', 6),
    },
    credentials: credentialsService,
    logger,
  })

  /**
   * The vendor's catalog endpoints joined the authenticated surface on
   * 2026-11-10 (measured: a bare GET is answered with code -106
   * "token不存在，请登录" under HTTP 200, which the old unauthenticated fetch
   * turned into the static fallback forever). The fetch wrapper resolves a JWT
   * per call through the same auth object the turns use, so a rotated token
   * reaches the next catalog refresh without a restart. Failures (including a
   * missing credential) still degrade to the static fallback inside the catalog.
   */
  const catalog = new LanAgentCatalog({
    baseURL,
    ttlMs: catalogTtlMs,
    logger,
    fetchImpl: async (url, init = {}) => {
      const token = await auth.token(init.signal)
      return await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: token } })
    },
  })

  /**
   * Skill metadata for the vendor's `skills` channel. It carries names and
   * descriptions only — never skill bodies, which is also all the vendor's own
   * client sends. Any shape surprise degrades to an empty list rather than
   * failing a turn.
   */
  /**
   * Skill metadata for the vendor's own `skills` channel.
   *
   * That channel is what lets the vendor's native `load_skill` resolve a skill
   * NAME to a path: the desktop client fills `filePath` from each command's
   * absolute path, and the server refuses the call with "skill path is None"
   * when the entry it looked up carries no path. Called WITHOUT a scope, the
   * registry answers from the host layer only and returns nothing — measured
   * 2026-10-28: the payload was `[]` for a session that had 13 skills, which is
   * exactly why every native load failed while the toolbox `skill` worked.
   *
   * @param {string} [sessionId] session whose agent scope and workspace to query.
   */
  const collectSkills = async (sessionId) => {
    const skills = ctx.get('skills')
    if (skills === undefined || typeof skills.list !== 'function') return []
    const { agent, cwd } = resolveTurnContext(sessionId)
    try {
      const listed = await skills.list({ scope: agent, cwd })
      logger?.debug?.(`lanagent: skill catalogue ${Array.isArray(listed) ? listed.length : 0} entry(ies) for the vendor`)
      return (Array.isArray(listed) ? listed : [])
        .map((skill) => {
          const skillName = skill?.name ?? skill?.id
          if (typeof skillName !== 'string' || skillName.length === 0) return undefined
          return {
            name: skillName,
            description: String(skill?.description ?? ''),
            filePath: String(skill?.filePath ?? skill?.path ?? ''),
            whenToUse: String(skill?.whenToUse ?? ''),
          }
        })
        .filter((entry) => entry !== undefined)
    } catch (error) {
      logger?.debug?.(`lanagent: skill catalogue unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * Resolve the initiating Agent and workspace for one DSH session.
   *
   * The Agent is not a formality: it selects the tool scope. Without it the
   * registry answers from the default view — where a `ptc` composition refuses
   * every direct call and does not even know `run_code` (design notes §16).
   *
   * @param {string} sessionId DSH session id (never a WebSocket channel id).
   */
  const resolveTurnContext = (sessionId) => {
    const agents = lookup('agents').service
    return {
      agent: agents?.get?.(sessionId) ?? agents?.currentInitiator?.(),
      cwd: lookup('sessions').service?.get?.(sessionId)?.header?.cwd,
    }
  }

  /**
   * Request pressure for the local usage sample.
   *
   * The vendor cannot report this: `token_usage.used_tokens` is its own
   * per-`chatId` conversation counter, not this request's prompt. The host
   * token meter prices the current DSH surface at the moment the vendor turn
   * completes, which is exactly what DSH's compaction and context meter
   * expect. Use `surfaceTokens` (plus the tool-schema price) rather than
   * `totalTokens`: the latter may still be anchored to a legacy vendor usage
   * sample from the same session, which is the very value this fix removes.
   *
   * Missing services or a racing session yield no sample; the meter then keeps
   * its previous reading and compaction falls back to its own estimate.
   *
   * @param {string} sessionId DSH session id.
   * @param {readonly object[] | undefined} tools request tool schemas.
   * @returns {number | undefined}
   */
  const measurePressure = (sessionId, tools) => {
    const meter = ctx.get('tokenMeter')
    const session = lookup('sessions').service?.get?.(sessionId)
    if (meter === undefined || typeof meter.measure !== 'function' || session === undefined) return undefined
    try {
      const surfaceTokens = meter.measure(session).surfaceTokens
      const toolsTokens = Array.isArray(tools) && tools.length > 0
        ? Math.ceil(JSON.stringify(tools).length / 4) + 4
        : 0
      const total = surfaceTokens + toolsTokens
      return Number.isFinite(total) && total > 0 ? total : undefined
    } catch (error) {
      logger?.debug?.(`lanagent: local token measurement unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Declare the DSH toolbox to the vendor for one turn.
   *
   * @param {string} sessionId DSH session id.
   * @returns {Promise<Record<string, object>>} the `config.mcp_servers` map.
   */
  /** Last declared toolbox per session, so the audit record is written once. */
  const declaredToolboxFor = new Map()

  const collectToolbox = async (sessionId) => {
    if (mcpToolboxMode !== 'enabled') return {}
    const tools = lookup('tools').service
    if (tools === undefined || typeof tools.schemas !== 'function') return {}
    const { agent } = resolveTurnContext(sessionId)
    try {
      // The scope's visible list can omit tools registered in nested scopes
      // (every MCP server lives in one), so the whitelist's named entries are
      // resolved individually first — otherwise a skill that says "use the
      // browser tool" points at a tool the vendor never received.
      const configuredWhitelist = Array.isArray(mcpToolWhitelist) && mcpToolWhitelist.length > 0
        ? mcpToolWhitelist.map(String)
        : [...DEFAULT_WHITELIST]
      const schemas = completeToolboxSchemas({
        schemas: tools.schemas(agent),
        whitelist: configuredWhitelist,
        get: (name) => tools.get?.(name, agent) ?? tools.get?.(name),
      })
      // Auto mode: every MCP server DSH has loaded publishes its own tools, so
      // adding a server to the profile (or to a skill) is all it takes for the
      // vendor to see it. The hand-kept list was a stale copy of this registry
      // anyway — that is exactly how the desktop MCP server stayed missing from
      // the vendor's toolbox while the Web GUI could call it (design notes §27).
      const discovered = mcpToolboxMcpAuto
        ? collectMcpToolSchemas({ tools, agent, deny: mcpToolboxMcpDeny, logger })
        : []
      refreshToolboxTools(discovered.map((schema) => schema.name))
      const whitelist = configuredWhitelist.filter((entry) => !isDeniedToolboxName(entry))
      const knownNames = new Set(schemas.map((schema) => schema.name))
      for (const schema of discovered) {
        if (isDeniedToolboxName(schema.name)) continue
        if (!knownNames.has(schema.name)) {
          knownNames.add(schema.name)
          schemas.push(schema)
        }
        if (!whitelist.includes(schema.name)) whitelist.push(schema.name)
      }
      const servers = buildToolboxServers({
        schemas,
        whitelist,
        serverName: mcpToolboxName,
        maxTools: mcpToolboxMaxTools,
        logger,
      })
      const declared = (servers[mcpToolboxName]?.tools ?? []).map((tool) => String(tool?.name ?? ''))
      // The vendor receives every entry, not just the synthetic one: an MCP
      // server it was not declared is one it refuses locally, so the audit and
      // the change detection must cover all of them.
      const declaredAll = Object.entries(servers)
        .map(([server, entry]) => `${server}: ${(entry.tools ?? []).map((tool) => String(tool?.name ?? '')).join(',')}`)
        .sort()
      const declaredTotal = Object.values(servers).reduce((count, entry) => count + (entry.tools?.length ?? 0), 0)
      // Audit record, once per session and only when the set changes: the
      // declaration is the ground truth for "what did the vendor actually
      // receive", and the vendor's own account of its tool list is unreliable
      // (measured — it reported three tools while naming others in the same
      // answer). The panel renders it like any other record.
      const signature = declaredAll.join('|')
      if (declaredToolboxFor.get(sessionId) !== signature) {
        declaredToolboxFor.set(sessionId, signature)
        audit?.({
          name: 'toolbox',
          args: {},
          ok: true,
          route: 'declaration',
          dshTool: `${declaredTotal} tool(s) in ${declaredAll.length} server(s)`,
          detail: declaredAll.join(' | ').slice(0, 1200),
        })
      }
      logger?.debug?.(`lanagent: DSH toolbox declared to the vendor (${declared.length} plain + ${declaredAll.length} server declaration(s), agent=${agent === undefined ? 'none' : 'session'})`)
      return servers
    } catch (error) {
      logger?.warn?.(`lanagent: cannot build the DSH toolbox (${error instanceof Error ? error.message : String(error)}); this turn runs with the vendor's own tools only`)
      return {}
    }
  }

  /** Build the handler that answers the vendor's tool calls for one turn. */
  const createToolHandler = ({ sessionId, turnSignal, onExecuted, loop }) => {
    const { service: tools, source: toolsSource } = lookup('tools')
    if (toolBridgeMode !== 'dsh' || tools === undefined || typeof tools.execute !== 'function') {
      if (toolBridgeMode === 'dsh') {
        logger.warn?.('lanagent: the tools service is unavailable, so vendor tool calls can only be refused')
      }
      return createRefusingHandler(logger)
    }
    // The initiating Agent is what routes an approval ask to the user (design notes
    // §5.8) AND what selects the tool scope: without it the registry answers
    // from the default view, which in a `ptc` composition refuses every direct
    // call and does not even know `run_code`. The loop itself resolves its agent
    // with `agents.requireInitiator()`; the same carrier is available to us
    // because this turn runs inside the loop's driver chain.
    const { agent, cwd } = resolveTurnContext(sessionId)
    // A `ptc` session refuses every direct call except run_code, so the
    // dispatcher decides the route per call (design notes §15).
    const dispatch = createToolDispatcher({
      tools,
      agent,
      mode: toolDispatchMode,
      routes: dispatchRoutes,
      sessionKey: sessionId,
      logger,
      programTimeoutMs,
    })
    // The preflight's memory answer must name the same tree the local memory
    // responder (src/memory.js) writes, so both resolve the mapping against
    // THIS session's workspace — a relative `to` would otherwise be answered
    // with the unresolved literal while writes landed somewhere else.
    const resolvedMappings = resolveMappings(pathMappings, cwd)
    const memoryMapping = resolvedMappings[0]
    // Plan-time SEARCH/REPLACE resolution reads only inside the workspace and
    // the mapping targets; the loop and the bridge share this reader.
    const readDocument = createDocumentReader(cwd ?? process.cwd(), resolvedMappings)
    const bridge = createToolBridge({
      cwd,
      mappings: resolvedMappings,
      logger,
      onExecuted,
      audit,
      toolboxName: mcpToolboxName,
      readDocument,
      // The preflight is a local answer: the seam asks for it only when the
      // vendor sends get_environment_info, and the answer names the same memory
      // tree the local memory responder writes.
      localAnswer: async (vendor) => {
        if (vendor !== 'get_environment_info') return undefined
        const memory = await readMemoryInfo(memoryMapping === undefined ? '' : `${String(memoryMapping.to).replace(/\/+$/, '')}/projects/-/memory`)
        return { content: [{ type: 'text', text: await collectEnvironment(cwd, memory) }] }
      },
      // Where the vendor's memory really lives after mapping. Its own layout is
      // `<vendor-home>/projects/<project>/memory`, so the mapped root keeps
      // the same tail (measured: every memory read/write it made used it).
      memoryRoot: memoryMapping === undefined ? '' : `${String(memoryMapping.to).replace(/\/+$/, '')}/projects/-/memory`,
      resolveTool: resolveToolboxTool,
      availableTools: toolboxTools,
      run: async (name, args, context) => {
        try {
          return await dispatch(name, args, context)
        } catch (error) {
          // A dispatch that throws never reaches the vendor-level audit record;
          // this one carries the context that explains WHY (design notes §16).
          audit?.({ name: `dispatch:${name}`, args: { sessionId, agent: agent !== undefined, cwd: cwd ?? null, mode: toolDispatchMode }, ok: false, detail: error instanceof Error ? error.message : String(error) })
          throw error
        }
      },
    })
    logger.debug?.(
      `lanagent: tool bridge armed (tools=${toolsSource}, dispatch=${toolDispatchMode}, agent=${agent === undefined ? 'none' : 'session'}, cwd=${cwd ?? 'unset'})`,
    )
    return async (params, context) => {
      // `meta` travels with the call so the audit record can say which DSH tool
      // ran and by which route (design notes §16).
      const meta = {}
      const startedAt = Date.now()
      // One id per vendor request; parked loops emit `request` then `settled`.
      const requestId = randomId()
      // The vendor names paths from its own CLI's world; map them once here so
      // both execution routes see the same, writable path (design notes §23).
      // Mappings are resolved per turn: a relative target lands inside THIS
      // session's workspace, which is what the file sandbox allows.
      const turnMappings = resolvedMappings
      const turnMapPath = (value) => mapPath(value, turnMappings)
      const vendorName = String(params?.name ?? '')
      const rawInput = params?.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}
      const pathMappedInput = mapVendorPaths(vendorName, rawInput, turnMapPath)
      // A shell command spells the vendor's memory root in ways its own client
      // never needs to map (the vendor home, $HOME and ~ variants, and
      // guessed /home/<user> paths — all observed in the audit). Unmapped, every
      // such probe fails with EACCES and the vendor retries: GUI noise for a
      // path that has a perfectly good mapped home.
      const mappedCommand = vendorName === 'execute_command' && typeof pathMappedInput?.command === 'string'
        ? mapCommandText(pathMappedInput.command, turnMappings)
        : undefined
      const mappedInput = mappedCommand === undefined || mappedCommand === pathMappedInput.command
        ? pathMappedInput
        : { ...pathMappedInput, command: mappedCommand }

      // ── The vendor's own memory tree, answered by this plugin directly
      //    (src/memory.js). Routing these through DSH's tools tied them to the
      //    session sandbox — a workspace outside the mapping target turned every
      //    write into "[sandbox: file access denied]" — and to the loop route,
      //    where a parked read of a not-yet-existing note drew an error card
      //    the vendor retried. Both fed the read→fail→rewrite→fail spiral the
      //    GUI showed as a stream of error cards. The tree is plugin-owned
      //    bookkeeping (only mapped paths reach the responder), so no DSH tool
      //    runs, no card is drawn, and the audit record is the only trace.
      const memoryAnswer = await answerMemoryOp(vendorName, mappedInput, turnMappings, logger)
      if (memoryAnswer !== undefined) {
        const summary = memoryAnswer.error === undefined
          ? (memoryAnswer.content ?? []).map((block) => String(block?.text ?? '')).join(' ').slice(0, 240)
          : String(memoryAnswer.error.message ?? '')
        audit?.({
          name: vendorName,
          args: mappedInput,
          ok: memoryAnswer.error === undefined,
          route: 'memory-local',
          dshTool: '(local)',
          requestId,
          event: 'settled',
          durationMs: Date.now() - startedAt,
          ...memoryAnswer.error === undefined ? { summary } : { detail: summary },
        })
        return memoryAnswer
      }
      // One budget per tool call: the turn's cancellation plus our own soft
      // deadline, which stays well inside the vendor's own per-tool timeout so
      // it always gets an answer instead of giving up on us.
      const controller = new AbortController()
      const abort = () => controller.abort(turnSignal?.reason)
      if (turnSignal !== undefined) {
        if (turnSignal.aborted) abort()
        else turnSignal.addEventListener('abort', abort, { once: true })
      }
      const timer = setTimeout(() => controller.abort(new Error('lanagent: tool timeout')), toolTimeoutMs)
      timer.unref?.()
      try {
        const callId = typeof params?.block_id === 'string' && params.block_id.length > 0 ? params.block_id : randomId()

        // ── The vendor's own approval flag, honoured on BOTH routes and before
        //    anything runs or is parked (design notes §23). The wait has its OWN
        //    deadline (`approvalTimeoutMs`): it used to share the 20s per-tool
        //    soft deadline, so an honest slow approval expired the call and the
        //    vendor's model received a bogus "tool timeout" instead of the
        //    human's decision — one more way a turn died mid-work.
        if (honorRequiresApproval && (requiresApproval(rawInput) || requireApprovalFor.includes(vendorName))) {
          const { agent } = resolveTurnContext(sessionId)
          const approvalAbort = new AbortController()
          const abortApproval = () => approvalAbort.abort(controller.signal.reason)
          if (controller.signal.aborted) abortApproval()
          else controller.signal.addEventListener('abort', abortApproval, { once: true })
          const approvalTimer = setTimeout(
            () => approvalAbort.abort(new Error('lanagent: approval wait timed out')),
            approvalTimeoutMs,
          )
          approvalTimer.unref?.()
          let verdict
          try {
            verdict = await requestApproval({
              approval: lookup('approval').service,
              agent,
              toolName: 'bash',
              callId,
              reason: `厂商请求执行需要审批的命令：${String(rawInput.command ?? '').slice(0, 160)}`,
              signal: approvalAbort.signal,
            })
          } finally {
            clearTimeout(approvalTimer)
            controller.signal.removeEventListener?.('abort', abortApproval)
          }
          if (!verdict.granted && approvalAbort.signal.aborted) {
            // The abort is ours (deadline) or the turn's, not the user's answer:
            // say which, so "被拒绝" does not accuse the operator.
            verdict = controller.signal.aborted
              ? { granted: false, reason: '本轮已中止，审批等待随之结束' }
              : { granted: false, reason: `等待审批超过 ${Math.round(approvalTimeoutMs / 1000)}s 仍未获回答` }
          }
          audit?.({
            name: vendorName,
            args: rawInput,
            ok: false,
            route: 'approval',
            detail: verdict.granted ? '审批通过' : verdict.reason,
          })
          if (!verdict.granted) {
            logger?.warn?.(`lanagent: refusing ${vendorName}: ${verdict.reason}`)
            return { error: { code: -10001, message: `该命令需要用户审批，未获通过：${verdict.reason}` } }
          }
        }

        // ── The loop execution route (design notes §21): hand the call to DSH's
        //    agent loop instead of running it here. `deferred` tells the tool
        //    channel to leave the WebSocket request open; the resumed step
        //    answers it with the loop's result. (Calls into the mapped memory
        //    tree never reach this point: answerMemoryOp answered them above.)
        if (loop !== undefined && loop.mode === 'loop') {
          const vendorTool = vendorName
          if (!LOOP_EXCLUDED.has(vendorTool)) {
            // The seam maps and plans; the loop only wraps the plan in the
            // transport this presentation accepts (native calls or one program).
            const seamPlan = await interpret(vendorTool, rawInput, {
              cwd,
              mappings: turnMappings,
              toolboxName: loop.toolboxName,
              resolveTool: loop.resolveTool,
              availableTools: loop.availableTools,
              readDocument,
              requestId,
            })
            if (seamPlan.kind === 'dsh') {
              const declared = Number(rawInput.timeout)
              // An interactive question waits for a HUMAN, not for a command: its
              // budget must not be the per-tool one, or the user's answer arrives
              // for a turn the parked budget already closed (see
              // ASK_USER_BUDGET_MS). Everything else honours the vendor's own
              // per-tool timeout, never beyond our cap (design notes §26).
              const interactive = seamPlan.calls.some((plannedCall) => plannedCall.dshTool === 'ask_user_question')
              const budgetMs = interactive
                ? Math.max(ASK_USER_BUDGET_MS, Number.isFinite(declared) && declared > 0 ? declared : 0)
                : Number.isFinite(declared) && declared > 0
                  ? Math.min(declared, loop.budgetMs)
                  : loop.budgetMs
              // The program envelope carries the same budget: a PTC session runs
              // this call inside `run_code`, whose default 120s program deadline
              // would otherwise kill any call longer than two minutes — including
              // a question for a human — long before the parked budget matters.
              const planned = withStyle(seamPlan, loop.styleFor(), { timeoutMs: budgetMs })
              loop.route.park(loop.sessionKey, {
                baseCallId: callId,
                plan: planned,
                vendorTool,
                vendorArgs: seamPlan.mappedArguments ?? rawInput,
                budgetMs,
                ids: new Map(),
                parkedAt: Date.now(),
                respond: (answer) => context?.responder?.answer?.(answer),
                onBudgetExhausted: loop.onBudgetExhausted,
              })
              audit?.({
                name: vendorTool,
                args: seamPlan.mappedArguments ?? rawInput,
                ok: null,
                route: 'loop',
                requestId: planned.requestId,
                event: 'request',
                dshTool: [
                  ...planned.calls.map((plannedCall) => plannedCall.dshTool),
                  ...planned.style === 'run_code' ? [`→${planned.transportCalls[0].dshTool}`] : [],
                ].join(','),
                detail: 'parked for the agent loop',
              })
              logger?.debug?.(`lanagent: ${vendorTool} parked for the agent loop (${planned.calls.length} DSH call(s), budget ${Math.round(budgetMs / 1000)}s)`)
              return { deferred: true }
            }
            const immediate = render(seamPlan, new Map(), { cwd })
            audit?.({
              name: vendorTool,
              args: seamPlan.mappedArguments ?? rawInput,
              ok: immediate.error === undefined,
              route: 'loop',
              requestId: seamPlan.requestId,
              event: 'settled',
              dshTool: seamPlan.kind === 'local' ? '(local)' : '',
              ...immediate.error === undefined
                ? { summary: String(immediate.content?.[0]?.text ?? '').slice(0, 240) }
                : { detail: immediate.error.message },
            })
            return immediate
          }
        }

        // The bridge maps raw vendor arguments itself (the seam owns mapping);
        // memory and loop still use the mapped copy above until they migrate.
        return await bridge(params, { signal: controller.signal, callId, meta, requestId })
      } finally {
        clearTimeout(timer)
        turnSignal?.removeEventListener?.('abort', abort)
      }
    }
  }

  const adapter = new LanAgentAdapter({
    route,
    baseURL,
    user,
    auth,
    catalog,
    logger,
    systemPromptMode: configValue(config, 'systemPromptMode', 'rules'),
    thinkMode: configValue(config, 'thinkMode', 'auto'),
    purposePolicy: configValue(config, 'purposePolicy', 'light'),
    toolChannel: configValue(config, 'toolChannel', 'enabled'),
    toolTimeoutMs,
    approvalTimeoutMs,
    requestTimeoutMs,
    collectSkills,
    collectToolbox,
    createToolHandler,
    loopRoute,
    loopMode: toolExecutionMode,
    loopCallStyle,
    loopBudgetMs: loopBudgetCapMs,
    toolboxName: mcpToolboxName,
    resolveTool: resolveToolboxTool,
    availableTools: toolboxTools,
    audit,
    resolveCwd: (sessionId) => resolveTurnContext(sessionId).cwd,
    measurePressure,
  })

  ctx.llm.registerAdapter([route], adapter)

  // Declaring the route is what lets the settings surface offer it — and, with
  // `passwordRef` in the schema, offer to store the password behind it.
  ctx.llm.registerConfigurableProviders?.([
    {
      provider: route,
      displayName: 'LAN Agent',
      settingsNs: ctx.fiber?.entry?.options?.id ?? name,
      settingsPath: [],
    },
  ])

  ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => {
    const models = await catalog.list()
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      inputModalities: model.inputModalities,
    }))
  })

  // The settings panel is a browser surface: it reads the audit tail over one
  // same-origin route instead of a typed Remote binding. Read-only, GET-only,
  // and served on the loopback carrier the GUI already sits on.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: AUDIT_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          const url = new URL(req.url ?? AUDIT_ROUTE, 'http://127.0.0.1')
          const asked = Number(url.searchParams.get('limit') ?? 200)
          const limit = Number.isFinite(asked) ? Math.min(1000, Math.max(1, Math.trunc(asked))) : 200
          const feed = readAuditTail(toolAuditFile, { limit })
          const body = JSON.stringify({ ...feed, route, model: user === '' ? '' : 'configured' })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      }), 'lanagent: audit feed route')
      // The optional CLI capability reports its availability here. A separate
      // route keeps the banner from pulling the audit tail (up to 1 MiB) on
      // every refresh just to learn one boolean.
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: CLI_STATUS_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          const status = getCliStatus()
          const body = JSON.stringify({
            ...status,
            hint: status.known && !status.present ? cliHint(status.path) : '',
          })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        },
      }), 'lanagent: CLI status route')
    })
  }

  ctx.on?.('dispose', () => {
    for (const controller of adapter.active) controller.abort(new Error('lanagent: provider disposed'))
    adapter.active.clear()
    for (const key of loopRoute.keys()) loopRoute.drop(key)
  })

  // The account name is hidden information now, so the mount line reports only
  // where it comes from, never its value.
  logger.info?.(
    `lanagent: route "${route}" mounted (auth=${authMode}, account from ${String(configValue(authConfig, 'userRef', 'LAN_AGENT_USER'))}${user === '' ? '' : ' (plain-config fallback present)'}, baseURL=${baseURL})`,
  )
}

// Exported for the offline adapter tests; the plugin itself only needs `apply`.
export { LanAgentAdapter }
