import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { IterationStore } from '../plugins/dsh-rapid-iteration/src/core.js'
import { apply as registerIterationTools } from '../plugins/dsh-rapid-iteration/src/index.js'
import { publicBrowserPath } from '../plugins/dsh-acceptance-gate-prototype/src/index.js'
import { browserVisualEvidence, executionFailure } from '../plugins/dsh-acceptance-gate-prototype/src/evidence.js'

function git(cwd, ...args) {
  const result = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost' } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

test('restore returns additions, modifications and deletions to the baseline while preserving a rescue commit', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rapid-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const workspaceRoot = path.join(dir, 'workspace')
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(workspaceRoot)
  fs.mkdirSync(stateDir)
  fs.writeFileSync(path.join(workspaceRoot, '.dsh-campaign-owner'), 'rapid-test\n')
  fs.writeFileSync(path.join(workspaceRoot, 'keep.txt'), 'baseline')
  fs.writeFileSync(path.join(workspaceRoot, 'delete.txt'), 'baseline')
  git(workspaceRoot, 'init', '-q')
  git(workspaceRoot, 'add', '-A')
  git(workspaceRoot, 'commit', '-qm', 'initial')
  const store = new IterationStore({ workspaceRoot, stateDir, runId: 'rapid-test' })
  const started = store.begin({ intent: 'extend output', expected: 'observable result' })
  fs.writeFileSync(path.join(workspaceRoot, 'keep.txt'), 'changed')
  fs.unlinkSync(path.join(workspaceRoot, 'delete.txt'))
  fs.writeFileSync(path.join(workspaceRoot, 'new.txt'), 'new')
  const result = store.restore({ observation: 'bad result' })
  assert.equal(result.baseline, started.baseline)
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'keep.txt'), 'utf8'), 'baseline')
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'delete.txt'), 'utf8'), 'baseline')
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'new.txt')), false)
  assert.equal(git(workspaceRoot, 'show', `${result.candidate}:new.txt`), 'new')
  assert.equal(git(workspaceRoot, 'rev-parse', `${result.restored}^{tree}`), git(workspaceRoot, 'rev-parse', `${started.baseline}^{tree}`))
  assert.equal(new IterationStore({ workspaceRoot, stateDir, runId: 'rapid-test' }).status().recent[0].decision, 'restore')
  const definitions = new Map()
  registerIterationTools({
    tools: { register(definition) { definitions.set(definition.name, definition); return () => {} } },
    systemPrompt: { section() { return () => {} } }, effect() {},
  }, { workspaceRoot, stateDir, runId: 'rapid-test' })
  assert.deepEqual([...definitions.keys()], ['iteration_begin', 'iteration_finish', 'iteration_restore', 'iteration_status'])
  assert.equal(definitions.get('iteration_status').execute({}, { agent: { session: { header: { cwd: workspaceRoot } } } }).recent[0].decision, 'restore')
})

test('a workspace with another owner is refused', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rapid-owner-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const workspaceRoot = path.join(dir, 'workspace')
  const stateDir = path.join(dir, 'state')
  fs.mkdirSync(workspaceRoot)
  fs.mkdirSync(stateDir)
  fs.writeFileSync(path.join(workspaceRoot, '.dsh-campaign-owner'), 'someone-else\n')
  assert.throws(() => new IterationStore({ workspaceRoot, stateDir, runId: 'rapid-test' }), /exclusively owned/)
})

function pair(seq, name, args = {}) {
  const id = `call-${seq}`
  return [
    { seq, type: 'tool/call', data: { callId: id, name, arguments: args } },
    { seq: seq + 1, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: id, content: [] }] } } },
  ]
}

test('browser path needs real action and becomes instrumented after page evaluation', () => {
  const origins = ['http://127.0.0.1:5173']
  const nav = pair(1, 'mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:5173/' })
  const click = pair(3, 'mcp__playwright__browser_click', { element: 'Play' })
  assert.equal(publicBrowserPath([...nav], 4, origins).cleanInteraction, false)
  assert.equal(publicBrowserPath([...nav, ...click], 4, origins).cleanInteraction, true)
  const evaluated = pair(5, 'mcp__playwright__browser_evaluate', { function: '() => document.body.remove()' })
  assert.equal(publicBrowserPath([...nav, ...click, ...evaluated], 6, origins).cleanInteraction, false)
  const fresh = pair(7, 'mcp__playwright__browser_navigate', { url: 'http://127.0.0.1:5173/' })
  assert.equal(publicBrowserPath([...nav, ...click, ...evaluated, ...fresh, ...pair(9, 'mcp__playwright__browser_click')], 10, origins).cleanInteraction, true)
})

test('a named screenshot followed by read_image is one provenance-bound visual observation', () => {
  const workspace = '/tmp/rapid-evidence-workspace'
  const capture = pair(1, 'mcp__playwright__browser_take_screenshot',
    { filename: 'browser-output/view.png' })
  capture[1].data.message.content[0].content = [{ type: 'text',
    text: '### Result\n- [Screenshot of viewport](browser-output/view.png)' }]
  const read = pair(3, 'read_image', { file_path: `${workspace}/browser-output/view.png` })
  read[1].data.message.content[0].content = [
    { type: 'text', text: `<path>${workspace}/browser-output/view.png</path>` },
    { type: 'image', attachment: { attachmentId: 'sha256:test', mediaType: 'image/png',
      bytes: 100, width: 10, height: 10 } },
  ]
  const events = [...capture, ...read]
  assert.deepEqual(browserVisualEvidence(events, read[1], workspace), {
    kind: 'file-read', sourceEventSeq: 4, captureEventSeq: 2,
    file: `${workspace}/browser-output/view.png`,
  })
  const unrelated = pair(5, 'read_image', { file_path: `${workspace}/other.png` })
  unrelated[1].data.message.content[0].content = read[1].data.message.content[0].content
  assert.equal(browserVisualEvidence([...events, ...unrelated], unrelated[1], workspace), null)
})

test('filtered test failures remain visible as drift signals', () => {
  const event = { data: {} }
  const result = { isError: false, content: [{ type: 'text',
    text: '✔ one test\n✖ collision: player crossed wall\nℹ fail 1\n' }] }
  assert.match(executionFailure(event, result), /collision/)
  assert.equal(executionFailure(event, { isError: false,
    content: [{ type: 'text', text: '✔ all tests\nℹ fail 0' }] }), null)
})
