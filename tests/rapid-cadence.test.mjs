import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { IterationStore } from '../plugins/dsh-rapid-iteration/src/core.js'
import { CadenceTracker } from '../plugins/dsh-rapid-iteration/src/cadence.js'

function git(cwd, ...args) {
  const result = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost' } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('real step decision receives one durable reminder, then a working observation allows a safe restore', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cadence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspaceRoot = path.join(root, 'workspace')
  const stateDir = path.join(root, 'state')
  const launchPath = path.join(root, 'start-issued.json')
  fs.mkdirSync(workspaceRoot)
  fs.mkdirSync(stateDir)
  fs.writeFileSync(path.join(workspaceRoot, '.dsh-campaign-owner'), 'rapid-test\n')
  fs.writeFileSync(path.join(workspaceRoot, 'app.txt'), 'original')
  git(workspaceRoot, 'init', '-q')
  git(workspaceRoot, 'add', '-A')
  git(workspaceRoot, 'commit', '-qm', 'initial')
  const start = Date.parse('2026-09-25T00:00:00Z')
  fs.writeFileSync(launchPath, JSON.stringify({ run_id: 'rapid-test',
    created_at: new Date(start).toISOString(), hard_seconds: 9180 }))
  let clock = start
  const opts = { runId: 'rapid-test', workspaceRoot, stateDir, launchPath }
  const cadence = new CadenceTracker(opts, { now: () => clock })
  const store = new IterationStore(opts)
  const events = []
  const session = { header: { id: 'session-test', cwd: workspaceRoot }, snapshotEvents: () => events }
  const agent = { session }
  const step = () => cadence.preStep({ agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }), store)
  assert.match((await step()).messages[0].content[0].text, /iteration_begin/)
  clock += 30 * 60_000
  const first = await step()
  assert.match(first.messages[0].content[0].text, /No product interface/)
  assert.equal((await step()).messages.length, 0)
  clock += 15 * 60_000
  assert.match((await step()).messages[0].content[0].text, /45 minutes/)
  const resumed = new CadenceTracker(opts, { now: () => clock })
  assert.equal(resumed.state.alerts.length, 3)
  assert.equal((await resumed.preStep({ agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }), store)).messages.length, 0)

  events.push({ seq: 1, type: 'tool/call', data: { callId: 'failed', name: 'mcp__playwright__browser_navigate' } })
  events.push({ seq: 2, type: 'tool/result', data: { message: { content: [
    { type: 'tool-result', toolCallId: 'failed', isError: true, content: [] },
  ] } } })
  assert.throws(() => resumed.recordObservation(agent, store,
    { surface: 'browser', outcome: 'observed', observation: 'a capability' }), /successful interface/)
  fs.writeFileSync(path.join(workspaceRoot, 'app.txt'), 'working')
  events.push({ seq: 3, type: 'tool/call', data: { callId: 'one', name: 'bash', arguments: { command: 'node app.js' } } })
  events.push({ seq: 4, type: 'tool/result', data: { message: { content: [
    { type: 'tool-result', toolCallId: 'one', content: [{ type: 'text', text: 'working output' }] },
  ] } } })
  const observed = resumed.recordObservation(agent, store,
    { surface: 'cli', outcome: 'working', observation: 'representative input produced expected output' })
  assert.equal(observed.sourceEventSeq, 4)
  assert.equal(git(workspaceRoot, 'show', `${observed.workingState.commit}:app.txt`), 'working')
  assert.equal(store.status().active, null)
  assert.equal(resumed.status().phase, 'iterating')
  for (let attempt = 0; attempt < 3; attempt++) {
    const callId = `filtered-failure-${attempt}`
    events.push({ seq: 5 + attempt * 2, type: 'tool/call',
      data: { callId, name: 'bash', arguments: { command: 'npm test | head' } } })
    const result = { seq: 6 + attempt * 2, type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: callId, isError: false,
        content: [{ type: 'text', text: '✖ collision: player crossed wall\nℹ fail 1' }] },
    ] } } }
    events.push(result)
    resumed.onSessionEvent(session, result)
  }
  assert.equal(resumed.status().repeatedErrorCount, 3)
  resumed.newApproach()
  assert.equal(resumed.status().repeatedErrorCount, 0)
  const iteration = store.begin({ intent: 'try an extension', expected: 'more output' })
  fs.writeFileSync(path.join(workspaceRoot, 'app.txt'), 'broken')
  const restored = store.restore({ observation: 'extension regressed', target: 'last-observed' })
  assert.equal(restored.restoredFrom, observed.workingState.commit)
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'app.txt'), 'utf8'), 'working')
  assert.notEqual(restored.candidate, iteration.baseline)

  clock += 30 * 60_000
  assert.match((await resumed.preStep({ agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }), store)).messages[0].content[0].text, /without a new recorded/)
  clock = start + 123 * 60_000
  assert.match((await resumed.preStep({ agent, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }), store)).messages[0].content[0].text, /Thirty minutes remain/)
  assert.equal(resumed.status().phase, 'stabilizing')
})

test('an open increment receives one decision boundary after twenty minutes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-increment-decision-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspaceRoot = path.join(root, 'workspace')
  const stateDir = path.join(root, 'state')
  const launchPath = path.join(root, 'start-issued.json')
  fs.mkdirSync(workspaceRoot)
  fs.mkdirSync(stateDir)
  fs.writeFileSync(path.join(workspaceRoot, '.dsh-campaign-owner'), 'rapid-cycle\n')
  fs.writeFileSync(path.join(workspaceRoot, 'app.txt'), 'base')
  git(workspaceRoot, 'init', '-q')
  git(workspaceRoot, 'add', '-A')
  git(workspaceRoot, 'commit', '-qm', 'initial')
  const start = Date.parse('2026-09-25T00:00:00Z')
  fs.writeFileSync(launchPath, JSON.stringify({ run_id: 'rapid-cycle',
    created_at: new Date(start).toISOString(), hard_seconds: 9180 }))
  let clock = start
  const opts = { runId: 'rapid-cycle', workspaceRoot, stateDir, launchPath }
  const cadence = new CadenceTracker(opts, { now: () => clock })
  const store = new IterationStore(opts)
  const session = { header: { id: 'cycle-session', cwd: workspaceRoot }, snapshotEvents: () => [] }
  const payload = { agent: { session }, signal: new AbortController().signal }
  const next = async () => ({ kind: 'enter', messages: [] })
  assert.match((await cadence.preStep(payload, next, store)).messages[0].content[0].text, /iteration_begin/)
  store.begin({ intent: 'exercise one path', expected: 'a real output' })
  store.state.active.startedAt = new Date(start).toISOString()
  store.persist()
  clock += 20 * 60_000
  assert.match((await cadence.preStep(payload, next, store)).messages[0].content[0].text, /20 minutes/)
  assert.equal((await cadence.preStep(payload, next, store)).messages.length, 0)
})
