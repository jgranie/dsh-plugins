import fs from 'node:fs'
import { execFile } from 'node:child_process'

export function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }
export function command(argv) { return argv.map(quote).join(' ') }

export function shellRunner(ctx, workspace) {
  const policyService = ctx.shell.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (ctx.shell.sandboxMode !== undefined && !policyService) throw new Error('native-app: sandbox policy unavailable')
  return async (argv, exec, timeoutMs = 30_000, { log } = {}) => {
    const sandboxPolicy = policyService?.resolve(exec.agent ? { session: exec.agent.session } : {})
    const request = {
      command: log ? `${command(argv)} > ${quote(log)} 2>&1; result=$?; /usr/bin/tail -n 55 ${quote(log)}; exit "$result"` : command(argv),
      workdir: workspace, timeoutMs, signal: exec.signal,
      ...(ctx.shellEnv ? { dshEnv: ctx.shellEnv.collect(exec) } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    }
    const result = await ctx.shell.run(ctx.shell.resolve(request))
    return { ok: !result.aborted && !result.timedOut && result.exitCode === 0,
      exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
      aborted: result.aborted, stdout: result.stdout?.text || '', stderr: result.stderr?.text || '',
      sandbox: result.sandbox }
  }
}

// UI mutation is a declared host capability. Peekaboo 4.6.0 deliberately keeps
// its cross-process mutation journal in the account's physical home directory;
// workspace-write cannot run these commands. This function accepts only a
// frozen executable and argv built by the plugin. Candidate builds still use
// ctx.shell and the DSH sandbox.
export function hostMutationRunner(binary) {
  return (argv, exec) => new Promise(resolve => {
    if (argv[0] !== binary) throw new Error('host mutation executable mismatch')
    execFile(binary, argv.slice(1), { encoding: 'utf8', timeout: 30_000,
      maxBuffer: 4_000_000, ...(exec.signal ? { signal: exec.signal } : {}) }, (error, stdout, stderr) => {
      resolve({ ok: !error, exitCode: error?.code || 0, stdout, stderr,
        timedOut: error?.killed || false, aborted: exec.signal?.aborted || false })
    })
  })
}

export function parsePeekaboo(result, label) {
  let payload
  try { payload = JSON.parse(result.stdout) }
  catch { throw new Error(`${label}: invalid Peekaboo JSON: ${(result.stderr || result.stdout).slice(0, 400)}`) }
  if (!result.ok || payload?.success !== true) {
    throw new Error(`${label}: ${payload?.error?.code || 'tool_error'}: ${payload?.error?.message || result.stderr || `exit ${result.exitCode}`}`)
  }
  return payload
}

export function pngInfo(file) {
  const data = fs.readFileSync(file)
  if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('capture is not a PNG')
  const width = data.readUInt32BE(16)
  const height = data.readUInt32BE(20)
  if (!width || !height) throw new Error('capture dimensions invalid')
  return { width, height }
}
