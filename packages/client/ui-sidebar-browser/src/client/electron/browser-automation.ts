/** Fixed page operations through the browser plugin's native webview. */
import type { WebviewElement } from './ElectronWebviewPresentation.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { SidebarBrowserCommand, SidebarBrowserPage } from '../../types.ts'
import { executeWebMcp, validateWebMcpCommand } from './webmcp.ts'

/** Validate a remote command before executing any guest operation.
 * @param value - remote browser request.
 * @returns validated command.
 */
export function parseBrowserCommand(value: unknown): SidebarBrowserCommand {
  if (typeof value !== 'object' || value === null || !('action' in value)
    || !['read', 'navigate', 'back', 'forward', 'reload', 'click', 'fill', 'press', 'webmcp_list', 'webmcp_execute'].includes(String(value.action))
    || !('maxText' in value) || typeof value.maxText !== 'number' || !Number.isInteger(value.maxText) || value.maxText < 1 || value.maxText > 100000
    || !('timeoutMs' in value) || typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 2147483647
    || !('maxElements' in value) || typeof value.maxElements !== 'number' || !Number.isInteger(value.maxElements) || value.maxElements < 1 || value.maxElements > 1000) {
    throw new Error('desktop browser: invalid operation')
  }
  const string = (key: string): string | undefined => {
    const input: unknown = Reflect.get(value, key)
    if (input === undefined) return undefined
    if (typeof input !== 'string') throw new Error(`desktop browser: invalid ${key}`)
    return input
  }
  const command: SidebarBrowserCommand = {
    action: value.action as SidebarBrowserCommand['action'], maxText: value.maxText, maxElements: value.maxElements,
    timeoutMs: value.timeoutMs,
    url: string('url'), ref: string('ref'), text: string('text'), key: string('key'), method: string('method'), input: string('input'),
  }
  if (command.action === 'navigate' && command.url === undefined) throw new Error('desktop browser: URL required')
  if ((command.action === 'click' || command.action === 'fill') && command.ref === undefined) throw new Error('desktop browser: element reference required')
  if (command.action === 'fill' && command.text === undefined) throw new Error('desktop browser: field value required')
  if (command.action === 'press' && !['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Space'].includes(command.key ?? '')) {
    throw new Error('desktop browser: unsupported key')
  }
  validateWebMcpCommand(command)
  return command
}

/** Runs in the page's main world; references disappear on navigation or a new observation. */
function pageOperation(command: SidebarBrowserCommand, token: string): SidebarBrowserPage {
  const carrier = globalThis as typeof globalThis & {
    __dshBrowserSnapshot?: { token: string; nodes: HTMLElement[] }
  }
  if (command.ref !== undefined) {
    const saved = carrier.__dshBrowserSnapshot
    const [previousToken, index] = command.ref.split(':')
    const node = saved !== undefined && saved.token === previousToken && /^\d+$/.test(index ?? '') ? saved.nodes[Number(index)] : undefined
    if (node === undefined || !node.isConnected) throw new Error('Element reference expired; read the page again.')
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    if (command.action === 'click') node.click()
    if (command.action === 'fill') {
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        if (node.disabled || node.readOnly || (node instanceof HTMLInputElement && node.type === 'file')) throw new Error('Field cannot be filled.')
        const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        // oxlint-disable-next-line typescript/unbound-method -- The DOM setter is called below with its owning element.
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (setter === undefined) throw new Error('Field value setter unavailable.')
        node.focus()
        setter.call(node, command.text)
        node.dispatchEvent(new Event('input', { bubbles: true }))
        node.dispatchEvent(new Event('change', { bubbles: true }))
      } else if (node.isContentEditable) {
        node.focus()
        node.textContent = command.text ?? ''
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: command.text ?? null }))
      } else throw new Error('Element is not an editable field.')
    }
    if (command.action === 'press') node.focus()
  }
  const text = document.querySelector('body')?.innerText ?? ''
  const all = Array.from(document.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"],[tabindex]'))
    .filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')
  const nodes = all.slice(0, command.maxElements)
  carrier.__dshBrowserSnapshot = { token, nodes }
  return { url: location.href, title: document.title, text: text.slice(0, command.maxText),
    truncated: text.length > command.maxText || all.length > nodes.length,
    elements: nodes.map((node, index) => ({
      ref: `${token}:${index}`, tag: node.tagName.toLowerCase(),
      label: (node.getAttribute('aria-label') ?? node.getAttribute('placeholder') ?? node.textContent).slice(0, 200),
    })) }
}

/** Execute a fixed operation; callers validate ownership and navigation before entry.
 * @param guest - plugin-owned live webview.
 * @param command - validated page operation after navigation settles.
 * @returns bounded page observation.
 */
export async function controlBrowserGuest(guest: Pick<WebviewElement, 'executeJavaScript' | 'sendInputEvent'>, command: SidebarBrowserCommand): Promise<SidebarBrowserPage> {
  if (command.action === 'webmcp_list' || command.action === 'webmcp_execute') {
    const webmcp = await executeWebMcp(command, script => guest.executeJavaScript(script, true))
    const page = await controlBrowserGuest(guest, { ...command, action: 'read', ref: undefined })
    return { ...page, webmcp }
  }
  const run = async (operation: SidebarBrowserCommand): Promise<SidebarBrowserPage> => {
    const value = await guest.executeJavaScript(`(${pageOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify(randomUUID())})`, true)
    if (typeof value !== 'object' || value === null || !('url' in value) || typeof value.url !== 'string'
      || !('title' in value) || typeof value.title !== 'string' || !('text' in value) || typeof value.text !== 'string'
      || value.text.length > command.maxText || !('truncated' in value) || typeof value.truncated !== 'boolean'
      || !('elements' in value) || !Array.isArray(value.elements) || value.elements.length > command.maxElements) {
      throw new Error('Page returned an invalid browser observation.')
    }
    const elements = value.elements.map((item: unknown) => {
      if (typeof item !== 'object' || item === null || !('ref' in item) || typeof item.ref !== 'string'
        || !('tag' in item) || typeof item.tag !== 'string' || !('label' in item) || typeof item.label !== 'string'
        || item.label.length > 200) throw new Error('Page returned an invalid element observation.')
      return { ref: item.ref, tag: item.tag, label: item.label }
    })
    return { url: value.url, title: value.title, text: value.text, truncated: value.truncated, elements }
  }
  const result = await run(command)
  if (command.action === 'press' && command.key !== undefined) {
    const keyCode = command.key === 'Space' ? ' ' : command.key
    await guest.sendInputEvent({ type: 'keyDown', keyCode })
    await guest.sendInputEvent({ type: 'keyUp', keyCode })
  }
  return command.action === 'press' ? run({ ...command, action: 'read', ref: undefined }) : result
}
