import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function relativePath(root, value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error('artifact path must be relative')
  const resolved = path.resolve(root, value)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`artifact path escapes workspace: ${value}`)
  return resolved
}

function collectFile(hash, filename, root, canonicalRoot, limits, counters) {
  let segmentPath = root
  for (const segment of path.relative(root, filename).split(path.sep).filter(Boolean)) {
    segmentPath = path.join(segmentPath, segment)
    if (fs.lstatSync(segmentPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`symbolic link cannot be fingerprinted safely: ${segmentPath}`)
    }
  }
  const stats = fs.lstatSync(filename, { throwIfNoEntry: false })
  hash.update(filename)
  if (!stats) { hash.update('ABSENT'); return }
  if (stats.isSymbolicLink()) throw new Error(`symbolic link cannot be fingerprinted safely: ${filename}`)
  const actual = fs.realpathSync(filename)
  if (actual !== canonicalRoot && !actual.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`artifact resolves outside workspace: ${filename}`)
  }
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(filename).sort()) {
      if (entry === '.git') continue
      collectFile(hash, path.join(filename, entry), root, canonicalRoot, limits, counters)
    }
    return
  }
  if (!stats.isFile()) throw new Error(`unsupported artifact type: ${filename}`)
  counters.files += 1
  counters.bytes += stats.size
  if (counters.files > limits.maxFiles || counters.bytes > limits.maxBytes) {
    throw new Error('artifact revision exceeded configured file or byte limit')
  }
  hash.update('FILE')
  hash.update(fs.readFileSync(filename))
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
}

export function artifactRevision(cwd, spec) {
  const root = path.resolve(cwd)
  const canonicalRoot = fs.realpathSync(root)
  const limits = { maxFiles: spec.maxFiles ?? 10_000, maxBytes: spec.maxBytes ?? 1024 * 1024 * 1024 }
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) throw new Error('invalid revision limits')
  const hash = crypto.createHash('sha256')
  const counters = { files: 0, bytes: 0 }
  if (spec.mode === 'git') {
    const gitRoot = git(root, ['rev-parse', '--show-toplevel']).trim()
    if (path.resolve(gitRoot) !== root) throw new Error('session cwd must be the Git root')
    hash.update(git(root, ['rev-parse', 'HEAD']))
    hash.update(git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=no']))
    hash.update(git(root, ['diff', '--binary', '--cached', '--no-ext-diff', '--no-color']))
    const changed = git(root, ['ls-files', '-m', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    for (const item of changed) collectFile(hash, relativePath(root, item), root, canonicalRoot, limits, counters)
    const deleted = git(root, ['ls-files', '-d', '-z']).split('\0').filter(Boolean)
    for (const item of deleted) collectFile(hash, relativePath(root, item), root, canonicalRoot, limits, counters)
  } else if (spec.mode === 'paths') {
    for (const item of spec.paths) collectFile(hash, relativePath(root, item), root, canonicalRoot, limits, counters)
  } else throw new Error(`unknown revision mode: ${spec.mode}`)
  return { digest: hash.digest('hex'), files: counters.files, bytes: counters.bytes }
}
