import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { evaluateContract, parseContract, sha256 } from './core.js'
import { runConfiguredCheck } from './process-provider.js'
import { artifactRevision } from './revision.js'
import { browserVisualEvidence, nativeVisualEvidence, isToolResult, toolPair } from './evidence.js'

const SOURCE = Object.freeze({ kind: 'plugin:dsh-acceptance-gate-prototype' })

export const name = 'acceptance-gate'
export const inject = ['tools', 'systemPrompt']

function requiredConfig(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function isSubagent(agent) {
  const header = agent?.session?.header
  return Boolean(header?.parentSession) || Number(header?.delegationDepth || 0) > 0
}

function browserCall(event, events) {
  return toolPair(event, events)
}

const PUBLIC_BROWSER_ACTIONS = new Set([
  'mcp__playwright__browser_click', 'mcp__playwright__browser_press_key',
  'mcp__playwright__browser_type', 'mcp__playwright__browser_hover',
  'mcp__playwright__browser_drag', 'mcp__playwright__browser_select_option',
  'mcp__playwright__browser_check', 'mcp__playwright__browser_uncheck',
])

// Provenance only: a successful action and screenshot cannot prove the intended behavior.
export function publicBrowserPath(events, screenshotSeq, allowedOrigins) {
  let navigation = null
  let action = null
  let instrumented = false
  for (const event of events) {
    if (event.seq > screenshotSeq || event.type !== 'tool/result') continue
    const pair = browserCall(event, events)
    if (!pair) continue
    const name = pair.call.data?.name
    if (typeof name !== 'string' || !name.startsWith('mcp__playwright__browser_')) continue
    if (name === 'mcp__playwright__browser_navigate') {
      navigation = null
      action = null
      instrumented = false
      try {
        const raw = pair.call.data?.arguments
        const args = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (!pair.result.isError && !event.data?.error && allowedOrigins.includes(new URL(args.url).origin)) navigation = event.seq
      } catch { /* Invalid navigation leaves the sequence closed. */ }
    } else if (name === 'mcp__playwright__browser_take_screenshot') {
      continue
    } else if (PUBLIC_BROWSER_ACTIONS.has(name)) {
      if (navigation && !pair.result.isError && !event.data?.error) action = event.seq
    } else if (name !== 'mcp__playwright__browser_snapshot') {
      instrumented = true
    }
  }
  return { navigation, action, instrumented,
    cleanInteraction: Boolean(navigation && action && !instrumented) }
}

function makeState(config, contractDigest) {
  return { schemaVersion: 1, runId: config.runId, contractDigest, sessionId: null,
    observations: [], totalSteers: 0, verdict: 'pending', evaluatedAt: null, revisionDigest: null,
    missing: [], error: null }
}

function publicReport(state, evaluation) {
  return {
    runId: state.runId, verdict: state.verdict, revisionDigest: state.revisionDigest,
    totalSteers: state.totalSteers, requirements: evaluation?.requirements ?? [],
    missing: state.missing, error: state.error,
  }
}

export class AcceptanceGate {
  constructor(ctx, options) {
    this.ctx = ctx
    this.config = {
      contractPath: path.resolve(requiredConfig(options?.contractPath, 'contractPath')),
      contractSha256: requiredConfig(options?.contractSha256, 'contractSha256'),
      stateDir: path.resolve(requiredConfig(options?.stateDir, 'stateDir')),
      runId: requiredConfig(options?.runId, 'runId'),
      maxRemediations: options?.maxRemediations ?? 3,
      browserAllowedOrigins: options?.browserAllowedOrigins ?? [],
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(this.config.runId)) throw new Error('invalid runId')
    if (!/^[a-f0-9]{64}$/.test(this.config.contractSha256)) throw new Error('contractSha256 must be SHA-256 hex')
    if (!Number.isSafeInteger(this.config.maxRemediations) || this.config.maxRemediations < 0 ||
        this.config.maxRemediations > 20) throw new Error('maxRemediations must be 0..20')
    if (!Array.isArray(this.config.browserAllowedOrigins) ||
        !this.config.browserAllowedOrigins.every(value => typeof value === 'string' &&
          /^http:\/\/(127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(value))) {
      throw new Error('browserAllowedOrigins must contain local HTTP origins')
    }
    const raw = fs.readFileSync(this.config.contractPath, 'utf8')
    this.contractDigest = sha256(raw)
    if (this.contractDigest !== this.config.contractSha256) throw new Error('frozen contract digest mismatch')
    this.contract = parseContract(raw)
    fs.mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 })
    this.statePath = path.join(this.config.stateDir, `${this.config.runId}.json`)
    this.state = fs.existsSync(this.statePath)
      ? JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      : makeState(this.config, this.contractDigest)
    if (this.state.contractDigest !== this.contractDigest || this.state.runId !== this.config.runId) {
      throw new Error('saved verdict belongs to a different contract or run')
    }
    if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.observations) ||
        !Number.isSafeInteger(this.state.totalSteers) || this.state.totalSteers < 0) {
      throw new Error('saved verdict has an invalid schema')
    }
    this.providerIds = new Set()
    this.pendingChecks = new Map()
    this.disposers = []
  }

  persist() {
    const temporary = `${this.statePath}.${crypto.randomUUID()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, this.statePath)
  }

  sessionEvents(agent) {
    if (typeof agent?.session?.snapshotEvents !== 'function') throw new Error('session event snapshot API unavailable')
    return agent.session.snapshotEvents()
  }

  bind(agent) {
    const id = requiredConfig(String(agent?.session?.header?.id || ''), 'session id')
    if (this.state.sessionId && this.state.sessionId !== id) throw new Error('runId reused by another session')
    this.state.sessionId = id
    const cwd = requiredConfig(agent?.session?.header?.cwd, 'session cwd')
    const workspace = fs.realpathSync(cwd)
    const stateDir = fs.realpathSync(this.config.stateDir)
    const contractPath = fs.realpathSync(this.config.contractPath)
    if (stateDir === workspace || stateDir.startsWith(`${workspace}${path.sep}`)) {
      throw new Error('stateDir must be outside the agent workspace')
    }
    if (contractPath.startsWith(`${workspace}${path.sep}`)) throw new Error('contractPath must be outside the agent workspace')
    return cwd
  }

  currentContract() {
    const digest = sha256(fs.readFileSync(this.config.contractPath))
    if (digest !== this.contractDigest) throw new Error('frozen contract changed during the run')
  }

  registerProvider(providerId, { toolNames } = {}) {
    if (this.providerIds.has(providerId)) throw new Error(`provider already registered: ${providerId}`)
    const allowed = this.contract.requirements.some(requirement =>
      requirement.observations.some(rule => rule.provider === providerId))
    if (!allowed) throw new Error(`provider absent from frozen contract: ${providerId}`)
    if (!Array.isArray(toolNames) || !toolNames.length || !toolNames.every(name => typeof name === 'string' && name)) {
      throw new Error('provider must name the tool results it validates')
    }
    this.providerIds.add(providerId)
    return (agent, observation) => this.recordObservation(agent, { ...observation, provider: providerId }, toolNames)
  }

  recordObservation(agent, observation, toolNames) {
    this.currentContract()
    const cwd = this.bind(agent)
    const requirement = this.contract.requirements.find(item => item.id === observation.requirementId)
    const rule = requirement?.observations.find(item =>
      item.provider === observation.provider && item.kind === observation.kind &&
      item.checkId === (observation.checkId ?? null))
    if (!rule) throw new Error('observation does not match a frozen requirement')
    if (!['pass', 'fail', 'inconclusive'].includes(observation.outcome)) throw new Error('invalid observation outcome')
    if (!Number.isSafeInteger(observation.sourceEventSeq)) throw new Error('sourceEventSeq is required')
    const events = this.sessionEvents(agent)
    const event = events.find(item => item.seq === observation.sourceEventSeq)
    if (event?.type !== 'tool/result') throw new Error('observation must refer to a committed tool result')
    const pair = toolPair(event, events)
    const result = pair?.result
    const call = pair?.call
    if (!call || !toolNames.includes(call.data?.name)) throw new Error('tool result is outside provider scope')
    if (observation.checkId) {
      let args
      try {
        args = typeof call.data.arguments === 'string'
          ? JSON.parse(call.data.arguments) : call.data.arguments
      } catch { throw new Error('invalid tool call arguments') }
      if (args?.checkId !== observation.checkId) throw new Error('tool result belongs to another check')
    }
    if (observation.outcome === 'pass' && (result?.isError || event.data?.error)) {
      throw new Error('failed tool result cannot be recorded as pass')
    }
    const revisionDigest = artifactRevision(cwd, this.contract.revision).digest
    if (observation.expectedRevisionDigest && observation.expectedRevisionDigest !== revisionDigest) {
      throw new Error('artifact changed after the observation')
    }
    const entry = { requirementId: requirement.id, provider: observation.provider, kind: observation.kind,
      checkId: observation.checkId ?? null,
      outcome: observation.outcome, sourceEventSeq: event.seq, sourceEventHash: sha256(JSON.stringify(event)),
      revisionDigest, summary: String(observation.summary || '').slice(0, 500), recordedAt: Date.now() }
    if (this.state.observations.length >= 5000) throw new Error('observation limit reached')
    this.state.observations.push(entry)
    this.state.verdict = 'pending'
    this.state.error = null
    this.persist()
    return { recorded: true, revisionDigest, sourceEventSeq: event.seq }
  }

  evaluate(agent) {
    this.currentContract()
    const cwd = this.bind(agent)
    if (this.pendingChecks.size > 0) {
      for (const event of this.sessionEvents(agent)) this.onSessionEvent(agent.session, event)
    }
    const revisionDigest = artifactRevision(cwd, this.contract.revision).digest
    const evaluation = evaluateContract(this.contract, this.state.observations, revisionDigest, this.sessionEvents(agent))
    this.state.revisionDigest = revisionDigest
    this.state.evaluatedAt = new Date().toISOString()
    this.state.missing = evaluation.requirements.filter(item => item.required && !item.pass).map(item => ({
      id: item.id, description: item.description,
      observations: item.rules.filter(rule => !rule.pass).map(rule => ({ provider: rule.provider,
        kind: rule.kind, count: rule.count, minimum: rule.minimum }))
    }))
    this.state.verdict = evaluation.pass && !this.state.error ? 'accepted' : 'blocked'
    this.persist()
    return publicReport(this.state, evaluation)
  }

  stopping({ agent }) {
    if (isSubagent(agent)) return
    let report
    try { report = this.evaluate(agent) }
    catch (error) {
      this.state.verdict = 'blocked'
      this.state.error = String(error?.message || error).slice(0, 500)
      this.state.evaluatedAt = new Date().toISOString()
      this.persist()
      report = publicReport(this.state)
    }
    if (report.verdict === 'accepted' || this.state.totalSteers >= this.config.maxRemediations) return
    this.state.totalSteers += 1
    this.persist()
    const missing = report.missing.map(item => `${item.id}: ${item.observations.map(rule =>
      `${rule.provider}/${rule.kind} ${rule.count}/${rule.minimum}`).join(', ')}`).join('; ')
    agent.steer({ id: crypto.randomUUID(), role: 'user', source: SOURCE,
      content: [{ type: 'text', text: `Acceptance remains blocked. ${report.error || missing}. Collect the required real observations or report the unresolved requirement. The campaign supervisor reads the durable verdict; a successful process exit does not imply accepted work.` }] })
  }

  onSessionEvent(session, event) {
    if (event?.type !== 'tool/result') return
    if (isSubagent({ session })) return
    const events = session.snapshotEvents()
    const browser = browserCall(event, events)
    const visual = nativeVisualEvidence(events, event, session.header.cwd, { requireReceipt: true })
    if (visual?.providedScaffoldModified) {
      const toolName = browser?.call?.data?.name
      const provider = visual.kind === 'cua-window' ? 'native-cua' : 'native-app'
      if (toolName) {
        for (const kind of visual.inputDispatched ? ['captured-window', 'input-window'] : ['captured-window']) {
          for (const requirement of this.contract.requirements) {
            if (!requirement.observations.some(rule => rule.provider === provider && rule.kind === kind)) continue
            try {
              this.recordObservation({ session }, { requirementId: requirement.id,
                provider, kind, outcome: 'pass', sourceEventSeq: event.seq,
                expectedRevisionDigest: visual.revision,
                summary: `${kind} from native receipt; visible behavior requires review` }, [toolName])
            } catch (error) {
              this.state.verdict = 'blocked'
              this.state.error = `native evidence not committed: ${String(error?.message || error).slice(0, 350)}`
              this.persist()
            }
          }
        }
      }
    }
    if (browser && !browser.result.isError && !event.data?.error) {
      const name = browser.call.data?.name
      const kinds = []
      if (name === 'mcp__playwright__browser_navigate') {
        try {
          const raw = browser.call.data?.arguments
          const args = typeof raw === 'string' ? JSON.parse(raw) : raw
          const url = new URL(args.url)
          if (this.config.browserAllowedOrigins.includes(url.origin)) kinds.push('local-navigation')
        } catch { /* Unparseable navigation cannot become evidence. */ }
      } else if ((name === 'mcp__playwright__browser_take_screenshot' || name === 'read_image') &&
          browserVisualEvidence(events, event, session.header.cwd)) {
        try {
          const visual = browserVisualEvidence(events, event, session.header.cwd)
          const revision = artifactRevision(session.header.cwd, this.contract.revision).digest
          const latestNavigation = events.filter(item => item.type === 'tool/call' &&
            item.data?.name === 'mcp__playwright__browser_navigate' && item.seq < event.seq).at(-1)
          const navigationObserved = this.state.observations.some(item =>
            item.provider === 'browser-native' && item.kind === 'local-navigation' &&
            item.outcome === 'pass' && item.revisionDigest === revision &&
            item.sourceEventSeq < event.seq && item.sourceEventSeq > (latestNavigation?.seq ?? 0))
          if (navigationObserved) {
            kinds.push('native-screenshot')
            if (publicBrowserPath(events, visual.captureEventSeq, this.config.browserAllowedOrigins).cleanInteraction) {
              kinds.push('public-interaction-screenshot')
            }
          }
        } catch { /* An unreadable revision cannot become screenshot evidence. */ }
      }
      for (const kind of kinds) {
        for (const requirement of this.contract.requirements) {
          if (!requirement.observations.some(rule => rule.provider === 'browser-native' && rule.kind === kind)) continue
          try {
            this.recordObservation({ session }, {
              requirementId: requirement.id, provider: 'browser-native', kind,
              outcome: 'pass', sourceEventSeq: event.seq,
              summary: `${name} completed with ${kind} (${visual.kind}); provenance only, behavior requires review`,
            }, [name])
          } catch (error) {
            this.state.verdict = 'blocked'
            this.state.error = `browser evidence not committed: ${String(error?.message || error).slice(0, 350)}`
            this.persist()
          }
        }
      }
    }
    const block = event.data?.message?.content?.find(isToolResult)
    if (!block) return
    const key = `${session.id}:${block.toolCallId}`
    const pending = this.pendingChecks.get(key)
    if (!pending) return
    this.pendingChecks.delete(key)
    try {
      for (const requirement of this.contract.requirements) {
        for (const rule of requirement.observations) {
          if (rule.provider !== 'process-exec' || rule.checkId !== pending.result.checkId) continue
          this.recordObservation(pending.agent, {
            requirementId: requirement.id, provider: 'process-exec', kind: rule.kind,
            checkId: rule.checkId, outcome: pending.result.outcome,
            sourceEventSeq: event.seq, expectedRevisionDigest: pending.result.revisionDigest,
            summary: `Configured check ${rule.checkId}: ${pending.result.outcome}; exit ${pending.result.exitCode ?? 'unknown'}`,
          }, ['acceptance_check'])
        }
      }
    } catch (error) {
      this.state.verdict = 'blocked'
      this.state.error = `process evidence not committed: ${String(error?.message || error).slice(0, 350)}`
      this.persist()
    }
  }

  start() {
    this.disposers.push(this.ctx.provide('acceptanceGate', {
      registerProvider: (id, options) => this.registerProvider(id, options),
      evaluate: agent => this.evaluate(agent),
    }))
    this.disposers.push(this.ctx.tools.register({
      name: 'acceptance_check',
      description: 'Run one frozen acceptance command and record its real process outcome.',
      parameters: { type: 'object', additionalProperties: false,
        properties: { checkId: { type: 'string' } }, required: ['checkId'] },
      output: { schema: { type: 'object' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      execute: async (args, exec) => {
        const check = this.contract.checks.find(item => item.id === args?.checkId)
        if (!check) throw new Error('unknown frozen acceptance check')
        const agent = exec.agent
        const cwd = this.bind(agent)
        const result = await runConfiguredCheck(cwd, this.contract.revision, check, exec.signal)
        this.pendingChecks.set(`${agent.session.id}:${exec.callId}`, { agent, result })
        return result
      },
    }))
    this.disposers.push(this.ctx.tools.register({
      name: 'acceptance_status',
      description: 'Read the frozen acceptance contract and current evidence status.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'object' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      execute: (_args, exec) => this.evaluate(exec.agent),
    }))
    this.disposers.push(this.ctx.systemPrompt.section({ name: 'tool:acceptance-gate', order: 188,
      text: `A frozen acceptance contract governs this run. Use acceptance_status to inspect unmet requirements and acceptance_check to run configured process checks. For native apps, build the current revision with native_build, then use Cua Driver get_window_state for the exact process window, act through Cua Driver, and observe the same window again. Interpret the images yourself. Completion requires observations from host providers bound to the current artifact revision. Agent-written claims do not create evidence. Contract requirements: ${this.contract.requirements.map(item => `${item.id}: ${item.description}`).join(' | ')}` }))
    this.disposers.push(this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)))
    this.disposers.push(this.ctx.on('agent/turn-stopping', payload => this.stopping(payload)))
  }

  dispose() {
    for (const disposer of this.disposers.splice(0).reverse()) disposer?.()
  }
}

export function apply(ctx, options = {}) {
  const gate = new AcceptanceGate(ctx, options)
  gate.start()
  ctx.effect?.(() => () => gate.dispose(), name)
}
