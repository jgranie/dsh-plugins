import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CadenceTracker } from '../plugins/dsh-rapid-iteration/src/cadence.js'

test('native observation needs an image read tied to a successful screencapture', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-cadence-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const workspaceRoot = path.join(root, 'workspace')
  const stateDir = path.join(root, 'state')
  fs.mkdirSync(workspaceRoot)
  fs.mkdirSync(stateDir)
  const shot = path.join(workspaceRoot, 'capture.png')
  fs.writeFileSync(shot, 'png')
  const launchPath = path.join(root, 'start-issued.json')
  fs.writeFileSync(launchPath, JSON.stringify({ run_id: 'native-test',
    created_at: new Date().toISOString(), hard_seconds: 9180 }))
  const tracker = new CadenceTracker({ runId: 'native-test', workspaceRoot, stateDir, launchPath })
  const events = []
  const agent = { session: { header: { id: 'native-session', cwd: workspaceRoot },
    snapshotEvents: () => events } }
  const image = { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png',
    bytes: 3, width: 1, height: 1 } }
  events.push({ seq: 1, type: 'tool/call', data: { callId: 'read-1', name: 'read_image',
    arguments: { file_path: shot } } })
  events.push({ seq: 2, type: 'tool/result', data: { message: { content: [
    { type: 'tool-result', toolCallId: 'read-1', isError: false, content: [image] },
  ] } } })
  assert.throws(() => tracker.recordObservation(agent, {}, { surface: 'native', outcome: 'observed',
    observation: 'window visible' }), /no matching new execution result/)
  events.unshift({ seq: 0, type: 'tool/result', data: { message: { content: [
    { type: 'tool-result', toolCallId: 'capture', isError: false, content: [] },
  ] } } })
  events.unshift({ seq: -1, type: 'tool/call', data: { callId: 'capture', name: 'bash',
    arguments: { command: `/usr/sbin/screencapture -x ${shot}` } } })
  const result = tracker.recordObservation(agent, {}, { surface: 'native', outcome: 'observed',
    observation: 'window visible' })
  assert.equal(result.evidenceKind, 'native-file-read')
  assert.equal(result.captureEventSeq, 0)
  assert.equal(typeOfTimestamp(tracker.state.firstNativeVisualAtMs), true)
})

function typeOfTimestamp(value) { return Number.isSafeInteger(value) && value > 0 }
