import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { sha256 } from './core.js'
import { artifactRevision } from './revision.js'

const execFileAsync = promisify(execFile)

function resolveWorkdir(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('check workdir must be relative')
  const result = path.resolve(root, relative)
  if (result !== root && !result.startsWith(`${root}${path.sep}`)) throw new Error('check workdir escapes workspace')
  const canonicalRoot = fs.realpathSync(root)
  const canonicalResult = fs.realpathSync(result)
  if (canonicalResult !== canonicalRoot && !canonicalResult.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('check workdir follows a link outside workspace')
  }
  return result
}

export async function runConfiguredCheck(workspace, revisionSpec, check, signal) {
  const before = artifactRevision(workspace, revisionSpec).digest
  let stdout = '', stderr = '', exitCode = null, timedOut = false, executionError = null
  try {
    const result = await execFileAsync(check.program, check.args, {
      cwd: resolveWorkdir(path.resolve(workspace), check.workdir), timeout: check.timeoutMs,
      maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
      ...(signal ? { signal } : {}),
    })
    stdout = result.stdout || ''
    stderr = result.stderr || ''
    exitCode = 0
  } catch (error) {
    stdout = String(error?.stdout || '')
    stderr = String(error?.stderr || '')
    exitCode = Number.isSafeInteger(error?.code) ? error.code : null
    timedOut = error?.killed === true && error?.signal !== undefined
    executionError = String(error?.code || error?.message || 'process-error').slice(0, 120)
  }
  const after = artifactRevision(workspace, revisionSpec).digest
  const changed = before !== after
  const expectedSeen = check.expectedText === null || `${stdout}\n${stderr}`.includes(check.expectedText)
  const outcome = executionError && exitCode === null ? 'inconclusive'
    : changed && !check.allowRevisionChange ? 'inconclusive'
      : exitCode === 0 && !timedOut && expectedSeen ? 'pass' : 'fail'
  return { checkId: check.id, outcome, exitCode, timedOut, expectedSeen, changed,
    revisionDigest: after, outputDigest: sha256(`${stdout}\n${stderr}`), executionError }
}
