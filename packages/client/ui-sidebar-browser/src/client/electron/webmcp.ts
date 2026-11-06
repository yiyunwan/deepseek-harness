/** Page-owned WebMCP discovery and invocation through a platform's main-world executor. */
import type { SidebarBrowserCommand, SidebarBrowserPage } from '../../types.ts'
import type { WebMCP } from 'webmcp-types'

/**
 * Validate WebMCP invocation fields before page execution.
 * @param command - operation parsed from a browser request.
 */
export function validateWebMcpCommand(command: SidebarBrowserCommand): void {
  if (command.action !== 'webmcp_execute') return
  if (!command.method?.trim()) throw new Error('WebMCP method required.')
  const input: unknown = JSON.parse(command.input ?? '{}')
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('WebMCP input must be a JSON object.')
}

/** Runs in the page's main world to preserve WebMCP callbacks and their owning objects. */
async function webmcpOperation(
  command: SidebarBrowserCommand,
): Promise<NonNullable<SidebarBrowserPage['webmcp']>> {
  const context = document.modelContext
  if (
    typeof context?.getTools !== 'function' ||
    typeof context.executeTool !== 'function'
  ) {
    throw new Error('This page does not expose the current WebMCP interface.')
  }
  const tools: WebMCP.RegisteredTool[] = await context.getTools()
  if (
    !Array.isArray(tools) ||
    tools.some(
      (tool: unknown) =>
        typeof tool !== 'object' ||
        tool === null ||
        !('name' in tool) ||
        typeof tool.name !== 'string',
    )
  ) {
    throw new Error('Page returned an invalid WebMCP method list.')
  }
  const selected = tools.filter(
    tool =>
      tool.window === window &&
      (command.method === undefined || tool.name === command.method),
  )
  let value: unknown
  let omitted = false
  if (command.action === 'webmcp_list') {
    omitted = selected.length > command.maxElements
    value = selected.slice(0, command.maxElements).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? {},
      ...(tool.annotations === undefined
        ? {}
        : { annotations: tool.annotations }),
      title: tool.title,
      origin: tool.origin,
    }))
  } else {
    const tool = selected[0]
    if (tool === undefined)
      throw new Error('WebMCP method is unavailable; list methods again.')
    if (selected.length !== 1)
      throw new Error('WebMCP method name is ambiguous.')
    const signal = AbortSignal.timeout(command.timeoutMs)
    const input: unknown = JSON.parse(command.input ?? '{}')
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new Error('WebMCP input must be a JSON object.')
    value = await context.executeTool(tool, input, { signal })
    if (typeof value !== 'string')
      throw new Error(
        'WebMCP execution returned an invalid result; expected a string.',
      )
    signal.throwIfAborted()
  }
  // Serialize within the page so proxies and callback-owned values never cross process or realm boundaries.
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (
      typeof item === 'function' ||
      typeof item === 'symbol' ||
      typeof item === 'bigint' ||
      item === undefined ||
      (typeof item === 'number' && !Number.isFinite(item))
    )
      throw new Error(
        'WebMCP returned a value that cannot be represented as JSON.',
      )
    return item
  })
  return {
    kind: command.action === 'webmcp_list' ? 'tools' : 'result',
    json: json.slice(0, command.maxText),
    truncated: omitted || json.length > command.maxText,
  }
}

/**
 * Discover or invoke WebMCP methods without importing a browser platform.
 * @param command - validated WebMCP operation and observation limits.
 * @param runInPage - execute the supplied fixed script in the approved page's main world.
 * @returns bounded JSON descriptors or result; failures do not guarantee absent page effects.
 */
export async function executeWebMcp(
  command: SidebarBrowserCommand,
  runInPage: (script: string) => Promise<unknown>,
): Promise<NonNullable<SidebarBrowserPage['webmcp']>> {
  if (command.action !== 'webmcp_list' && command.action !== 'webmcp_execute')
    throw new Error('Expected a WebMCP operation.')
  try {
    const kind: 'tools' | 'result' =
      command.action === 'webmcp_list' ? 'tools' : 'result'
    const value = await runInPage(
      `(${webmcpOperation.toString()})(${JSON.stringify(command)})`,
    )
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      value.kind !== kind ||
      !('json' in value) ||
      typeof value.json !== 'string' ||
      value.json.length > command.maxText ||
      !('truncated' in value) ||
      typeof value.truncated !== 'boolean'
    )
      throw new Error('Page returned an invalid WebMCP response.')
    return { kind, json: value.json, truncated: value.truncated }
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message.slice(0, 500)
        : 'Page execution failed.'
    throw new Error(
      `WebMCP operation failed: ${detail} Execution may have changed the page. Read its current state before repeating the operation.`,
      { cause: error },
    )
  }
}
