import crypto from 'node:crypto'

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`)
  return value.trim()
}

export function parseContract(raw) {
  const input = JSON.parse(raw)
  if (input?.schemaVersion !== 1) throw new Error('unsupported contract schemaVersion')
  const id = requiredString(input.id, 'contract.id')
  const checks = Array.isArray(input.checks) ? input.checks.map((check, index) => {
    const label = `checks[${index}]`
    const checkId = requiredString(check?.id, `${label}.id`)
    const program = requiredString(check.program, `${label}.program`)
    if (!Array.isArray(check.args) || !check.args.every(arg => typeof arg === 'string')) {
      throw new Error(`${label}.args must be string[]`)
    }
    const timeoutMs = check.timeoutMs ?? 60_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
      throw new Error(`${label}.timeoutMs must be 1000..600000`)
    }
    if (check.expectedText !== undefined && typeof check.expectedText !== 'string') {
      throw new Error(`${label}.expectedText must be a string`)
    }
    return { id: checkId, program, args: check.args, workdir: check.workdir ?? '.',
      expectedText: check.expectedText ?? null, timeoutMs, allowRevisionChange: check.allowRevisionChange === true }
  }) : []
  if (new Set(checks.map(check => check.id)).size !== checks.length) throw new Error('duplicate check id')
  if (!Array.isArray(input.requirements) || input.requirements.length === 0) {
    throw new Error('contract.requirements must be nonempty')
  }
  if (input.requirements.length > 100) throw new Error('contract has too many requirements')
  const ids = new Set()
  const requirements = input.requirements.map((item, index) => {
    const prefix = `requirements[${index}]`
    const requirementId = requiredString(item?.id, `${prefix}.id`)
    if (ids.has(requirementId)) throw new Error(`duplicate requirement id: ${requirementId}`)
    ids.add(requirementId)
    const description = requiredString(item.description, `${prefix}.description`)
    if (description.length > 500) throw new Error(`${prefix}.description is too long`)
    if (!Array.isArray(item.observations) || item.observations.length === 0) {
      throw new Error(`${prefix}.observations must be nonempty`)
    }
    const observations = item.observations.map((rule, ruleIndex) => {
      const label = `${prefix}.observations[${ruleIndex}]`
      const provider = requiredString(rule?.provider, `${label}.provider`)
      const kind = requiredString(rule.kind, `${label}.kind`)
      const checkId = provider === 'process-exec' ? requiredString(rule.checkId, `${label}.checkId`) : null
      if (checkId && !checks.some(check => check.id === checkId)) throw new Error(`unknown check id: ${checkId}`)
      const minimum = rule.minimum ?? 1
      if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > 100) {
        throw new Error(`${label}.minimum must be an integer from 1 to 100`)
      }
      return { provider, kind, minimum, checkId }
    })
    return { id: requirementId, description, required: item.required !== false, observations }
  })
  const revision = input.revision
  if (!revision || !['git', 'paths'].includes(revision.mode)) throw new Error('revision.mode must be git or paths')
  if (revision.mode === 'paths' && (!Array.isArray(revision.paths) || revision.paths.length === 0)) {
    throw new Error('revision.paths must be nonempty in paths mode')
  }
  return { schemaVersion: 1, id, revision, checks, requirements }
}

export function evaluateContract(contract, observations, revisionDigest, events) {
  const eventHashes = new Map(events.map(event => [event.seq, sha256(JSON.stringify(event))]))
  const rows = []
  for (const requirement of contract.requirements) {
    const rules = requirement.observations.map(rule => {
      const matching = observations.filter(observation =>
        observation.requirementId === requirement.id &&
        observation.provider === rule.provider &&
        observation.kind === rule.kind &&
        observation.checkId === rule.checkId &&
        observation.revisionDigest === revisionDigest &&
        eventHashes.get(observation.sourceEventSeq) === observation.sourceEventHash
      )
      const byEvent = new Map()
      for (const item of matching) {
        const key = `${item.sourceEventSeq}:${item.sourceEventHash}`
        const previous = byEvent.get(key)
        if (!previous || item.outcome !== 'pass') byEvent.set(key, item)
      }
      const distinct = [...byEvent.values()].sort((left, right) =>
        left.sourceEventSeq - right.sourceEventSeq)
      const lastNonpassIndex = distinct.findLastIndex(item => item.outcome !== 'pass')
      const count = distinct.slice(lastNonpassIndex + 1).filter(item => item.outcome === 'pass').length
      return { ...rule, count, pass: count >= rule.minimum }
    })
    rows.push({ id: requirement.id, description: requirement.description, required: requirement.required, rules,
      pass: rules.every(rule => rule.pass) })
  }
  return { pass: rows.filter(row => row.required).every(row => row.pass), requirements: rows }
}
