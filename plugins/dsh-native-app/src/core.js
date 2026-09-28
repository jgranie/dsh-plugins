import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { artifactRevision } from '../../dsh-acceptance-gate-prototype/src/revision.js'
import { parsePeekaboo, pngInfo } from './peekaboo.js'

const REVISION = { mode: 'git', maxFiles: 10_000, maxBytes: 1024 * 1024 * 1024 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const safeName = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,50}$/.test(value)

function atomic(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { flag: 'wx', mode: 0o600 })
  fs.renameSync(temporary, file)
}

function failure(stage, category, detail, extra = {}) {
  return { ok: false, stage, category, detail: String(detail).slice(0, 1400), ...extra }
}

export class NativeApp {
  constructor({ workspaceRoot, stateDir, runId, peekabooPath, xcodegenPath = '/opt/homebrew/bin/xcodegen' }, run, hostRun = run) {
    this.root = fs.realpathSync(workspaceRoot)
    this.stateDir = fs.realpathSync(stateDir)
    if (this.stateDir.startsWith(`${this.root}${path.sep}`)) throw new Error('native state must be outside workspace')
    this.runId = runId
    if (fs.readFileSync(path.join(this.root, '.dsh-campaign-owner'), 'utf8').trim() !== runId) {
      throw new Error('native workspace ownership mismatch')
    }
    this.peekaboo = fs.realpathSync(peekabooPath)
    this.xcodegen = xcodegenPath
    this.run = run
    this.hostRun = hostRun
    this.file = path.join(this.stateDir, `${runId}.json`)
    this.receipts = path.join(this.stateDir, 'receipts')
    fs.mkdirSync(this.receipts, { recursive: true, mode: 0o700 })
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) : {
      schemaVersion: 1, runId, project: null, managed: null, lastCheck: null, lastReceipt: null,
    }
    if (this.state.schemaVersion !== 1 || this.state.runId !== runId) throw new Error('invalid native state')
    this.save()
  }

  save() { atomic(this.file, this.state) }
  revision() { return artifactRevision(this.root, REVISION).digest }
  output(checkId) {
    const dir = path.join(this.root, 'native-output', checkId)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  async project({ mode, name, scheme, projectPath }, exec) {
    if (!['create', 'use'].includes(mode)) throw new Error('mode must be create or use')
    if (mode === 'create') {
      if (!safeName(name)) throw new Error('name must be a Swift identifier, 2..51 characters')
      const spec = path.join(this.root, 'project.yml')
      const app = path.join(this.root, 'Sources/App.swift')
      const existing = fs.readdirSync(this.root).filter(item => !['.git', '.gitignore', '.dsh-campaign-owner', 'native-output', '.npm-cache'].includes(item))
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
        providedAppSha256: this.state.project?.providedAppSha256 || hash(app) }
    } else {
      const resolved = path.resolve(this.root, projectPath || '')
      if (!resolved.startsWith(`${this.root}${path.sep}`) || !resolved.endsWith('.xcodeproj') || !fs.statSync(resolved).isDirectory()) {
        throw new Error('projectPath must name an existing workspace .xcodeproj')
      }
      if (!safeName(scheme)) throw new Error('scheme must be a simple identifier')
      this.state.project = { name: path.basename(resolved, '.xcodeproj'), scheme,
        projectPath: path.relative(this.root, resolved), scaffold: false, providedFiles: [] }
    }
    this.save()
    return { ok: true, project: this.state.project, note: 'Add a small behavior of your own, then call native_check and read_image.' }
  }

  async peek(args, exec, label, hostMutation = false) {
    const argv = [this.peekaboo, ...args, '--no-remote', '--json']
    return parsePeekaboo(await (hostMutation ? this.hostRun(argv, exec) : this.run(argv, exec, 30_000)), label)
  }

  async apps(exec) {
    const value = await this.peek(['app', 'list', '--include-hidden', '--include-background'], exec, 'app list')
    return value.data?.apps || []
  }

  async windows(exec, pid) {
    const value = await this.peek(['window', 'list', '--pid', String(pid)], exec, 'window list')
    return (value.data?.windows || []).filter(row => row.layer === 0 && row.is_on_screen && row.window_id > 0)
  }

  async alive(exec, managed = this.state.managed) {
    if (!managed) return false
    const app = (await this.apps(exec)).find(row => row.pid === managed.pid)
    return Boolean(app && app.process_start_identity_decimal === managed.startIdentity && app.bundle_id === managed.bundleId)
  }

  recentCrash(name, openedAt) {
    const dir = path.join(process.env.HOME || '', 'Library/Logs/DiagnosticReports')
    if (!name || !fs.existsSync(dir)) return { report: null, pending: true }
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

  async stop(exec) {
    const managed = this.state.managed
    if (!managed) return { ok: true, stopped: false, reason: 'no managed process' }
    if (!await this.alive(exec, managed)) {
      this.state.managed = null; this.save()
      return { ok: true, stopped: false, reason: 'managed process already exited or identity changed' }
    }
    try { await this.peek(['app', 'quit', '--pid', String(managed.pid),
      '--expected-process-start-identity', managed.startIdentity], exec, 'app quit', true) }
    catch (error) { return failure('stop', 'tool_error', error.message, { pid: managed.pid }) }
    this.state.managed = null
    this.save()
    return { ok: true, stopped: true, pid: managed.pid }
  }

  async capture(exec, managed, revision, checkId, windowId) {
    if (!await this.alive(exec, managed)) return failure('capture', 'runtime_crash', 'managed process exited before capture',
      { pid: managed.pid, crash: this.recentCrash(path.basename(managed.executable), managed.openedAt) })
    let windows
    for (let attempt = 0; attempt < 10; attempt++) {
      try { windows = await this.windows(exec, managed.pid) }
      catch (error) { return failure('window', 'tool_error', error.message) }
      if (windows.length || attempt === 9) break
      await sleep(500)
      if (!await this.alive(exec, managed)) return failure('window', 'runtime_crash', 'managed process exited before showing a window',
        { pid: managed.pid, crash: this.recentCrash(path.basename(managed.executable), managed.openedAt) })
    }
    const window = windowId ? windows.find(row => row.window_id === windowId) : windows.length === 1 ? windows[0] : null
    if (!window) return failure('window', windows.length ? 'ambiguous_window' : 'no_window',
      windows.length ? 'select one windowId from availableWindows' : 'no visible normal window', { availableWindows: windows })
    const file = path.join(this.output(checkId), `${crypto.randomUUID()}.png`)
    const shot = await this.run(['/usr/sbin/screencapture', '-x', '-l', String(window.window_id), file], exec, 20_000)
    if (!shot.ok || !fs.existsSync(file)) return failure('capture', 'capture_denied', shot.stderr || shot.stdout || 'targeted screenshot missing', { windowId: window.window_id })
    let dimensions
    try { dimensions = pngInfo(file) }
    catch (error) { return failure('capture', 'capture_invalid', error.message) }
    if (!await this.alive(exec, managed)) return failure('capture', 'runtime_crash', 'managed process exited after capture',
      { image: file, crash: this.recentCrash(path.basename(managed.executable), managed.openedAt) })
    if (this.revision() !== revision) return failure('capture', 'stale', 'source changed during native check', { image: file })
    const receiptId = crypto.randomUUID()
    const receipt = { schemaVersion: 1, runId: this.runId, receiptId, checkId, capturedAt: new Date().toISOString(),
      revision, product: managed.product, bundleId: managed.bundleId, pid: managed.pid,
      startIdentity: managed.startIdentity, windowId: window.window_id, image: file,
      imageSha256: hash(file), dimensions,
      providedScaffoldModified: !this.state.project?.scaffold ||
        !fs.existsSync(path.join(this.root, 'Sources/App.swift')) ||
        hash(path.join(this.root, 'Sources/App.swift')) !== this.state.project.providedAppSha256 }
    const receiptPath = path.join(this.receipts, `${receiptId}.json`)
    atomic(receiptPath, receipt)
    this.state.lastReceipt = receiptPath
    this.save()
    return { ok: true, stage: 'capture', category: 'captured', receipt: receiptPath,
      image: file, revision, pid: managed.pid, windowId: window.window_id, dimensions,
      note: 'Call read_image on image, then judge visible behavior. Capture alone does not prove it works.' }
  }

  async check({ windowId } = {}, exec) {
    const project = this.state.project
    if (!project) return failure('project', 'project_missing', 'call native_project first')
    const checkId = crypto.randomUUID()
    const dir = this.output(checkId)
    if (project.scaffold) {
      const gen = await this.run([this.xcodegen, 'generate', '--spec', 'project.yml'], exec, 30_000,
        { log: path.join(dir, 'generate.log') })
      if (!gen.ok) return failure('generate', 'project_failed', gen.stderr || gen.stdout, { checkId, log: path.join(dir, 'generate.log'), exitCode: gen.exitCode })
    }
    const revision = this.revision()
    const args = ['/usr/bin/xcodebuild', '-project', project.projectPath, '-scheme', project.scheme,
      '-configuration', 'Debug', '-destination', 'platform=macOS', '-derivedDataPath', 'build',
      'CODE_SIGNING_ALLOWED=NO', 'OTHER_SWIFT_FLAGS=-disable-sandbox',
      'MTL_COMPILER_FLAGS=-fmodules-cache-path=$(PROJECT_DIR)/build/MetalModuleCache']
    const buildLog = path.join(dir, 'build.log')
    const built = await this.run([...args, 'build'], exec, 600_000, { log: buildLog })
    this.state.lastCheck = { checkId, revision, buildLog, buildExitCode: built.exitCode, at: new Date().toISOString() }
    this.save()
    if (!built.ok) return failure('build', built.timedOut ? 'build_timeout' : 'build_failed', built.stderr || built.stdout,
      { checkId, log: buildLog, exitCode: built.exitCode })
    const settings = await this.run([...args, '-showBuildSettings', '-json'], exec, 60_000)
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
    const bundleInfo = await this.run(['/usr/bin/plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-',
      path.join(product, 'Contents/Info.plist')], exec, 10_000)
    if (!bundleInfo.ok) return failure('product', 'tool_error', bundleInfo.stderr || bundleInfo.stdout)
    const bundleId = bundleInfo.stdout.trim()
    const executable = path.join(product, 'Contents/MacOS', values.EXECUTABLE_NAME || project.name)
    const stopped = await this.stop(exec)
    if (!stopped.ok) return stopped
    const before = await this.apps(exec)
    const openedAt = Date.now()
    const opened = await this.run(['/usr/bin/open', '-n', '-F', product], exec, 20_000)
    if (!opened.ok) return failure('launch', 'launch_failed', opened.stderr || opened.stdout)
    let managed
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(500)
      const current = await this.apps(exec)
      const fresh = current.filter(row => row.bundle_id === bundleId && row.process_start_identity_decimal &&
        !before.some(old => old.pid === row.pid && old.process_start_identity_decimal === row.process_start_identity_decimal))
      if (fresh.length > 1) return failure('launch', 'ambiguous_process', 'multiple new matching app processes', { candidates: fresh })
      if (fresh.length === 1) {
        managed = { pid: fresh[0].pid, startIdentity: fresh[0].process_start_identity_decimal,
          bundleId, executable, product: fs.realpathSync(product), revision, openedAt,
          executablePathObserved: false }
        break
      }
    }
    if (!managed) return failure('launch', 'runtime_crash', 'new app process not found after open',
      { crash: this.recentCrash(path.basename(executable), openedAt) })
    this.state.managed = managed; this.save()
    await sleep(750)
    return this.capture(exec, managed, revision, checkId, windowId)
  }

  async inspect({ mode = 'status', windowId } = {}, exec) {
    if (mode === 'status') {
      const running = this.state.managed ? await this.alive(exec) : false
      return { ok: true, project: this.state.project, managed: this.state.managed,
        running, lastCheck: this.state.lastCheck, lastReceipt: this.state.lastReceipt,
        ...(!running && this.state.managed ? { crash: this.recentCrash(
          path.basename(this.state.managed.executable), this.state.managed.openedAt) } : {}) }
    }
    if (!this.state.managed || !await this.alive(exec)) return failure('inspect', 'runtime_crash', 'no running managed app')
    if (mode === 'windows') return { ok: true, windows: await this.windows(exec, this.state.managed.pid) }
    if (mode !== 'capture') throw new Error('invalid inspect mode')
    if (this.revision() !== this.state.managed.revision) return failure('inspect', 'stale', 'sources changed after build; call native_check')
    return this.capture(exec, this.state.managed, this.state.managed.revision, crypto.randomUUID(), windowId)
  }

  async input({ kind, x, y, toX, toY, key, holdMs, text, button, delivery }, exec) {
    const managed = this.state.managed
    if (!managed || !await this.alive(exec)) return failure('input', 'runtime_crash', 'no running managed app')
    if (this.revision() !== managed.revision) return failure('input', 'stale', 'sources changed after build; call native_check')
    const windows = await this.windows(exec, managed.pid)
    if (windows.length !== 1) return failure('window', windows.length ? 'ambiguous_window' : 'no_window',
      'native_input requires exactly one visible normal window', { availableWindows: windows })
    const window = windows[0]
    const target = ['--pid', String(managed.pid), '--window-id', String(window.window_id), '--foreground']
    let snapshotId = null
    if (kind === 'click' && delivery !== 'synthetic') {
      try {
        const pin = path.join(this.output(crypto.randomUUID()), 'pin.png')
        const seen = await this.peek(['see', '--pid', String(managed.pid), '--window-id',
          String(window.window_id), '--mode', 'window', '--no-elements', '--path', pin], exec, 'pin window', true)
        snapshotId = seen.data?.snapshot_id
        if (!snapshotId) throw new Error('Peekaboo did not return a snapshot id')
      } catch (error) { return failure('input', 'input_denied', error.message) }
    }
    let args
    if (['click', 'move', 'drag'].includes(kind)) {
      if (![x, y].every(Number.isSafeInteger) || x < 0 || y < 0 || x >= window.bounds.width || y >= window.bounds.height) {
        throw new Error('x,y must be inside the selected window')
      }
      if (kind === 'drag') {
        if (![toX, toY].every(Number.isSafeInteger) || toX < 0 || toY < 0 || toX >= window.bounds.width || toY >= window.bounds.height) throw new Error('toX,toY must be inside window')
        args = ['drag', '--from', `${x},${y}`, '--to', `${toX},${toY}`, ...target]
      } else args = kind === 'click'
        ? delivery === 'synthetic'
          ? ['click', '--at', `${window.bounds.x + x},${window.bounds.y + y}`, '--global',
            '--foreground', '--input-strategy', 'synthOnly',
            ...(button === 'right' ? ['--right'] : [])]
          : ['click', '--at', `${x},${y}`, '--pid', String(managed.pid), '--window-id',
            String(window.window_id), '--snapshot', snapshotId, ...(button === 'right' ? ['--right'] : [])]
        : [kind, '--at', `${x},${y}`, ...target]
    } else if (kind === 'key') {
      if (typeof key !== 'string' || !/^[A-Za-z0-9+_-]{1,40}$/.test(key)) throw new Error('invalid key chord')
      if (!Number.isSafeInteger(holdMs) || holdMs < 50 || holdMs > 2000) throw new Error('holdMs must be 50..2000')
      args = ['press', key, '--hold', `${holdMs}ms`, ...target]
    } else if (kind === 'type') {
      if (typeof text !== 'string' || !text || text.length > 200) throw new Error('text must be 1..200 characters')
      args = ['type', '--text', text, '--accept-dispatched', ...target]
    } else throw new Error('invalid input kind')
    if (kind === 'click' && delivery === 'synthetic') {
      const isFrontmost = async () => {
        const active = (await this.apps(exec)).find(row => row.is_active)
        const freshWindows = await this.windows(exec, managed.pid)
        return active?.pid === managed.pid && freshWindows.some(row =>
          row.window_id === window.window_id && row.is_frontmost)
      }
      if (!await isFrontmost()) {
        try {
          await this.peek(['window', 'focus', '--pid', String(managed.pid),
            '--window-id', String(window.window_id)], exec, 'window focus', true)
        } catch (error) { return failure('input', 'focus_failed', error.message) }
        await sleep(150)
        if (!await isFrontmost()) {
          return failure('input', 'focus_mismatch', 'managed window is not frontmost after focus; synthetic global click refused')
        }
      }
    }
    let action
    try { action = await this.peek(args, exec, kind, true) }
    catch (error) { return failure('input', 'input_denied', error.message) }
    const captured = await this.capture(exec, managed, managed.revision, crypto.randomUUID(), window.window_id)
    return { ...captured, input: { kind, delivery: kind === 'click' ? (delivery || 'accessibility') : 'foreground',
      dispatched: true, effectVerified: false,
      result: action.data?.result || null } }
  }
}
