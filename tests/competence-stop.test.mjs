import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CompetenceGate } from '../plugins/dsh-competence-stop/src/index.js'

function fixture(t, runId = 'competence-test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-competence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspaceRoot = path.join(root, 'workspace')
  const stateDir = path.join(root, 'control')
  fs.mkdirSync(workspaceRoot)
  fs.mkdirSync(stateDir)
  fs.writeFileSync(path.join(workspaceRoot, '.dsh-campaign-owner'), `${runId}\n`)
  const launchPath = path.join(root, 'start-issued.json')
  fs.writeFileSync(launchPath, JSON.stringify({ run_id: runId,
    created_at: '2026-09-25T00:00:00Z' }))
  const events = []
  const agent = { session: { header: { id: 'session-one', cwd: workspaceRoot },
    snapshotEvents: () => events } }
  return { workspaceRoot, stateDir, launchPath, runId, events, agent }
}

function tool(events, seq, id, name, result) {
  events.push({ seq, type: 'tool/call', data: { callId: id, name,
    arguments: result.arguments || {} } })
  events.push({ seq: seq + 1, type: 'tool/result', data: { message: { content: [
    { type: 'tool-result', toolCallId: id, isError: result.error,
      content: result.content || [{ type: 'text', text: result.text }] },
  ] } } })
}

test('the guard blocks coding before scope and requires a successful probe before proceeding', async t => {
  const setup = fixture(t)
  let now = Date.parse('2026-09-25T00:30:00Z')
  const gate = new CompetenceGate(setup, { now: () => now })
  const exec = name => ({ agent: setup.agent, name })
  assert.equal((await gate.preExecute(exec('bash'), async () => 'allowed')).kind, 'deny')
  assert.equal(await gate.preExecute(exec('read'), async () => 'allowed'), 'allowed')
  gate.scope(setup.agent, { capability: 'compile a minimal view', approach: 'SwiftUI window',
    probe: 'build and open it', expected: 'visible window' })
  assert.throws(() => gate.result(setup.agent, { outcome: 'can_proceed',
    observation: 'seems possible', missingKnowledge: '' }), /successful representative execution/)
  tool(setup.events, 1, 'failed', 'bash', { error: false, text: 'error: tests failed' })
  assert.throws(() => gate.result(setup.agent, { outcome: 'can_proceed',
    observation: 'the build failed', missingKnowledge: '' }), /successful representative execution/)
  tool(setup.events, 3, 'succeeded', 'bash', { error: false, text: 'BUILD SUCCEEDED' })
  assert.equal(gate.result(setup.agent, { outcome: 'can_proceed',
    observation: 'minimal app built', missingKnowledge: '' }).status, 'ready')
  now += 2_000_000
  assert.equal(await gate.preExecute(exec('bash'), async () => 'allowed'), 'allowed')
})

test('a precise knowledge gap persists and prevents further edits', async t => {
  const setup = fixture(t, 'competence-gap')
  let now = Date.parse('2026-09-25T00:00:00Z')
  const gate = new CompetenceGate(setup, { now: () => now })
  gate.scope(setup.agent, { capability: 'native window observation',
    approach: 'use installed platform tools', probe: 'open and capture', expected: 'image' })
  now += 1_200_000
  assert.equal((await gate.preExecute({ agent: setup.agent, name: 'bash' },
    async () => 'allowed')).kind, 'deny')
  const state = gate.result(setup.agent, { outcome: 'knowledge_gap',
    observation: 'no viable capture method known', missingKnowledge: 'how to capture the native app window' })
  assert.equal(state.status, 'stopped')
  assert.equal(state.verdict.category, 'knowledge_gap')
  assert.equal((await gate.preExecute({ agent: setup.agent, name: 'bash' },
    async () => 'allowed')).kind, 'deny')
  assert.equal(JSON.parse(fs.readFileSync(path.join(setup.stateDir, 'competence-gap.json'))).status, 'stopped')
  const resumed = new CompetenceGate(setup, { now: () => now })
  assert.equal(resumed.status(setup.agent).status, 'stopped')
})

test('native image evidence rejects a build-only verdict and accepts a sourced capture', t => {
  const setup = fixture(t, 'competence-native')
  const gate = new CompetenceGate({ ...setup, requiredEvidence: 'native-image' })
  gate.scope(setup.agent, { capability: 'render a visible native view',
    approach: 'build and launch SwiftUI', probe: 'capture and inspect the window',
    expected: 'image of the app window' })
  tool(setup.events, 1, 'build', 'bash', { error: false, text: 'BUILD SUCCEEDED' })
  assert.throws(() => gate.result(setup.agent, { outcome: 'can_proceed',
    observation: 'built but screencapture failed', missingKnowledge: '' }),
  /captured native image/)
  const shot = path.join(setup.workspaceRoot, 'window.png')
  fs.writeFileSync(shot, 'png')
  tool(setup.events, 3, 'capture', 'bash', { error: false, text: '',
    arguments: { command: `/usr/sbin/screencapture -x ${shot}` } })
  tool(setup.events, 5, 'read', 'read_image', { error: false,
    arguments: { file_path: shot }, content: [{ type: 'image', attachment: {
      attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    } }] })
  const status = gate.result(setup.agent, { outcome: 'can_proceed',
    observation: 'captured and inspected the native view', missingKnowledge: '' })
  assert.equal(status.status, 'ready')
  assert.equal(status.verdict.captureEventSeq, 4)
})

test('advisory target urges the probe without blocking its execution or weakening evidence', async t => {
  const setup = fixture(t, 'competence-advisory')
  let now = Date.parse('2026-09-25T00:00:00Z')
  const gate = new CompetenceGate({ ...setup, requiredEvidence: 'native-image',
    deadlinePolicy: 'advisory', probeSeconds: 60 }, { now: () => now })
  gate.scope(setup.agent, { capability: 'display a native view', approach: 'SwiftUI window',
    probe: 'build, capture and inspect', expected: 'visible image' })
  now += 31_000
  const early = await gate.preStep({ agent: setup.agent, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }))
  assert.match(early.messages[0].content[0].text, /early probe checkpoint/)
  now += 31_000
  const due = await gate.preStep({ agent: setup.agent, signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }))
  assert.match(due.messages[0].content[0].text, /does not block tools/)
  assert.equal(await gate.preExecute({ agent: setup.agent, name: 'bash' },
    async () => 'allowed'), 'allowed')
  assert.equal(await gate.preExecute({ agent: setup.agent, name: 'write' },
    async () => 'allowed'), 'allowed')
  tool(setup.events, 1, 'build', 'bash', { error: false, text: 'BUILD SUCCEEDED' })
  assert.throws(() => gate.result(setup.agent, { outcome: 'can_proceed',
    observation: 'built but not captured', missingKnowledge: '' }), /captured native image/)
})
