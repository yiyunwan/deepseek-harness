import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Browser from '../src/index.ts'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

it('registers the native browser tool and withdraws it with the plugin', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const fiber = await ctx.plugin(Browser)
    expect(ctx.tools.get('sidebar_browser')?.description).toContain('built-in desktop browser')
    await fiber.dispose()
    expect(ctx.tools.get('sidebar_browser')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('returns bounded browser observations through native tool execution', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(Browser)
    const agent = { id: SessionId('browser-test') } as Agent
    await ctx.plugin((inner: Context) => { createScope(inner, agent) })
    ctx.on('sidebar-browser/request', async (request) => {
      expect(request.agent).toBe(agent)
      expect(request.command).toMatchObject({ maxText: 12000, maxElements: 100, timeoutMs: 30000 })
      return { tabs: [{ tabId: 'tab-1', url: 'https://example.test/' }], tabId: 'tab-1',
        page: { url: 'https://example.test/', title: 'Example', text: 'Search', truncated: false,
          elements: [{ ref: 'snapshot:0', tag: 'input', label: 'Search' }] } }
    })
    const result = await executeModelToolFixture(ctx, {
      agent, signal: new AbortController().signal, callId: ToolCallId('browser-read'), name: 'sidebar_browser',
      arguments: { action: 'read', tabId: 'tab-1' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toMatchSnapshot()
  } finally { await ctx.fiber.dispose() }
})

it.each(['webmcp_list', 'webmcp_execute'] as const)('logs %s arguments and serialized page results through native tool execution', async (action) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(Browser)
    const agent = { id: SessionId('browser-webmcp-test') } as Agent
    await ctx.plugin((inner: Context) => { createScope(inner, agent) })
    ctx.on('sidebar-browser/request', async (request) => {
      expect(request.command).toMatchObject({ action, method: 'setText', input: '{"text":"hello"}' })
      return { tabs: [{ tabId: 'tab-1' }], tabId: 'tab-1',
        page: { url: 'https://example.test/', title: 'WebMCP', text: 'hello', truncated: false, elements: [],
          webmcp: { kind: action === 'webmcp_list' ? 'tools' : 'result', json: '{"text":"hello"}', truncated: false } } }
    })
    const result = await executeModelToolFixture(ctx, {
      agent, signal: new AbortController().signal, callId: ToolCallId(`browser-${action}`), name: 'sidebar_browser',
      arguments: { action, tabId: 'tab-1', method: 'setText', input: { text: 'hello' } },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toMatchSnapshot()
  } finally { await ctx.fiber.dispose() }
})
