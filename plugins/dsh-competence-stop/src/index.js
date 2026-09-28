import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { executionFailure, nativeVisualEvidence } from '../../dsh-acceptance-gate-prototype/src/evidence.js'

export const name = 'competence-stop'
export const inject = ['tools', 'systemPrompt']

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'competence_status'])
const EXECUTION_TOOL = /^(bash|exec_command|terminal|python|mcp__)/
const STOP_CATEGORIES = new Set(['knowledge_gap', 'environment_block', 'ambiguous_requirement'])
const schema = properties => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties) })
const str = { type: 'string' }
const output = { schema: { type: 'object' }, render: (_args, result) =>
  [{ type: 'text', text: JSON.stringify(result) }] }

function required(value, label, max = 700) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be 1..${max} characters`)
  }
  return value.trim()
}

function saveJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
  fs.renameSync(temp, file)
}

function resultFor(event) {
  const message = event?.data?.message
  if (message?.role === 'tool' && typeof message.toolCallId === 'string') return message
  return message?.content?.find(block =>
    (block?.type === 'tool-result' || block?.type === 'tool_result') &&
    typeof block.toolCallId === 'string')
}

export class CompetenceGate {
  constructor({ runId, workspaceRoot, stateDir, launchPath, probeSeconds = 1200,
    requiredEvidence = 'execution', deadlinePolicy = 'hard', nativeReceiptRequired = false }, { now = Date.now } = {}) {
    this.now = now
    this.runId = required(runId, 'runId', 100)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(this.runId)) throw new Error('invalid runId')
    this.root = fs.realpathSync(required(workspaceRoot, 'workspaceRoot', 4096))
    this.stateDir = fs.realpathSync(required(stateDir, 'stateDir', 4096))
    this.launchPath = fs.realpathSync(required(launchPath, 'launchPath', 4096))
    if (this.stateDir === this.root || this.stateDir.startsWith(`${this.root}${path.sep}`) ||
        this.launchPath.startsWith(`${this.root}${path.sep}`)) throw new Error('control state must be outside workspace')
    if (!Number.isSafeInteger(probeSeconds) || probeSeconds < 60 || probeSeconds > 3600) {
      throw new Error('probeSeconds must be 60..3600')
    }
    this.probeSeconds = probeSeconds
    if (!['execution', 'native-image'].includes(requiredEvidence)) throw new Error('invalid requiredEvidence')
    this.requiredEvidence = requiredEvidence
    this.nativeReceiptRequired = nativeReceiptRequired
    if (!['hard', 'advisory'].includes(deadlinePolicy)) throw new Error('invalid deadlinePolicy')
    this.deadlinePolicy = deadlinePolicy
    if (fs.readFileSync(path.join(this.root, '.dsh-campaign-owner'), 'utf8').trim() !== this.runId) {
      throw new Error('workspace is not exclusively owned by this run')
    }
    const launch = JSON.parse(fs.readFileSync(this.launchPath, 'utf8'))
    if (launch.run_id !== this.runId || !Number.isFinite(Date.parse(launch.created_at))) {
      throw new Error('invalid launch identity or time')
    }
    this.file = path.join(this.stateDir, `${this.runId}.json`)
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      schemaVersion: 2, runId: this.runId, sessionId: null, status: 'pending',
      requiredEvidence,
      startedAtMs: this.now(), scope: null, verdict: null, alerted: {},
    }
    if (this.state.schemaVersion !== 2 || this.state.runId !== this.runId ||
        this.state.requiredEvidence !== requiredEvidence ||
        !Number.isSafeInteger(this.state.startedAtMs) ||
        !['pending', 'scoped', 'ready', 'stopped'].includes(this.state.status)) {
      throw new Error('invalid saved competence state')
    }
    this.startedAtMs = this.state.startedAtMs
    this.persist()
  }

  persist() { saveJson(this.file, this.state) }

  bind(agent) {
    const header = agent?.session?.header
    if (!header?.id || fs.realpathSync(header.cwd) !== this.root) {
      throw new Error('competence session workspace differs from campaign')
    }
    if (header.parentSession || Number(header.delegationDepth || 0) > 0) {
      throw new Error('subagents cannot decide campaign competence')
    }
    if (this.state.sessionId && this.state.sessionId !== header.id) throw new Error('run reused by another session')
    if (!this.state.sessionId) {
      this.state.sessionId = header.id
      this.persist()
    }
  }

  status(agent) {
    this.bind(agent)
    return { runId: this.runId, status: this.state.status,
      requiredEvidence: this.requiredEvidence, deadlinePolicy: this.deadlinePolicy,
      scope: this.state.scope,
      verdict: this.state.verdict, probeDeadline: new Date(this.startedAtMs + this.probeSeconds * 1000).toISOString() }
  }

  scope(agent, { capability, approach, probe, expected }) {
    this.bind(agent)
    if (this.state.status !== 'pending') throw new Error('competence scope already recorded')
    this.state.scope = { capability: required(capability, 'capability'),
      approach: required(approach, 'approach'), probe: required(probe, 'probe'),
      expected: required(expected, 'expected'), recordedAt: new Date(this.now()).toISOString(),
      sourceSeq: agent.session.snapshotEvents().at(-1)?.seq ?? 0 }
    this.state.status = 'scoped'
    this.persist()
    return this.status(agent)
  }

  result(agent, { outcome, observation, missingKnowledge }) {
    this.bind(agent)
    if (this.state.status !== 'scoped') throw new Error('record a scope before the competence result')
    if (outcome !== 'can_proceed' && !STOP_CATEGORIES.has(outcome)) throw new Error('invalid competence outcome')
    const report = { category: outcome, capability: this.state.scope.capability,
      observation: required(observation, 'observation', 1200),
      missingKnowledge: outcome === 'knowledge_gap'
        ? required(missingKnowledge, 'missingKnowledge', 1200) : '',
      recordedAt: new Date(this.now()).toISOString() }
    if (outcome === 'can_proceed') {
      const events = agent.session.snapshotEvents()
      let visual = null
      const source = [...events].reverse().find(event => {
        if (event.type !== 'tool/result' || event.seq <= this.state.scope.sourceSeq) return false
        const result = resultFor(event)
        if (!result || executionFailure(event, result)) return false
        if (this.requiredEvidence === 'native-image') {
          visual = nativeVisualEvidence(events, event, this.root, { requireReceipt: this.nativeReceiptRequired })
          return visual && visual.captureEventSeq > this.state.scope.sourceSeq &&
            (!this.nativeReceiptRequired || visual.providedScaffoldModified)
        }
        return events.some(call => call.type === 'tool/call' &&
          call.data?.callId === result.toolCallId && EXECUTION_TOOL.test(call.data?.name || ''))
      })
      if (!source) throw new Error(this.requiredEvidence === 'native-image'
        ? 'can_proceed requires a captured native image read after scope and a behavior added beyond the provided scaffold'
        : 'can_proceed requires a successful representative execution after scope')
      report.sourceEventSeq = source.seq
      report.sourceEventHash = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex')
      if (visual) report.captureEventSeq = visual.captureEventSeq
      this.state.status = 'ready'
    } else {
      // The supervisor reads this state outside the agent workspace and stops the run.
      this.state.status = 'stopped'
    }
    this.state.verdict = report
    this.persist()
    return this.status(agent)
  }

  async preExecute(exec, next) {
    if (!exec.agent) return next()
    this.bind(exec.agent)
    const toolName = exec.name
    if (this.state.status === 'stopped' && toolName !== 'competence_status') {
      return { kind: 'deny', reason: 'Campaign stopped by competence_result; inspect competence_status.' }
    }
    if (this.state.status === 'pending' &&
        !READ_TOOLS.has(toolName) && toolName !== 'competence_scope') {
      return { kind: 'deny', reason: 'Call competence_scope before executing or changing the project.' }
    }
    if (this.deadlinePolicy === 'hard' && this.state.status === 'scoped' &&
        this.now() >= this.startedAtMs + this.probeSeconds * 1000 &&
        !READ_TOOLS.has(toolName) && toolName !== 'competence_result' &&
        !['native_project', 'native_build', 'native_status', 'native_stop', 'iteration_restore'].includes(toolName) &&
        !toolName.startsWith('cua_driver_native__')) {
      return { kind: 'deny', reason: 'Probe time elapsed. Call competence_result with the observed outcome; stop with a specific reason if blocked.' }
    }
    return next()
  }

  async preStep({ agent, signal }, next) {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted || agent.session.header.parentSession) return decision
    this.bind(agent)
    let message
    if (this.state.status === 'pending' && !this.state.alerted.initial) {
      message = 'Before coding, call competence_scope for one structurally important capability, your concrete approach and one small representative probe. If you cannot identify a viable approach, record an explicit knowledge_gap with competence_result after scope. Do not search documentation in this campaign.'
      this.state.alerted.initial = true
    } else if (this.state.status === 'scoped' && this.deadlinePolicy === 'advisory' &&
        this.now() >= this.startedAtMs + this.probeSeconds * 500 &&
        !this.state.alerted.early) {
      message = 'The early probe checkpoint is here. Keep the probe smaller than the deliverable: build, launch, capture and read the first minimal interface before adding more features. The tools remain available.'
      this.state.alerted.early = true
    } else if (this.state.status === 'scoped' &&
        this.now() >= this.startedAtMs + this.probeSeconds * 1000 && !this.state.alerted.deadline) {
      message = this.deadlinePolicy === 'advisory'
        ? 'The early probe target elapsed. Build and launch the smallest app, then obtain a fresh exact-window Cua Driver screenshot before expanding the implementation. This reminder does not block tools; only report environment_block for an actual tool or host failure.'
        : 'The competence probe window ended. Report its observed outcome now with competence_result. Distinguish missing knowledge from a tool/environment problem or an unclear requirement. A claimed ability is not proof of delivered behavior.'
      this.state.alerted.deadline = true
    }
    if (!message) return decision
    this.persist()
    return { ...decision, messages: [...decision.messages, {
      id: crypto.randomUUID(), role: 'user', source: { kind: 'plugin:' + name },
      content: [{ type: 'text', text: message }],
    }] }
  }
}

export function apply(ctx, options = {}) {
  const gate = new CompetenceGate(options)
  const disposers = []
  for (const [toolName, parameters, execute] of [
    ['competence_scope', schema({ capability: str, approach: str, probe: str, expected: str }),
      (args, exec) => gate.scope(exec.agent, args)],
    ['competence_result', schema({ outcome: { type: 'string', enum: ['can_proceed', ...STOP_CATEGORIES] },
      observation: str, missingKnowledge: str }),
      (args, exec) => gate.result(exec.agent, args)],
    ['competence_status', schema({}), (_args, exec) => gate.status(exec.agent)],
  ]) {
    disposers.push(ctx.tools.register({ name: toolName,
      description: toolName === 'competence_result'
        ? 'Report a bounded competence probe or stop the campaign with a specific reason.'
        : toolName === 'competence_scope'
          ? 'Define an important capability and a small representative probe before coding.'
          : 'Read the competence guard state and any explicit stop reason.',
      parameters, output, execute }))
  }
  disposers.push(ctx.on('tools/pre-execute', (exec, next) => gate.preExecute(exec, next)))
  disposers.push(ctx.on('agent/pre-step', (payload, next) => gate.preStep(payload, next)))
  disposers.push(ctx.systemPrompt.section({ name: 'tool:competence-stop', order: 170,
    text: `Before starting an increment or coding, use competence_scope for one essential or foundational capability. The probe must be smaller than the deliverable; do not build the full product before testing it. State the mechanism you intend to use, a small real probe and its expected observation. If you do not know a viable mechanism, use competence_result with knowledge_gap and name the missing knowledge; this stops the campaign. Otherwise run the probe, then record can_proceed only from ${gate.requiredEvidence === 'native-image' ? 'a successful native_build and fresh Cua Driver get_window_state image after implementing a small behavior yourself' : 'an actual successful execution'}. Distinguish knowledge_gap, environment_block and ambiguous_requirement. An elapsed advisory probe target is not an environment_block. Each blocked category stops the campaign and records the reason. There is no automatic documentation search. A successful probe permits work but does not certify final quality.` }))
  ctx.effect?.(() => () => { for (const dispose of disposers.reverse()) dispose?.() }, name)
}
