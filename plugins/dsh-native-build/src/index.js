import fs from 'node:fs'
import { NativeBuild } from './core.js'
import { shellRunner } from './shell.js'

export const name = 'native-build'
export const inject = ['tools', 'systemPrompt', 'shell', 'shellEnv']

const string = { type: 'string' }
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required })
const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

export function apply(ctx, options = {}) {
  const native = new NativeBuild(options, shellRunner(ctx, options.workspaceRoot))
  const disposers = []
  const register = (toolName, description, parameters, method) => disposers.push(ctx.tools.register({
    name: toolName, description, parameters, output,
    execute: async (args, exec) => {
      if (fs.realpathSync(exec.agent.session.header.cwd) !== native.root) throw new Error('native workspace mismatch')
      return native[method](args, exec)
    },
  }))
  register('native_project', 'Select an existing macOS Xcode project or create a neutral SwiftUI app scaffold.',
    schema({ mode: { type: 'string', enum: ['create', 'use'] }, name: string,
      scheme: string, projectPath: string }, ['mode']), 'project')
  register('native_build', 'Build the current source, launch the built app, and return its exact process identity and source receipt.',
    schema({}), 'build')
  register('native_status', 'Check the managed app process, build log, receipt and recent crash report.',
    schema({}), 'status')
  register('native_stop', 'Stop only the managed app after checking PID, process start and executable path.',
    schema({}), 'stop')
  disposers.push(ctx.systemPrompt.section({ name: 'tool:native-build', order: 175,
    text: 'For macOS app work, call native_project, implement one small behavior yourself, then native_build. This tool compiles and launches only; its success does not prove a visible app. Use the official cua_driver_native__list_windows on the returned PID, then cua_driver_native__get_window_state for a fresh screenshot of the exact window. Interpret that image, choose an input through Cua Driver, and observe the same window again. Prefer background delivery; a refusal does not authorize a foreground retry. Record a working increment only after checking the visible effect. The provided scaffold is not proof of product skill. native_status reports process and crash state; native_stop closes only the managed generation. Build failures never launch an old binary.' }))
  ctx.effect?.(() => () => { for (const dispose of disposers.reverse()) dispose?.() }, name)
}
