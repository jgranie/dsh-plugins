import fs from 'node:fs'
import { IterationStore } from './core.js'
import { CadenceTracker } from './cadence.js'

export const name = 'rapid-iteration'
export const inject = ['tools', 'systemPrompt']

const schema = properties => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties) })
const str = { type: 'string' }
const output = { schema: { type: 'object' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }

export function apply(ctx, options = {}) {
  const store = new IterationStore(options)
  const cadence = options.launchPath ? new CadenceTracker(options) : null
  const disposers = []
  const tool = (name, description, parameters, method) => disposers.push(ctx.tools.register({
    name, description, parameters, output,
    execute: (args, exec) => {
      if (fs.realpathSync(exec.agent.session.header.cwd) !== store.root) throw new Error('agent workspace differs from campaign workspace')
      const result = store[method](args)
      if (cadence && (method === 'begin' || method === 'restore' || (method === 'finish' && args.decision === 'restore'))) cadence.newApproach()
      return method === 'status' && cadence ? { ...result, cadence: cadence.status() } : result
    },
  }))
  tool('iteration_begin', 'Save the current state and begin a short, observable development step.',
    schema({ intent: str, expected: str }), 'begin')
  tool('iteration_finish', 'Close or restore an increment without certifying it; use iteration_observe with working to save an observed working state.',
    schema({ observation: str, decision: { type: 'string', enum: ['keep', 'continue', 'restore'] } }), 'finish')
  tool('iteration_restore', 'Save the rejected work and restore the baseline of the active step.',
    { type: 'object', additionalProperties: false, properties: { observation: str,
      target: { type: 'string', enum: ['baseline', 'last-observed'] } } }, 'restore')
  tool('iteration_status', 'Read the latest saved development step and its Git revisions.',
    { type: 'object', additionalProperties: false, properties: {} }, 'status')
  if (cadence) {
    disposers.push(ctx.tools.register({
      name: 'iteration_observe',
      description: 'Record the result of a real product-interface execution; a working result saves its Git state.',
      parameters: schema({ surface: { type: 'string', enum: ['browser', 'native', 'cli', 'api', 'experiment', 'other'] },
        outcome: { type: 'string', enum: ['attempt', 'observed', 'blocked', 'working'] }, observation: str }),
      output,
      execute: (args, exec) => cadence.recordObservation(exec.agent, store, args),
    }))
    disposers.push(ctx.on('session/event', (session, event) => cadence.onSessionEvent(session, event)))
    disposers.push(ctx.on('agent/pre-step', (payload, next) => cadence.preStep(payload, next, store)))
  }
  disposers.push(ctx.systemPrompt.section({ name: 'tool:rapid-iteration', order: 180,
    text: 'Final requirements define the destination, not the construction order. Before broad implementation, choose one small, structurally important capability and call iteration_begin with its representative input or action and concrete expected observation. Exercise it through the real interface. After a real browser, native app, CLI, API, or experiment execution, use iteration_observe immediately; outcome working saves the Git state and closes the increment. Start the next increment only after that decision. At about 20 minutes without working evidence, exercise, reduce, or restore the increment and verify that a failing expectation is valid before changing more product code. A build or isolated unit tests alone do not establish the product milestone. Prefer established general-purpose libraries when they shorten the path. Near the deadline, stabilize the best runnable result.' }))
  ctx.effect?.(() => () => { for (const dispose of disposers.reverse()) dispose?.() }, name)
}
