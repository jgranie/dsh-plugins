export function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }
const command = argv => argv.map(quote).join(' ')

export function shellRunner(ctx, workspace) {
  const policyService = ctx.shell.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (ctx.shell.sandboxMode !== undefined && !policyService) throw new Error('native-build: sandbox policy unavailable')
  return async (argv, exec, timeoutMs = 30_000, { log } = {}) => {
    const sandboxPolicy = policyService?.resolve(exec.agent ? { session: exec.agent.session } : {})
    const request = {
      command: log ? `${command(argv)} > ${quote(log)} 2>&1; result=$?; /usr/bin/tail -n 55 ${quote(log)}; exit "$result"` : command(argv),
      workdir: workspace, timeoutMs, signal: exec.signal,
      ...(ctx.shellEnv ? { dshEnv: ctx.shellEnv.collect(exec) } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    }
    const result = await (await ctx.shell.execute(ctx.shell.resolve(request))).result()
    return { ok: !result.aborted && !result.timedOut && result.exitCode === 0,
      exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
      aborted: result.aborted, stdout: result.stdout?.text || '', stderr: result.stderr?.text || '',
      sandbox: result.sandbox }
  }
}
