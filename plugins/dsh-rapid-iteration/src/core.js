import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function git(cwd, ...args) {
  const result = spawnSync('/usr/bin/git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 8_000_000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'dsh campaign', GIT_AUTHOR_EMAIL: 'dsh-campaign@localhost',
      GIT_COMMITTER_NAME: 'dsh campaign', GIT_COMMITTER_EMAIL: 'dsh-campaign@localhost' },
  })
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || '').slice(0, 500)}`)
  return result.stdout.trim()
}

function saveJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
  fs.renameSync(temp, file)
}

function bounded(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be 1..${max} characters`)
  return value.trim()
}

export class IterationStore {
  constructor({ workspaceRoot, stateDir, runId }) {
    this.runId = bounded(runId, 'runId', 100)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(this.runId)) throw new Error('invalid runId')
    this.root = fs.realpathSync(bounded(workspaceRoot, 'workspaceRoot', 4096))
    this.stateDir = fs.realpathSync(bounded(stateDir, 'stateDir', 4096))
    if (this.stateDir === this.root || this.stateDir.startsWith(`${this.root}${path.sep}`)) throw new Error('stateDir must be outside workspace')
    const marker = path.join(this.root, '.dsh-campaign-owner')
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8').trim() !== this.runId) throw new Error('workspace is not exclusively owned by this run')
    if (git(this.root, 'rev-parse', '--show-toplevel') !== this.root) throw new Error('workspace must be the Git root')
    if (git(this.root, 'rev-parse', '--is-shallow-repository') !== 'false') throw new Error('shallow repository unsupported')
    this.statePath = path.join(this.stateDir, `${this.runId}.json`)
    this.state = fs.existsSync(this.statePath)
      ? JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      : { schemaVersion: 1, runId: this.runId, active: null, lastWorking: null, lastObserved: null,
          history: [] }
    if (this.state.schemaVersion !== 1 || this.state.runId !== this.runId || !Array.isArray(this.state.history)) {
      throw new Error('invalid iteration state')
    }
    this.persist()
  }

  persist() { saveJson(this.statePath, this.state) }

  checkpoint(label) {
    git(this.root, 'add', '-A', '--', '.')
    if (git(this.root, 'status', '--porcelain')) git(this.root, 'commit', '-m', label)
    return git(this.root, 'rev-parse', 'HEAD')
  }

  begin({ intent, expected }) {
    if (this.state.active) throw new Error('finish or restore the current iteration first')
    const baseline = this.checkpoint('dsh: baseline before iteration')
    this.state.active = { id: crypto.randomUUID(), intent: bounded(intent, 'intent'),
      expected: bounded(expected, 'expected'), baseline, startedAt: new Date().toISOString() }
    this.persist()
    return { ...this.state.active, lastWorking: this.state.lastWorking }
  }

  finish({ observation, decision }) {
    const active = this.state.active
    if (!active) throw new Error('no active iteration')
    if (!['keep', 'continue', 'restore'].includes(decision)) throw new Error('decision must be keep, continue, or restore')
    const candidate = this.checkpoint('dsh: iteration candidate')
    const entry = { ...active, candidate, observation: bounded(observation, 'observation', 1200),
      decision, finishedAt: new Date().toISOString() }
    if (decision === 'restore') return this.restore({ observation: entry.observation, candidate })
    this.state.history.push(entry)
    this.state.active = null
    this.persist()
    return { ...entry, lastWorking: this.state.lastWorking }
  }

  restore({ observation, candidate: savedCandidate, target = 'baseline' } = {}) {
    const active = this.state.active
    if (!active) throw new Error('no active iteration')
    if (!['baseline', 'last-observed'].includes(target)) throw new Error('invalid restore target')
    const source = target === 'last-observed' ? this.state.lastObserved?.commit : active.baseline
    if (!source) throw new Error('no previously observed working state')
    const candidate = savedCandidate || this.checkpoint('dsh: rejected iteration backup')
    // The candidate commit is the rescue copy. The workspace is exclusively ours.
    git(this.root, 'restore', '--source', source, '--staged', '--worktree', '--', '.')
    git(this.root, 'commit', '--allow-empty', '-m', 'dsh: restore observed or baseline state')
    const restored = git(this.root, 'rev-parse', 'HEAD')
    const expectedTree = git(this.root, 'rev-parse', `${source}^{tree}`)
    const restoredTree = git(this.root, 'rev-parse', `${restored}^{tree}`)
    if (expectedTree !== restoredTree) throw new Error('restored tree differs from baseline; rescue commit retained')
    const entry = { ...active, candidate, restored, restoredFrom: source, target,
      observation: String(observation || 'restored by agent').slice(0, 1200),
      decision: 'restore', finishedAt: new Date().toISOString() }
    this.state.history.push(entry)
    this.state.active = null
    this.persist()
    return { ...entry, lastWorking: this.state.lastWorking,
      note: 'Files restored. Recheck the running process, browser, and dependencies.' }
  }

  status() {
    return { runId: this.runId, active: this.state.active, lastWorking: this.state.lastWorking,
      lastObserved: this.state.lastObserved,
      recent: this.state.history.slice(-3), head: git(this.root, 'rev-parse', 'HEAD') }
  }

  recordObserved({ surface, observation, sourceEventSeq, sourceEventHash }) {
    const commit = this.checkpoint('dsh: observed working state')
    this.state.lastObserved = { commit, surface, observation: bounded(observation, 'observation', 1200),
      sourceEventSeq, sourceEventHash, recordedAt: new Date().toISOString() }
    this.state.lastWorking = commit
    if (this.state.active) {
      this.state.history.push({ ...this.state.active, candidate: commit,
        observation: this.state.lastObserved.observation, decision: 'keep',
        finishedAt: new Date().toISOString(), evidenceSeq: sourceEventSeq })
      this.state.active = null
    }
    this.persist()
    return this.state.lastObserved
  }
}
