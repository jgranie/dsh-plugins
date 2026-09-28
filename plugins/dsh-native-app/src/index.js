import fs from 'node:fs'
import { NativeApp } from './core.js'
import { hostMutationRunner, shellRunner } from './peekaboo.js'

export const name = 'native-app'
export const inject = ['tools', 'systemPrompt', 'shell', 'shellEnv']

const string = { type: 'string' }
const integer = { type: 'integer' }
const schema = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required })
const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

export function apply(ctx, options = {}) {
  const native = new NativeApp(options, shellRunner(ctx, options.workspaceRoot),
    hostMutationRunner(fs.realpathSync(options.peekabooPath)))
  const disposers = []
  const register = (name, description, parameters, method) => disposers.push(ctx.tools.register({
    name, description, parameters, output,
    execute: async (args, exec) => {
      if (fs.realpathSync(exec.agent.session.header.cwd) !== native.root) throw new Error('native workspace mismatch')
      return native[method](args, exec)
    },
  }))
  register('native_project', 'Select an existing macOS Xcode project or create an empty SwiftUI app scaffold.',
    schema({ mode: { type: 'string', enum: ['create', 'use'] }, name: string, scheme: string, projectPath: string }, ['mode']), 'project')
  register('native_check', 'Build the current source, launch the built macOS app, identify its process and window, and capture that window.',
    schema({ windowId: integer }), 'check')
  register('native_inspect', 'Read native status/windows or capture the current managed app window without rebuilding.',
    schema({ mode: { type: 'string', enum: ['status', 'windows', 'capture'] }, windowId: integer }), 'inspect')
  register('native_input', 'Send a targeted foreground click, key hold, text, mouse move or drag, then capture the same app window.',
    schema({ kind: { type: 'string', enum: ['click', 'key', 'type', 'move', 'drag'] }, x: integer, y: integer,
      toX: integer, toY: integer, key: string, holdMs: integer, text: string,
      button: { type: 'string', enum: ['left', 'right'] },
      delivery: { type: 'string', enum: ['accessibility', 'synthetic'] } }, ['kind']), 'input')
  register('native_stop', 'Quit only the managed app process after checking its start identity.', schema({}), 'stop')
  disposers.push(ctx.systemPrompt.section({ name: 'tool:native-app', order: 175,
    text: 'For macOS app work, call native_project (create or use), implement one small behavior yourself, then native_check. A successful native_check gives an exact-window PNG: call read_image on that path and compare it with your intended behavior. Use native_input for a real click/key/typing/mouse path, then read_image again. For custom-drawn surfaces such as Metal views, use native_input click with delivery: synthetic; accessibility clicks require a pressable UI element. native_inspect reports windows, captures and process state; native_stop closes only the managed instance. The provided SwiftUI scaffold is only a starting window, not proof of your app skill. Build failures never launch an older binary. If using Metal, the module cache is kept inside the workspace by native_check. Record working observations only after inspecting the image; an input dispatch or build alone does not prove an effect.' }))
  ctx.effect?.(() => () => { for (const dispose of disposers.reverse()) dispose?.() }, name)
}
