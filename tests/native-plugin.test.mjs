import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { NativeApp } from '../plugins/dsh-native-app/src/core.js'
import { parsePeekaboo } from '../plugins/dsh-native-app/src/peekaboo.js'
import { artifactRevision } from '../plugins/dsh-acceptance-gate-prototype/src/revision.js'
import { executionFailure, nativeVisualEvidence } from '../plugins/dsh-acceptance-gate-prototype/src/evidence.js'

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'native-plugin-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'workspace')
  const stateDir = path.join(base, 'control/native')
  const peekabooPath = path.join(base, 'peekaboo-test-placeholder')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(peekabooPath, '')
  fs.writeFileSync(path.join(root, '.dsh-campaign-owner'), 'test-run\n')
  fs.writeFileSync(path.join(root, '.gitignore'), 'native-output/\nbuild/\n')
  fs.writeFileSync(path.join(root, 'App.swift'), 'import SwiftUI\n')
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-q', '-m', 'fixture']]) {
    const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost' } })
    assert.equal(result.status, 0, result.stderr)
  }
  return { base, root: fs.realpathSync(root), workspaceRoot: fs.realpathSync(root),
    stateDir: fs.realpathSync(stateDir), runId: 'test-run',
    peekabooPath }
}

const result = (callId, seq, content) => ({ seq, type: 'tool/result', data: { message: { content: [
  { type: 'tool-result', toolCallId: callId, isError: false, content },
] } } })

test('native receipt requires matching image, source revision and tool result', t => {
  const info = fixture(t)
  const dir = path.join(info.root, 'native-output', 'check-1')
  fs.mkdirSync(dir, { recursive: true })
  const image = path.join(dir, 'window.png')
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==', 'base64'))
  const revision = artifactRevision(info.root, { mode: 'git' }).digest
  const receiptPath = path.join(info.stateDir, 'receipts', 'a.json')
  fs.mkdirSync(path.dirname(receiptPath))
  const receipt = { schemaVersion: 1, runId: info.runId, revision, image, pid: 101,
    windowId: 102, imageSha256: crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex'),
    providedScaffoldModified: true }
  fs.writeFileSync(receiptPath, JSON.stringify(receipt))
  const events = [
    { seq: 1, type: 'tool/call', data: { callId: 'capture', name: 'native_check', arguments: {} } },
    result('capture', 2, [{ type: 'text', text: JSON.stringify({ ok: true, image, receipt: receiptPath,
      revision, pid: 101, windowId: 102 }) }]),
    { seq: 3, type: 'tool/call', data: { callId: 'read', name: 'read_image', arguments: { file_path: image } } },
    result('read', 4, [{ type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png',
      bytes: 68, width: 1, height: 1 } }]),
  ]
  assert.equal(nativeVisualEvidence(events, events[3], info.root, { requireReceipt: true })?.kind, 'native-receipt-read')
  fs.writeFileSync(path.join(info.root, 'App.swift'), 'changed\n')
  assert.equal(nativeVisualEvidence(events, events[3], info.root, { requireReceipt: true }), null)
  fs.writeFileSync(path.join(info.root, 'App.swift'), 'import SwiftUI\n')
  fs.appendFileSync(image, 'tampered')
  assert.equal(nativeVisualEvidence(events, events[3], info.root, { requireReceipt: true }), null)
})

test('Peekaboo JSON success false defeats zero exit code', () => {
  assert.throws(() => parsePeekaboo({ ok: true, exitCode: 0,
    stdout: JSON.stringify({ success: false, error: { code: 'DENIED', message: 'no permission' } }) }, 'click'),
  /DENIED: no permission/)
})

test('structured native failure is visible to cadence', () => {
  const event = result('native', 2, [{ type: 'text', text: JSON.stringify({ ok: false,
    stage: 'build', category: 'build_failed', detail: 'Swift compile error' }) }])
  assert.match(executionFailure(event, event.data.message.content[0]), /build_failed: Swift compile error/)
})

test('neutral scaffold generates a shared scheme and remains idempotent',
  { skip: !fs.existsSync('/opt/homebrew/bin/xcodegen') }, async t => {
  const info = fixture(t)
  fs.rmSync(path.join(info.root, 'App.swift'))
  const native = new NativeApp(info, async () => { throw new Error('no shell command expected') })
  const project = await native.project({ mode: 'create', name: 'SampleApp' }, {})
  assert.equal(project.project.scaffold, true)
  const original = project.project.providedAppSha256
  const generated = spawnSync('/opt/homebrew/bin/xcodegen', ['generate', '--spec', 'project.yml'],
    { cwd: info.root, encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)
  assert.ok(fs.existsSync(path.join(info.root, 'SampleApp.xcodeproj/xcshareddata/xcschemes/SampleApp.xcscheme')))
  fs.appendFileSync(path.join(info.root, 'Sources/App.swift'), '// added behavior\n')
  await native.project({ mode: 'create', name: 'SampleApp' }, {})
  assert.equal(native.state.project.providedAppSha256, original)
})

test('failed build never opens an old product; changed process identity is never quit', async t => {
  const info = fixture(t)
  const calls = []
  const run = async argv => {
    calls.push(argv)
    if (argv[0].endsWith('xcodegen')) return { ok: true, exitCode: 0, stdout: '', stderr: '' }
    if (argv[0] === '/usr/bin/xcodebuild') return { ok: false, exitCode: 65, stdout: 'compile error', stderr: '' }
    if (argv.includes('list')) return { ok: true, exitCode: 0,
      stdout: JSON.stringify({ success: true, data: { apps: [{ pid: 101, bundle_id: 'org.example.app',
        process_start_identity_decimal: 'new-generation' }] } }), stderr: '' }
    throw new Error(`unexpected command: ${argv.join(' ')}`)
  }
  const native = new NativeApp(info, run)
  native.state.project = { name: 'Example', scheme: 'Example', projectPath: 'Example.xcodeproj', scaffold: true }
  const checked = await native.check({}, { signal: new AbortController().signal })
  assert.equal(checked.category, 'build_failed')
  assert.equal(calls.some(argv => argv[0] === '/usr/bin/open'), false)
  native.state.managed = { pid: 101, startIdentity: 'old-generation', bundleId: 'org.example.app' }
  const stopped = await native.stop({ signal: new AbortController().signal })
  assert.equal(stopped.stopped, false)
  assert.equal(calls.some(argv => argv.includes('quit')), false)
})

test('synthetic click refuses to dispatch when the managed window is not frontmost', async t => {
  const info = fixture(t)
  const hostCalls = []
  const native = new NativeApp(info, async () => { throw new Error('sandbox command unexpected') },
    async argv => {
      hostCalls.push(argv)
      return { ok: true, exitCode: 0, stdout: JSON.stringify({ success: true, data: {} }), stderr: '' }
    })
  native.state.managed = { pid: 101, startIdentity: 'generation-1', bundleId: 'org.example.app',
    revision: native.revision() }
  native.alive = async () => true
  native.windows = async () => [{ window_id: 55, layer: 0, is_on_screen: true,
    is_frontmost: false, bounds: { x: 100, y: 100, width: 400, height: 300 } }]
  native.apps = async () => [{ pid: 202, is_active: true }]
  const outcome = await native.input({ kind: 'click', delivery: 'synthetic', x: 100, y: 100 }, {})
  assert.equal(outcome.category, 'focus_mismatch')
  assert.equal(hostCalls.length, 1)
  assert.deepEqual(hostCalls[0].slice(1, 3), ['window', 'focus'])
})

test('synthetic click focuses the managed window and rechecks before dispatch', async t => {
  const info = fixture(t)
  const hostCalls = []
  let frontmost = false
  const native = new NativeApp(info, async () => { throw new Error('sandbox command unexpected') },
    async argv => {
      hostCalls.push(argv)
      if (argv[1] === 'window') frontmost = true
      return { ok: true, exitCode: 0, stdout: JSON.stringify({ success: true, data: {} }), stderr: '' }
    })
  native.state.managed = { pid: 101, startIdentity: 'generation-1', bundleId: 'org.example.app',
    revision: native.revision() }
  native.alive = async () => true
  native.windows = async () => [{ window_id: 55, layer: 0, is_on_screen: true,
    is_frontmost: frontmost, bounds: { x: 100, y: 100, width: 400, height: 300 } }]
  native.apps = async () => [{ pid: frontmost ? 101 : 202, is_active: true }]
  native.capture = async () => ({ ok: true, image: '/fixture/after.png' })
  const outcome = await native.input({ kind: 'click', delivery: 'synthetic', x: 20, y: 30 }, {})
  assert.equal(outcome.ok, true)
  assert.equal(hostCalls.length, 2)
  assert.deepEqual(hostCalls[0].slice(1, 3), ['window', 'focus'])
  assert.deepEqual(hostCalls[1].slice(1, 4), ['click', '--at', '120,130'])
})

test('native capture distinguishes an exited app from a denied window capture', async t => {
  const info = fixture(t)
  const native = new NativeApp(info, async argv => {
    if (argv[0] === '/usr/sbin/screencapture') return { ok: false, exitCode: 1,
      stdout: '', stderr: 'could not create image from display' }
    throw new Error(`unexpected command: ${argv.join(' ')}`)
  })
  const managed = { pid: 101, executable: '/workspace/Example.app/Contents/MacOS/Example',
    openedAt: Date.now() }
  native.recentCrash = () => ({ report: null, pending: true })
  native.alive = async () => false
  const crashed = await native.capture({}, managed, native.revision(), 'crash', 55)
  assert.equal(crashed.category, 'runtime_crash')
  assert.equal(crashed.crash.pending, true)
  native.alive = async () => true
  native.windows = async () => [{ window_id: 55, layer: 0, is_on_screen: true }]
  const denied = await native.capture({}, managed, native.revision(), 'denied', 55)
  assert.equal(denied.category, 'capture_denied')
  assert.match(denied.detail, /could not create image/)
})
