import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { browserVisualEvidence, executionFailure, nativeVisualEvidence, toolPair } from '../../dsh-acceptance-gate-prototype/src/evidence.js'

const SOURCE = Object.freeze({ kind: 'plugin:dsh-rapid-iteration' })
const BROWSER_ACTION = /^mcp__playwright__browser_(navigate|click|press_key|type|hover|drag|select_option|check|uncheck|take_screenshot)$/
const EXECUTION_TOOL = /^(bash|job_output|exec_command|terminal|python|mcp__|native_)/

function saveJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, file)
}

function resultBlock(event) {
  const message = event?.data?.message
  if (message?.role === 'tool' && typeof message.toolCallId === 'string') return message
  return message?.content?.find(item =>
    (item?.type === 'tool-result' || item?.type === 'tool_result') && typeof item.toolCallId === 'string')
}

function fingerprint(detail) {
  const normalized = String(detail).toLowerCase()
    .replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').slice(0, 500)
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export class CadenceTracker {
  constructor({ runId, workspaceRoot, stateDir, launchPath, nativeReceiptRequired = false }, { now = Date.now } = {}) {
    this.now = now
    this.runId = runId
    this.root = fs.realpathSync(workspaceRoot)
    this.stateDir = fs.realpathSync(stateDir)
    this.launchPath = path.resolve(launchPath)
    this.nativeReceiptRequired = nativeReceiptRequired
    if (this.launchPath.startsWith(`${this.root}${path.sep}`)) throw new Error('launchPath must be outside workspace')
    const launch = JSON.parse(fs.readFileSync(this.launchPath, 'utf8'))
    if (launch.run_id !== runId || !Number.isInteger(launch.hard_seconds) || launch.hard_seconds < 60) {
      throw new Error('cadence launch identity or deadline invalid')
    }
    const startedAtMs = Date.parse(launch.created_at)
    if (!Number.isFinite(startedAtMs)) throw new Error('cadence launch time invalid')
    this.file = path.join(this.stateDir, `${runId}.cadence.json`)
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      schemaVersion: 1, runId, sessionId: null, startedAtMs,
      deadlineAtMs: startedAtMs + launch.hard_seconds * 1000,
      phase: 'foundation', lastAttemptAtMs: null, lastEvidenceAtMs: null,
      lastObservedAtMs: null, lastWorkingAtMs: null, firstCapabilityAtMs: null, firstNativeVisualAtMs: null,
      lastObservedSeq: 0, lastObservation: null,
      lastApproachAtMs: null, epoch: 0, errorFingerprint: null,
      repeatedErrorCount: 0, alerted: {}, alerts: [],
    }
    if (this.state.schemaVersion !== 1 || this.state.runId !== runId ||
        this.state.startedAtMs !== startedAtMs ||
        this.state.deadlineAtMs !== startedAtMs + launch.hard_seconds * 1000 ||
        !Array.isArray(this.state.alerts)) throw new Error('invalid saved cadence state')
    this.persist()
  }

  persist() { saveJson(this.file, this.state) }

  bind(session) {
    if (fs.realpathSync(session.header.cwd) !== this.root) throw new Error('cadence workspace differs from campaign')
    const id = session.header.id
    if (this.state.sessionId && this.state.sessionId !== id) throw new Error('cadence run reused by another session')
    if (!this.state.sessionId) {
      this.state.sessionId = id
      this.persist()
    }
  }

  status() {
    const { runId, phase, deadlineAtMs, lastAttemptAtMs, lastEvidenceAtMs,
      lastObservedAtMs, lastWorkingAtMs, lastObservation, repeatedErrorCount, alerts } = this.state
    return { runId, phase, deadlineAt: new Date(deadlineAtMs).toISOString(),
      remainingSeconds: Math.max(0, Math.ceil((deadlineAtMs - this.now()) / 1000)),
      lastAttemptAt: lastAttemptAtMs && new Date(lastAttemptAtMs).toISOString(),
      lastEvidenceAt: lastEvidenceAtMs && new Date(lastEvidenceAtMs).toISOString(),
      lastObservedAt: lastObservedAtMs && new Date(lastObservedAtMs).toISOString(),
      lastWorkingAt: lastWorkingAtMs && new Date(lastWorkingAtMs).toISOString(),
      lastObservation, repeatedErrorCount, alerts: alerts.slice(-5) }
  }

  newApproach() {
    this.state.lastApproachAtMs = this.now()
    this.state.epoch += 1
    this.state.errorFingerprint = null
    this.state.repeatedErrorCount = 0
    this.persist()
  }

  onSessionEvent(session, event) {
    if (session.header.parentSession || Number(session.header.delegationDepth || 0) > 0) return
    if (event?.type !== 'tool/result') return
    this.bind(session)
    const events = session.snapshotEvents()
    const pair = toolPair(event, events)
    if (!pair) return
    const { call, result } = pair
    const name = call?.data?.name
    if (typeof name !== 'string') return
    let changed = false
    if (BROWSER_ACTION.test(name)) {
      this.state.lastAttemptAtMs = this.now()
      changed = true
      if (browserVisualEvidence(events, event, this.root)) {
        this.state.lastEvidenceAtMs = this.now()
      }
    }
    if (name === 'read_image' && browserVisualEvidence(events, event, this.root)) {
      this.state.lastEvidenceAtMs = this.now()
      changed = true
    }
    if (nativeVisualEvidence(events, event, this.root, { requireReceipt: this.nativeReceiptRequired })) {
      this.state.lastEvidenceAtMs = this.now()
      changed = true
    }
    const failure = EXECUTION_TOOL.test(name) ? executionFailure(event, result) : null
    if (failure) {
      const current = fingerprint(failure)
      this.state.repeatedErrorCount = this.state.errorFingerprint === current
        ? this.state.repeatedErrorCount + 1 : 1
      this.state.errorFingerprint = current
      changed = true
    }
    if (changed) this.persist()
  }

  recordObservation(agent, store, { surface, outcome, observation }) {
    this.bind(agent.session)
    if (!['browser', 'native', 'cli', 'api', 'experiment', 'other'].includes(surface)) throw new Error('invalid interface')
    if (!['attempt', 'observed', 'blocked', 'working'].includes(outcome)) throw new Error('invalid observation outcome')
    if (typeof observation !== 'string' || !observation.trim() || observation.length > 1200) {
      throw new Error('observation must be 1..1200 characters')
    }
    const events = agent.session.snapshotEvents()
    let source
    let name
    let visual
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event.type !== 'tool/result' || event.seq <= this.state.lastObservedSeq) continue
      const pair = toolPair(event, events)
      if (!pair) continue
      const call = pair.call
      const candidateVisual = surface === 'native'
        ? nativeVisualEvidence(events, event, this.root, { requireReceipt: this.nativeReceiptRequired })
        : browserVisualEvidence(events, event, this.root)
      if (!EXECUTION_TOOL.test(call?.data?.name || '') &&
          !(['browser', 'native'].includes(surface) && candidateVisual)) continue
      if (surface === 'browser' && !BROWSER_ACTION.test(call.data.name) && !candidateVisual) continue
      if (surface === 'native' && !candidateVisual) continue
      source = event
      name = call.data.name
      visual = candidateVisual
      break
    }
    if (!source) throw new Error('no matching new execution result; exercise the product first')
    if (surface === 'native' && outcome === 'working' && this.nativeReceiptRequired &&
        visual?.providedScaffoldModified === false) {
      throw new Error('provided native scaffold is not a working product increment')
    }
    const sourceResult = resultBlock(source)
    if (['observed', 'working'].includes(outcome) && (executionFailure(source, sourceResult) ||
        (['browser', 'native'].includes(surface) && !visual))) {
      throw new Error('observed capability requires a successful interface result and a sourced image for visual work')
    }
    const now = this.now()
    const entry = { surface, outcome, observation: observation.trim(), tool: name,
      sourceEventSeq: source.seq, ...(visual ? { captureEventSeq: visual.captureEventSeq,
        evidenceKind: visual.kind } : {}),
      sourceEventHash: crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex'),
      recordedAt: new Date(now).toISOString() }
    if (outcome === 'working') {
      entry.workingState = store.recordObserved(entry)
      this.state.lastWorkingAtMs = now
    }
    this.state.lastAttemptAtMs = now
    this.state.lastObservedSeq = source.seq
    if (outcome !== 'attempt') {
      this.state.lastObservedAtMs = now
      this.state.lastObservation = entry
      if (outcome === 'observed' || outcome === 'working') this.state.firstCapabilityAtMs ??= now
      if (surface === 'native' && visual && ['observed', 'working'].includes(outcome)) {
        this.state.firstNativeVisualAtMs ??= now
      }
      this.state.phase = this.state.phase === 'stabilizing' ? 'stabilizing' : 'iterating'
      this.state.epoch += 1
      this.state.errorFingerprint = null
      this.state.repeatedErrorCount = 0
    }
    this.persist()
    return { recorded: true, ...entry, cadence: this.status() }
  }

  async preStep({ agent, signal }, next, store) {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted ||
        agent.session.header.parentSession || Number(agent.session.header.delegationDepth || 0) > 0) return decision
    this.bind(agent.session)
    const now = this.now()
    if (now >= this.state.deadlineAtMs) return decision
    const elapsed = now - this.state.startedAtMs
    let kind = null
    let message = null
    if (!this.state.alerted.initialMandate) {
      kind = 'initial-mandate'
      message = 'Choose one small, structurally important capability now. Call iteration_begin with the representative input or action and the concrete observation expected, then implement and exercise only that increment before expanding the backlog. Final requirements define the destination, not the construction order.'
      this.state.alerted.initialMandate = true
    } else if (now >= this.state.deadlineAtMs - 1_800_000 && !this.state.alerted.stabilize) {
      kind = 'stabilize'
      message = 'Thirty minutes remain. Stabilize the best runnable result now: exercise its real interface, repair blocking behavior, run applicable checks, and preserve an observed working state. Defer extensions.'
      this.state.phase = 'stabilizing'
      this.state.alerted.stabilize = true
    } else if (store?.state?.active && now - Date.parse(store.state.active.startedAt) >= 1_200_000 &&
        this.state.alerted.incrementId !== store.state.active.id) {
      kind = 'increment-decision'
      message = 'This increment has been open for about 20 minutes without a recorded working observation. Exercise its representative path now, reduce it to a smaller attempt, or restore if it regressed. Check that a failing expectation and its input are valid before changing more product code.'
      this.state.alerted.incrementId = store.state.active.id
    } else if (this.nativeReceiptRequired &&
        now - (this.state.lastWorkingAtMs || this.state.startedAtMs) >= 1_200_000 &&
        this.state.alerted.nativeWorkingAnchor !== (this.state.lastWorkingAtMs || this.state.startedAtMs)) {
      kind = 'native-working-reminder'
      message = 'About 20 minutes have passed without a new observed working native state. Build the current revision with native_build, observe its exact window with Cua Driver, exercise an input and observe again; reduce or restore the increment if needed. Captures and new iteration calls do not extend the 30-minute stall deadline.'
      this.state.alerted.nativeWorkingAnchor = this.state.lastWorkingAtMs || this.state.startedAtMs
    } else if (elapsed >= 2_700_000 && !this.state.firstCapabilityAtMs && !this.state.alerted.firstObserved) {
      kind = 'first-observed'
      message = 'No product capability has been observed after 45 minutes. Narrow the current increment to the smallest useful capability, exercise it through its interface, then record the real result with iteration_observe.'
      this.state.alerted.firstObserved = true
      this.state.alerted.firstAttempt = true
    } else if (elapsed >= 1_800_000 && !this.state.lastAttemptAtMs && !this.state.alerted.firstAttempt) {
      kind = 'first-attempt'
      message = 'No product interface has been exercised after 30 minutes. Reduce the first increment and try a real input/output path now. Isolated tests and a build do not establish this milestone.'
      this.state.alerted.firstAttempt = true
    } else if (this.state.lastObservedAtMs && now - Math.max(this.state.lastObservedAtMs,
        this.state.lastApproachAtMs ?? 0) >= 1_800_000 &&
        this.state.alerted.staleEpoch !== this.state.epoch) {
      const repeated = this.state.repeatedErrorCount >= 3 && this.state.alerted.errorEpoch !== this.state.epoch
      kind = repeated ? 'stale-and-repeated-error' : 'stale-observation'
      message = repeated
        ? 'Thirty minutes have passed without a new product observation and the same execution error has recurred. Inspect the cause, change approach, or restore the last observed working state if this increment regressed.'
        : 'Thirty minutes have passed without a new recorded product observation. Exercise the current result, inspect what happened, and adjust or restore the latest increment if it regressed.'
      this.state.alerted.staleEpoch = this.state.epoch
      if (repeated) this.state.alerted.errorEpoch = this.state.epoch
    } else if (this.state.repeatedErrorCount >= 3 && this.state.alerted.errorEpoch !== this.state.epoch) {
      kind = 'repeated-error'
      message = 'The same execution error has occurred at least three times. Inspect the cause, change approach, or restore the last observed working state if this increment caused the regression.'
      this.state.alerted.errorEpoch = this.state.epoch
    }
    if (!message) return decision
    this.state.alerts.push({ kind, at: new Date(now).toISOString(), turn: agent.session.header.id })
    this.persist()
    return { ...decision, messages: [...decision.messages, {
      id: crypto.randomUUID(), role: 'user', source: SOURCE,
      content: [{ type: 'text', text: message }],
    }] }
  }
}
