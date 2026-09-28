import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

const INSTRUCTION = `Summarize the following coding session for another agent that will continue it. Return plain text only, about 1000-1500 tokens. Preserve the objective, binding user constraints, current files and state, verified behavior, open defects, rejected approaches, and the immediate next action. Separate observed facts from guesses. Keep exact paths and error strings when useful. Do not call tools or propose a new task. Do not claim a feature works without an observation.`

function blockText(block) {
  if (block?.type === 'text') return block.text || ''
  if (block?.type === 'tool-call') return `[tool call ${block.name || ''} ${JSON.stringify(block.arguments || '').slice(0, 1800)}]`
  if (block?.type === 'tool-result' || block?.type === 'tool_result') {
    return `[tool result ${block.toolCallId || ''} ${JSON.stringify(block.content || '').slice(0, 2200)}]`
  }
  if (block?.type === 'image') return '[image omitted; retain any written observation about it]'
  return ''
}

export function serializeMessages(messages) {
  return messages.map((message, index) => {
    const content = Array.isArray(message.content) ? message.content.map(blockText).filter(Boolean).join('\n') : ''
    return `[${index + 1} ${message.role || 'unknown'}]\n${content}`
  }).join('\n\n')
}

export function summaryInput(messages) {
  return `SESSION:\n${serializeMessages(messages)}`
}

export function projectSummary(blocks, finish) {
  if (finish?.kind === 'max-tokens') throw new Error('summarization truncated at the token cap')
  if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(`summarization ${finish.kind}: ${finish.failure?.message || 'unknown'}`)
  if (finish?.kind === 'tool-calls' || blocks.some(block => block?.type === 'tool-call')) throw new Error('summarization attempted a tool call')
  if (blocks.some(block => block?.type === 'image')) throw new Error('summarization returned an image')
  const textBlocks = blocks.filter(block => block?.type === 'text' && block.text?.trim())
  if (!textBlocks.length) throw new Error('summarization produced no text summary content')
  return textBlocks
}

export class CompactSummary extends BasicCompactionEngine {
  async summarize(input, agent, signal) {
    signal?.throwIfAborted()
    const provider = this.config.summarizationProvider || agent.session.requestHeader()?.config?.provider || agent.options.provider
    const model = this.config.summarizationModel || agent.session.requestHeader()?.config?.model || agent.options.model
    if (!provider || !model) throw new Error('compaction provider/model unavailable')
    const messages = [createSystemMessage(INSTRUCTION, 'dsh-compact-summary'),
      createUserMessage({ content: [{ type: 'text', text: summaryInput(input.messages) }],
        source: { kind: 'plugin:dsh-compact-summary' } })]
    const options = { provider, model, messages, maxTokens: this.config.maxTokens,
      sessionId: agent.session.id, purpose: 'compaction', ...(signal ? { signal } : {}) }
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    signal?.throwIfAborted()
    const rawOutput = assembler.blocks()
    return { summary: projectSummary(rawOutput, assembler.finish), rawOutput,
      llmStreamCall: true, provider, model, maxTokens: this.config.maxTokens,
      ...(assembler.usage ? { usage: assembler.usage } : {}) }
  }
}

export default CompactSummary
