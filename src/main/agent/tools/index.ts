import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { ToolContext, ToolModuleFactory } from '../toolkit'
import { arrange } from './arrange'
import { core } from './core'
import { extend } from './extend'
import { instruments } from './instruments'
import { memory } from './memory'
import { transport } from './transport'

/**
 * Every tool module the agent has, in the order their guidance appears in the
 * system prompt. To add a capability: write a module in this folder and add
 * one import and one line to the list.
 */
export const MODULES: ToolModuleFactory[] = [
  core,
  arrange,
  instruments,
  transport,
  memory,
  extend,
]

export function buildToolbox(ctx: ToolContext, factories: ToolModuleFactory[] = MODULES) {
  const modules = factories.flatMap((factory) => factory(ctx) ?? [])
  const tools = modules.flatMap((m) => m.tools)
  const names = tools.map((t) => t.name)
  const duplicate = names.find((name, i) => names.indexOf(name) !== i)
  if (duplicate) throw new Error(`Two tool modules define a tool named "${duplicate}"`)
  return {
    server: createSdkMcpServer({ name: 'jam', version: '0.1.0', tools }),
    allowedTools: names.map((name) => `mcp__jam__${name}`),
    guide: modules.map((m) => m.guide.trim()).join('\n'),
  }
}
