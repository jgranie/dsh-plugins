import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { artifactRevision } from '../../dsh-acceptance-gate-prototype/src/revision.js'

const runHost = promisify(execFile)
const REVISION = { mode: 'git', maxFiles: 10_000, maxBytes: 1024 * 1024 * 1024 }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const safeName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,50}$/.test(value)

function atomic(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, file)
}

function failure(stage, category, detail, extra = {}) {
  return { ok: false, stage, category, detail: String(detail).slice(0, 1400), ...extra }
}

// This is read-only host process metadata, not GUI automation. Candidate build
// and launch still go through ctx.shell with the DSH sandbox policy.
export async function hostProcesses() {
  const { stdout } = await runHost('/bin/ps', ['-axo', 'pid=,lstart=,comm='], {
    timeout: 10_000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
  return stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/))
    .filter(Boolean).map(match => ({ pid: Number(match[1]), startIdentity: match[2].trim(),
      executable: match[3].trim() }))
}

export class NativeBuild {
  constructor({ workspaceRoot, stateDir, runId, xcodegenPath = '/opt/homebrew/bin/xcodegen' }, shell) {
    this.root = fs.realpathSync(workspaceRoot)
    this.stateDir = fs.realpathSync(stateDir)
    if (this.stateDir.startsWith(`${this.root}${path.sep}`)) throw new Error('native build state must be outside workspace')
    if (fs.readFileSync(path.join(this.root, '.dsh-campaign-owner'), 'utf8').trim() !== runId) {
      throw new Error('native build workspace ownership mismatch')
    }
    this.runId = runId
    this.xcodegen = xcodegenPath
    this.shell = shell
    this.file = path.join(this.stateDir, `${runId}.json`)
    this.receipts = path.join(this.stateDir, 'receipts')
    fs.mkdirSync(this.receipts, { recursive: true, mode: 0o700 })
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
      schemaVersion: 1, runId, project: null, managed: null, lastBuild: null, lastReceipt: null,
    }
    if (this.state.schemaVersion !== 1 || this.state.runId !== runId) throw new Error('invalid native build state')
    this.save()
  }

  save() { atomic(this.file, this.state) }
  revision() { return artifactRevision(this.root, REVISION).digest }
  output(buildId) {
    const dir = path.join(this.root, 'native-output', buildId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  async project({ mode, name, scheme, projectPath }) {
    if (!['create', 'use'].includes(mode)) throw new Error('mode must be create or use')
    if (mode === 'create') {
      if (!safeName(name)) throw new Error('name must be a Swift identifier, 2..51 characters')
      const spec = path.join(this.root, 'project.yml')
      const app = path.join(this.root, 'Sources/App.swift')
      const existing = fs.readdirSync(this.root).filter(item =>
        !['.git', '.gitignore', '.dsh-campaign-owner', 'native-output', '.npm-cache'].includes(item))
      if (existing.length && !(this.state.project?.scaffold === true && this.state.project.name === name)) {
        throw new Error(`workspace is not empty; use mode=use or inspect ${existing.slice(0, 8).join(', ')}`)
      }
      if (!fs.existsSync(spec) && !fs.existsSync(app)) {
        fs.mkdirSync(path.dirname(app), { recursive: true })
        fs.writeFileSync(spec, `name: ${name}\noptions:\n  deploymentTarget:\n    macOS: "14.0"\ntargets:\n  ${name}:\n    type: application\n    platform: macOS\n    sources: [Sources]\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: org.dsh.generated.${name.toLowerCase()}\n        GENERATE_INFOPLIST_FILE: YES\n        CODE_SIGNING_ALLOWED: NO\n        SWIFT_VERSION: "6.0"\nschemes:\n  ${name}:\n    build:\n      targets:\n        ${name}: all\n    run:\n      config: Debug\n    management:\n      shared: true\n`)
        fs.writeFileSync(app, `import SwiftUI\n\n@main struct ${name}App: App {\n    var body: some Scene { WindowGroup { Text("Ready") } }\n}\n`)
      } else if (!fs.existsSync(spec) || !fs.existsSync(app)) throw new Error('partial scaffold; inspect before continuing')
      this.state.project = { name, scheme: name, projectPath: `${name}.xcodeproj`, scaffold: true,
        providedFiles: ['project.yml', 'Sources/App.swift'],
        providedAppSha256: this.state.project?.providedAppSha256 || digest(app) }
    } else {
      const resolved = path.resolve(this.root, projectPath || '')
      if (!resolved.startsWith(`${this.root}${path.sep}`) || !resolved.endsWith('.xcodeproj') ||
          !fs.statSync(resolved).isDirectory()) throw new Error('projectPath must name an existing workspace .xcodeproj')
      if (!safeName(scheme)) throw new Error('scheme must be a simple identifier')
      this.state.project = { name: path.basename(resolved, '.xcodeproj'), scheme,
        projectPath: path.relative(this.root, resolved), scaffold: false, providedFiles: [] }
    }
    this.save()
    return { ok: true, project: this.state.project, note: 'Implement one behavior, then call native_build.' }
  }

  async alive(managed = this.state.managed) {
    if (!managed) return false
    return (await hostProcesses()).some(row => row.pid === managed.pid &&
      row.startIdentity === managed.startIdentity && row.executable === managed.executable)
  }

  recentCrash(executable, openedAt) {
    const dir = path.join(process.env.HOME || '', 'Library/Logs/DiagnosticReports')
    if (!fs.existsSync(dir)) return { report: null, pending: true }
    const name = path.basename(executable)
    const rows = fs.readdirSync(dir).filter(item => item.startsWith(`${name}-`) && item.endsWith('.ips'))
      .map(item => ({ file: path.join(dir, item), stat: fs.statSync(path.join(dir, item)) }))
      .filter(row => row.stat.mtimeMs >= openedAt - 1000).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    const latest = rows[0]
    if (!latest) return { report: null, pending: true }
    try {
      const lines = fs.readFileSync(latest.file, 'utf8').split('\n')
      const meta = JSON.parse(lines[0])
      const body = JSON.parse(lines.slice(1).join('\n'))
      return { report: latest.file, incident: meta.incident || body.incident,
        exception: body.exception?.type || null, termination: body.termination?.reason || null,
        pending: false }
    } catch { return { report: latest.file, pending: false, note: 'report was not parseable' } }
  }

  async stop() {
    const managed = this.state.managed
    if (!managed) return { ok: true, stopped: false, reason: 'no managed process' }
    if (!await this.alive(managed)) {
      this.state.managed = null; this.save()
      return { ok: true, stopped: false, reason: 'managed process already exited or identity changed' }
    }
    try { process.kill(managed.pid, 'SIGTERM') }
    catch (error) { return failure('stop', 'tool_error', error.message, { pid: managed.pid }) }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!await this.alive(managed)) {
        this.state.managed = null; this.save()
        return { ok: true, stopped: true, pid: managed.pid }
      }
      await wait(200)
    }
    return failure('stop', 'stop_timeout', 'managed process did not exit after SIGTERM', { pid: managed.pid })
  }

  async build(_args, exec) {
    const project = this.state.project
    if (!project) return failure('project', 'project_missing', 'call native_project first')
    const buildId = crypto.randomUUID()
    const dir = this.output(buildId)
    if (project.scaffold) {
      const gen = await this.shell([this.xcodegen, 'generate', '--spec', 'project.yml'], exec, 30_000,
        { log: path.join(dir, 'generate.log') })
      if (!gen.ok) return failure('generate', 'project_failed', gen.stderr || gen.stdout,
        { buildId, log: path.join(dir, 'generate.log'), exitCode: gen.exitCode })
    }
    const revision = this.revision()
    const args = ['/usr/bin/xcodebuild', '-project', project.projectPath, '-scheme', project.scheme,
      '-configuration', 'Debug', '-destination', 'platform=macOS', '-derivedDataPath', 'build',
      'CODE_SIGNING_ALLOWED=NO', 'OTHER_SWIFT_FLAGS=-disable-sandbox',
      'MTL_COMPILER_FLAGS=-fmodules-cache-path=$(PROJECT_DIR)/build/MetalModuleCache']
    const buildLog = path.join(dir, 'build.log')
    const built = await this.shell([...args, 'build'], exec, 600_000, { log: buildLog })
    this.state.lastBuild = { buildId, revision, buildLog, buildExitCode: built.exitCode,
      at: new Date().toISOString() }
    this.save()
    if (!built.ok) return failure('build', built.timedOut ? 'build_timeout' : 'build_failed',
      built.stderr || built.stdout, { buildId, log: buildLog, exitCode: built.exitCode })
    const settings = await this.shell([...args, '-showBuildSettings', '-json'], exec, 60_000)
    let rows
    try { rows = JSON.parse(settings.stdout) }
    catch { return failure('product', 'tool_error', `xcodebuild settings invalid: ${settings.stderr || settings.stdout}`) }
    if (!settings.ok || !Array.isArray(rows)) return failure('product', 'tool_error', settings.stderr || 'build settings unavailable')
    const values = rows.find(row => row.target === project.scheme)?.buildSettings || rows[0]?.buildSettings
    const productCandidate = path.resolve(values?.BUILT_PRODUCTS_DIR || '', values?.FULL_PRODUCT_NAME || '')
    const product = fs.existsSync(productCandidate) ? fs.realpathSync(productCandidate) : productCandidate
    if (!product.startsWith(`${this.root}${path.sep}`) || !product.endsWith('.app') || !fs.existsSync(product)) {
      return failure('product', 'product_missing', `built app not found: ${product}`)
    }
    const plist = await this.shell(['/usr/bin/plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-',
      path.join(product, 'Contents/Info.plist')], exec, 10_000)
    if (!plist.ok) return failure('product', 'tool_error', plist.stderr || plist.stdout)
    const bundleId = plist.stdout.trim()
    const executable = fs.realpathSync(path.join(product, 'Contents/MacOS', values.EXECUTABLE_NAME || project.name))
    const stopped = await this.stop()
    if (!stopped.ok) return stopped
    const before = await hostProcesses()
    const openedAt = Date.now()
    const opened = await this.shell(['/usr/bin/open', '-n', '-F', product], exec, 20_000)
    if (!opened.ok) return failure('launch', 'launch_failed', opened.stderr || opened.stdout)
    let managed
    for (let attempt = 0; attempt < 30; attempt++) {
      await wait(250)
      const fresh = (await hostProcesses()).filter(row => row.executable === executable &&
        !before.some(old => old.pid === row.pid && old.startIdentity === row.startIdentity))
      if (fresh.length > 1) return failure('launch', 'ambiguous_process',
        'multiple new matching app processes', { candidates: fresh })
      if (fresh.length === 1) {
        managed = { ...fresh[0], bundleId, product, revision, openedAt,
          executablePathObserved: true }
        break
      }
    }
    if (!managed) return failure('launch', 'runtime_crash', 'new app process not found after open',
      { crash: this.recentCrash(executable, openedAt) })
    this.state.managed = managed
    this.save()
    await wait(500)
    if (!await this.alive(managed)) return failure('launch', 'runtime_crash',
      'new app process exited before observation', { pid: managed.pid,
        crash: this.recentCrash(executable, openedAt) })
    if (this.revision() !== revision) return failure('launch', 'stale', 'source changed during native build')
    const receiptId = crypto.randomUUID()
    const receipt = { schemaVersion: 1, runId: this.runId, receiptId, buildId,
      builtAt: new Date().toISOString(), revision, product, executable,
      bundleId, pid: managed.pid, startIdentity: managed.startIdentity,
      providedScaffoldModified: !project.scaffold ||
        !fs.existsSync(path.join(this.root, 'Sources/App.swift')) ||
        digest(path.join(this.root, 'Sources/App.swift')) !== project.providedAppSha256 }
    const receiptPath = path.join(this.receipts, `${receiptId}.json`)
    atomic(receiptPath, receipt)
    this.state.lastReceipt = receiptPath
    this.save()
    return { ok: true, stage: 'launch', category: 'launched', receipt: receiptPath,
      revision, product, bundleId, pid: managed.pid,
      startIdentity: managed.startIdentity,
      note: 'Use Cua Driver list_windows and get_window_state on this exact PID. Interpret the image, then act and capture again.' }
  }

  async status() {
    const managed = this.state.managed
    const running = managed ? await this.alive(managed) : false
    return { ok: true, project: this.state.project, managed, running,
      lastBuild: this.state.lastBuild, lastReceipt: this.state.lastReceipt,
      ...(!running && managed ? { crash: this.recentCrash(managed.executable, managed.openedAt) } : {}) }
  }
}
