// @vitest-environment jsdom
/** Exercise the fixed guest script against DOM fields and document references. */
import { afterEach, expect, it, vi } from 'vitest'
import { createContext, runInContext } from 'node:vm'
import { controlBrowserGuest, parseBrowserCommand } from '../src/client/electron/browser-automation.ts'
import type { SidebarBrowserCommand } from '../src/types.ts'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
  Reflect.deleteProperty(document.body, 'innerText')
  Reflect.deleteProperty(document, 'modelContext')
})

function guest() {
  const rect = new DOMRect(0, 0, 100, 20)
  const rects: DOMRectList = {
    0: rect, length: 1, item: index => index === 0 ? rect : null, [Symbol.iterator]: () => [rect][Symbol.iterator](),
  }
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(rects)
  for (const node of document.querySelectorAll<HTMLElement>('*')) node.scrollIntoView = vi.fn()
  const world = createContext({
    document, location, HTMLElement, HTMLInputElement, HTMLTextAreaElement, Event, InputEvent, getComputedStyle, AbortSignal, Map,
    navigator: {}, window: {},
  })
  const contents = {
    executeJavaScript: vi.fn(async (code: string) => runInContext(code, world) as Promise<unknown>),
    sendInputEvent: vi.fn(async () => {}),
  }
  return { contents, world, native: contents }
}

const read: SidebarBrowserCommand = { action: 'read', maxText: 20, maxElements: 10, timeoutMs: 30000 }
const webmcp: SidebarBrowserCommand = { ...read, action: 'webmcp_list', maxText: 12000 }

it('lists page-owned methods and invokes an asynchronous callback with its owner and JSON input', async () => {
  const h = guest()
  runInContext(`const tool = {
    name: 'setText', title: 'Set text', origin: 'https://example.test', window,
    description: 'Set page text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
  };
  document.modelContext = {
    prefix: 'Updated: ',
    async getTools() { return [tool]; },
    async executeTool(selected, input, { signal }) {
      if (selected !== tool) throw new Error('Wrong registered tool');
      if (!(signal instanceof AbortSignal)) throw new Error('Missing cancellation');
      document.body.innerText = this.prefix + input.text;
      return JSON.stringify(new Proxy({ text: document.body.innerText }, {}));
    }
  };`, h.world)
  const listed = await controlBrowserGuest(h.native, webmcp)
  expect(JSON.parse(listed.webmcp!.json)).toEqual([{ name: 'setText', title: 'Set text', origin: 'https://example.test', description: 'Set page text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }])
  const called = await controlBrowserGuest(h.native, { ...webmcp, action: 'webmcp_execute', method: 'setText', input: '{"text":"hello"}' })
  expect(called.webmcp).toEqual({ kind: 'result', json: JSON.stringify('{"text":"Updated: hello"}'), truncated: false })
  expect(called.text).toBe('Updated: hello')
  expect(h.contents.executeJavaScript).toHaveBeenCalledTimes(4)
})

it('uses the document discovery API without returning Window objects or calling foreign frames', async () => {
  const h = guest()
  runInContext(`const local = { name: 'local', title: 'Local', origin: 'https://example.test', description: 'Local', window, inputSchema: { type: 'object' } };
    document.modelContext = {
      async getTools() { return [local, { name: 'foreign', window: {} }]; },
      async executeTool(tool, input, { signal }) { return JSON.stringify({ name: tool.name, input, cancelled: signal.aborted }); }
    };`, h.world)
  const listed = await controlBrowserGuest(h.native, webmcp)
  expect(JSON.parse(listed.webmcp!.json)).toEqual([{ name: 'local', title: 'Local', origin: 'https://example.test', description: 'Local', inputSchema: { type: 'object' } }])
  const called = await controlBrowserGuest(h.native, { ...webmcp, action: 'webmcp_execute', method: 'local', input: '{}' })
  expect(JSON.parse(called.webmcp!.json)).toBe('{"name":"local","input":{},"cancelled":false}')
})

it('preserves plain text returned by the current execution API', async () => {
  const h = guest()
  runInContext(`document.modelContext = {
    async getTools() { return [{ name: 'add', title: 'Add', description: 'Add one', origin: 'https://example.test', window }]; },
    async executeTool(tool, input) { return 'Sum: ' + (input.a + 1); }
  };`, h.world)
  const called = await controlBrowserGuest(h.native, { ...webmcp, action: 'webmcp_execute', method: 'add', input: '{"a":2}' })
  expect(called.webmcp).toEqual({ kind: 'result', json: '"Sum: 3"', truncated: false })
})

it('bounds method lists and results and supports discovery by exact method name', async () => {
  const h = guest()
  runInContext(`document.modelContext = {
    async getTools() { return [
      { name: 'first', title: 'First', description: 'First', origin: 'https://example.test', window },
      { name: 'second', title: 'Second', description: 'Second', origin: 'https://example.test', window }
    ]; },
    async executeTool() { return 'a'.repeat(100); }
  };`, h.world)
  const listed = await controlBrowserGuest(h.native, { ...webmcp, maxElements: 1 })
  expect(JSON.parse(listed.webmcp!.json)).toHaveLength(1)
  expect(listed.webmcp!.truncated).toBe(true)
  const filtered = await controlBrowserGuest(h.native, { ...webmcp, method: 'second' })
  expect(JSON.parse(filtered.webmcp!.json)).toEqual([{ name: 'second', title: 'Second', origin: 'https://example.test', description: 'Second', inputSchema: {} }])
  expect(filtered.webmcp!.truncated).toBe(false)
  const called = await controlBrowserGuest(h.native, { ...webmcp, maxText: 20, action: 'webmcp_execute', method: 'first' })
  expect(called.webmcp!.json).toHaveLength(20)
  expect(called.webmcp!.truncated).toBe(true)
})

it.each([
  'document.modelContext = undefined',
  'document.modelContext = { async getTools() { return []; }, async executeTool() { return ""; } }',
  'document.modelContext = { async getTools() { return [{ name: "missing", window }]; }, async executeTool() { throw new Error("Page failure"); } }',
  'document.modelContext = { async getTools() { return [{ name: "missing", window }]; }, async executeTool() { return { text: "invalid" }; } }',
  'document.modelContext = { async getTools() { return [{ name: "missing", window }, { name: "missing", window }]; }, async executeTool() { return ""; } }',
])('reports execution failure and unknown page effects without repeating the callback: %s', async (script) => {
  const h = guest()
  runInContext(script, h.world)
  await expect(controlBrowserGuest(h.native, { ...webmcp, action: 'webmcp_execute', method: 'missing' })).rejects.toThrow('may have changed the page')
  expect(h.contents.executeJavaScript).toHaveBeenCalledOnce()
})

it('rejects malformed results from the page main world before returning them to the renderer', async () => {
  const h = guest()
  h.contents.executeJavaScript.mockResolvedValue({ kind: 'result', json: 'x'.repeat(30), truncated: false })
  await expect(controlBrowserGuest(h.native, { ...webmcp, maxText: 20, action: 'webmcp_execute', method: 'example' })).rejects.toThrow('may have changed the page')
  expect(h.contents.executeJavaScript).toHaveBeenCalledOnce()
})

it('fills a field with input and change events and clicks the referenced button', async () => {
  document.body.innerHTML = '<input aria-label="Query"><button aria-label="Search"></button>'
  const input = document.querySelector('input')!
  const button = document.querySelector('button')!
  const events: string[] = []
  input.addEventListener('input', () => { events.push(`input:${input.value}`) })
  input.addEventListener('change', () => { events.push(`change:${input.value}`) })
  const clicked = vi.fn()
  button.addEventListener('click', clicked)
  const h = guest()
  const page = await controlBrowserGuest(h.native, read)
  const filled = await controlBrowserGuest(h.native, { ...read, action: 'fill', ref: page.elements[0]!.ref, text: 'native browser' })
  expect(input.value).toBe('native browser')
  expect(events).toEqual(['input:native browser', 'change:native browser'])
  await controlBrowserGuest(h.native, { ...read, action: 'click', ref: filled.elements[1]!.ref })
  expect(clicked).toHaveBeenCalledOnce()
  expect(h.contents.executeJavaScript).toHaveBeenCalledTimes(3)
})

it('rejects expired and detached references before changing a field', async () => {
  document.body.innerHTML = '<input aria-label="Query">'
  const h = guest()
  const first = await controlBrowserGuest(h.native, read)
  const current = await controlBrowserGuest(h.native, read)
  await expect(controlBrowserGuest(h.native, { ...read, action: 'fill', ref: first.elements[0]!.ref, text: 'stale' })).rejects.toThrow('expired')
  document.querySelector('input')!.remove()
  await expect(controlBrowserGuest(h.native, { ...read, action: 'click', ref: current.elements[0]!.ref })).rejects.toThrow('expired')
})

it('bounds observations and sends native key events to the focused field', async () => {
  document.body.innerHTML = '<input aria-label="Query"><button aria-label="Search"></button>'
  Object.defineProperty(document.body, 'innerText', { configurable: true, value: 'a'.repeat(30) })
  const h = guest()
  const page = await controlBrowserGuest(h.native, { ...read, maxElements: 1 })
  expect(page.text).toHaveLength(20)
  expect(page.elements).toHaveLength(1)
  expect(page.truncated).toBe(true)
  await controlBrowserGuest(h.native, { ...read, action: 'press', ref: page.elements[0]!.ref, key: 'Enter' })
  expect(document.activeElement).toBe(document.querySelector('input'))
  expect(h.contents.sendInputEvent.mock.calls).toEqual([
    [{ type: 'keyDown', keyCode: 'Enter' }], [{ type: 'keyUp', keyCode: 'Enter' }],
  ])
})

it.each([
  {}, { ...read, action: 'execute', text: 'process.exit()' }, { ...read, maxText: Infinity },
  { ...read, maxElements: 1.5 }, { ...read, action: 'click' }, { ...read, action: 'fill', ref: 'ref' },
  { ...read, action: 'press', key: 'F12' }, { ...read, action: 'navigate', url: 123 },
  { ...webmcp, action: 'webmcp_execute' }, { ...webmcp, action: 'webmcp_execute', method: 'add', input: '[]' },
  { ...webmcp, action: 'webmcp_execute', method: 'add', input: '{' }, { ...webmcp, method: 5 },
])('rejects invalid remote operations before guest execution: %j', (value) => {
  expect(() => parseBrowserCommand(value)).toThrow()
})
