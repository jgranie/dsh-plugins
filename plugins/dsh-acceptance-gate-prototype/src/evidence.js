import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { artifactRevision } from './revision.js'

export function isToolResult(item) {
  return (item?.type === 'tool-result' || item?.type === 'tool_result' || item?.role === 'tool') &&
    typeof item.toolCallId === 'string'
}

export function toolPair(event, events) {
  const message = event?.data?.message
  const result = isToolResult(message) ? message : message?.content?.find(isToolResult)
  if (!result) return null
  const call = events.find(item => item.type === 'tool/call' && item.data?.callId === result.toolCallId)
  return call ? { call, result } : null
}

export function nativeImage(result) {
  return Array.isArray(result?.content) && result.content.some(block => {
    const item = block?.attachment
    return block?.type === 'image' && typeof item?.attachmentId === 'string' &&
      item.attachmentId.length > 0 && typeof item?.mediaType === 'string' &&
      item.mediaType.startsWith('image/') &&
      ['bytes', 'width', 'height'].every(key => Number.isSafeInteger(item[key]) && item[key] > 0)
  })
}

export function parseArguments(call) {
  try {
    return typeof call?.data?.arguments === 'string'
      ? JSON.parse(call.data.arguments) : call?.data?.arguments
  } catch { return null }
}

function containedFile(workspaceRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null
  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(root, candidate)
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null
}

function screenshotFiles(pair, workspaceRoot) {
  if (pair?.call?.data?.name !== 'mcp__playwright__browser_take_screenshot') return []
  const values = [parseArguments(pair.call)?.filename]
  const text = resultText(pair.result)
  for (const pattern of [/\[Screenshot[^\]]*\]\(([^)]+)\)/g, /\bpath:\s*['"]([^'"]+)['"]/g]) {
    for (const match of text.matchAll(pattern)) values.push(match[1])
  }
  return [...new Set(values.map(value => containedFile(workspaceRoot, value)).filter(Boolean))]
}

// A native image read is browser evidence only when it reads the exact workspace
// file named by a preceding successful Playwright screenshot in this session.
export function browserVisualEvidence(events, event, workspaceRoot) {
  const pair = toolPair(event, events)
  if (!pair || pair.result.isError || event?.data?.error) return null
  if (pair.call.data?.name === 'mcp__playwright__browser_take_screenshot' && nativeImage(pair.result)) {
    return { kind: 'direct', sourceEventSeq: event.seq, captureEventSeq: event.seq, file: null }
  }
  if (pair.call.data?.name !== 'read_image' || !nativeImage(pair.result)) return null
  const readFile = containedFile(workspaceRoot, parseArguments(pair.call)?.file_path)
  if (!readFile) return null
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate.seq >= event.seq || candidate.type !== 'tool/result') continue
    const capture = toolPair(candidate, events)
    if (!capture || capture.result.isError || candidate.data?.error) continue
    if (screenshotFiles(capture, workspaceRoot).includes(readFile)) {
      return { kind: 'file-read', sourceEventSeq: event.seq,
        captureEventSeq: candidate.seq, file: readFile }
    }
  }
  return null
}

// A native image must be read from a workspace file produced by a successful
// screencapture call in the same session. A build or process PID is insufficient.
export function nativeVisualEvidence(events, event, workspaceRoot, { requireReceipt = false } = {}) {
  const cua = cuaVisualEvidence(events, event, workspaceRoot)
  if (cua) return cua
  const read = toolPair(event, events)
  if (read?.call?.data?.name !== 'read_image' || read.result.isError ||
      event.data?.error || !nativeImage(read.result)) return null
  const requested = parseArguments(read.call)?.file_path
  if (typeof requested !== 'string') return null
  let file
  try { file = fs.realpathSync(path.resolve(workspaceRoot, requested)) }
  catch { return null }
  if (!file.startsWith(`${workspaceRoot}${path.sep}`) || !fs.statSync(file).isFile()) return null
  const marker = path.join(workspaceRoot, '.dsh-campaign-owner')
  const runId = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null
  const receiptDir = path.resolve(workspaceRoot, '..', 'control/native/receipts')
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate.seq >= event.seq || candidate.type !== 'tool/result') continue
    const capture = toolPair(candidate, events)
    if (!capture || !['native_check', 'native_inspect', 'native_input'].includes(capture.call.data?.name) ||
        capture.result.isError || candidate.data?.error) continue
    let data
    try { data = JSON.parse(resultText(capture.result)) } catch { continue }
    if (!data?.ok || data.image !== file || typeof data.receipt !== 'string') continue
    const receiptPath = path.resolve(data.receipt)
    if (!receiptPath.startsWith(`${receiptDir}${path.sep}`)) continue
    let receipt
    try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) } catch { continue }
    if (receipt.schemaVersion !== 1 || receipt.runId !== runId || receipt.image !== file ||
        receipt.revision !== data.revision || receipt.pid !== data.pid ||
        receipt.windowId !== data.windowId || !Number.isSafeInteger(receipt.pid) ||
        !Number.isSafeInteger(receipt.windowId)) continue
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (digest !== receipt.imageSha256) continue
    let currentRevision
    try { currentRevision = artifactRevision(workspaceRoot, { mode: 'git', maxFiles: 10_000,
      maxBytes: 1024 * 1024 * 1024 }).digest }
    catch { continue }
    if (currentRevision !== receipt.revision) continue
    return { kind: 'native-receipt-read', captureEventSeq: candidate.seq, file,
      receipt: receiptPath, revision: receipt.revision, pid: receipt.pid,
      windowId: receipt.windowId, inputDispatched: capture.call.data?.name === 'native_input',
      providedScaffoldModified: receipt.providedScaffoldModified === true }
  }
  if (requireReceipt) return null
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate.seq >= event.seq || candidate.type !== 'tool/result') continue
    const capture = toolPair(candidate, events)
    if (!capture || !/^(bash|exec_command|terminal|python|mcp__)/.test(capture.call.data?.name || '') ||
        executionFailure(candidate, capture.result)) continue
    const args = JSON.stringify(parseArguments(capture.call))
    if (args.includes('screencapture') && (args.includes(file) || args.includes(requested))) {
      return { kind: 'native-file-read', captureEventSeq: candidate.seq, file }
    }
  }
  return null
}

const CUA_INPUT = new Set(['click', 'double_click', 'right_click', 'drag', 'type_text',
  'press_key', 'hotkey', 'set_value', 'scroll'])

function sameProcess(receipt) {
  try {
    const value = execFileSync('/bin/ps', ['-p', String(receipt.pid), '-o', 'lstart=', '-o', 'comm='],
      { encoding: 'utf8', timeout: 5000,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }).trim()
    const match = value.match(/^(.{24})\s+(.+)$/)
    return Boolean(match && match[1].trim() === receipt.startIdentity &&
      match[2].trim() === receipt.executable)
  } catch { return false }
}

function cuaVisualEvidence(events, event, workspaceRoot) {
  const capture = toolPair(event, events)
  if (capture?.call?.data?.name !== 'cua_driver_native__get_window_state' ||
      capture.result.isError || event.data?.error || !nativeImage(capture.result)) return null
  const args = parseArguments(capture.call)
  const header = resultText(capture.result).match(/^window_id=(\d+) pid=(\d+) size=(\d+)x(\d+) elements=\d+/)
  const image = capture.result.content.find(block => block?.type === 'image' && block.attachment)
  if (!header || !args || Number(header[1]) !== args.window_id || Number(header[2]) !== args.pid ||
      Number(header[3]) !== image.attachment.width || Number(header[4]) !== image.attachment.height) return null
  const marker = path.join(workspaceRoot, '.dsh-campaign-owner')
  const runId = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null
  const receiptDir = path.resolve(workspaceRoot, '..', 'control/native-build/receipts')
  let currentRevision
  try { currentRevision = artifactRevision(workspaceRoot, { mode: 'git', maxFiles: 10_000,
    maxBytes: 1024 * 1024 * 1024 }).digest }
  catch { return null }
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate.seq >= event.seq || candidate.type !== 'tool/result') continue
    const build = toolPair(candidate, events)
    if (build?.call?.data?.name !== 'native_build' || build.result.isError || candidate.data?.error) continue
    let data
    try { data = JSON.parse(resultText(build.result)) } catch { continue }
    if (!data?.ok || data.pid !== args.pid || data.revision !== currentRevision ||
        typeof data.receipt !== 'string') continue
    const receiptPath = path.resolve(data.receipt)
    if (!receiptPath.startsWith(`${receiptDir}${path.sep}`)) continue
    let receipt
    try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) } catch { continue }
    if (receipt.schemaVersion !== 1 || receipt.runId !== runId ||
        receipt.revision !== currentRevision || receipt.pid !== args.pid ||
        receipt.startIdentity !== data.startIdentity || receipt.bundleId !== data.bundleId ||
        !sameProcess(receipt)) continue
    let priorCaptureSeq = null
    for (const earlier of events) {
      if (earlier.seq <= candidate.seq || earlier.seq >= event.seq || earlier.type !== 'tool/result') continue
      const pair = toolPair(earlier, events)
      if (pair?.call?.data?.name !== 'cua_driver_native__get_window_state' ||
          pair.result.isError || earlier.data?.error) continue
      const target = parseArguments(pair.call)
      if (target?.pid === args.pid && target?.window_id === args.window_id &&
          nativeImage(pair.result)) priorCaptureSeq = earlier.seq
    }
    const inputDispatched = events.some(actionEvent => {
      if (priorCaptureSeq === null || actionEvent.seq <= priorCaptureSeq || actionEvent.seq >= event.seq ||
          actionEvent.type !== 'tool/result') return false
      const pair = toolPair(actionEvent, events)
      const action = pair?.call?.data?.name?.replace(/^cua_driver_native__/, '')
      if (!CUA_INPUT.has(action) || pair.result.isError || actionEvent.data?.error) return false
      const target = parseArguments(pair.call)
      return (target?.pid ?? target?.target?.pid) === args.pid &&
        (target?.window_id ?? target?.target?.window_id) === args.window_id
    })
    return { kind: 'cua-window', captureEventSeq: event.seq, file: null,
      attachmentId: image.attachment.attachmentId, receipt: receiptPath,
      revision: currentRevision, pid: receipt.pid, windowId: args.window_id,
      inputDispatched, providedScaffoldModified: receipt.providedScaffoldModified === true }
  }
  return null
}

function resultText(result) {
  return (result?.content || []).filter(item => item?.type === 'text')
    .map(item => String(item.text || '')).join('\n')
}

// Shell pipelines can exit zero after a failing test runner. Recognize only
// explicit, conventional failure lines; this is a drift signal, never a pass.
export function executionFailure(event, result) {
  if (event?.data?.error || result?.isError) {
    return String(event?.data?.error || resultText(result) || 'tool error').slice(0, 4000)
  }
  const text = resultText(result)
  // Native tools return structured failures rather than throwing, so preserve
  // their stage/category as drift signals even when the tool call itself succeeds.
  if (text.startsWith('{"ok":false,')) {
    try {
      const value = JSON.parse(text)
      if (value?.ok === false && typeof value.category === 'string') {
        return `${value.stage || 'native'}: ${value.category}: ${String(value.detail || '').slice(0, 1000)}`
      }
    } catch { /* fall through to conventional failure lines */ }
  }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const failures = lines.filter(line =>
    /^(?:✖|not ok\b|\[fail(?:ed)?\]|fail(?:ed)?[:\s])/i.test(line) ||
    /^ℹ\s+fail\s+[1-9]\d*\b/i.test(line) ||
    /^(?:npm err!|error:\s+(?:tests?|assertion))/i.test(line))
  return failures.length ? failures.slice(0, 12).join('\n') : null
}
