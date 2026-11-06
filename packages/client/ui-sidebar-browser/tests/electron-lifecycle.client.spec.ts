// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserReservation } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

const target = { kind: 'https' as const, url: 'https://example.test/', title: 'Example' }
const fixtures: ReturnType<typeof electronFixture>[] = []
function fixture() {
  const h = electronFixture()
  fixtures.push(h)
  return h
}
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.dispose()
  vi.restoreAllMocks()
})

it('waits for a mounted container and observes native history, titles and new-tab requests', async () => {
  const h = fixture()
  h.frame.goBack()
  h.frame.goForward()
  h.frame.reload()
  h.frame.loadUrl(target)
  expect(h.bridge.acquire).not.toHaveBeenCalled()
  h.mount()
  const guest = await h.guest()
  expect(guest.element.getAttribute('name')).toBe(h.reservation.lease)
  expect(guest.element.getAttribute('partition')).toBe(h.reservation.partition)
  expect(guest.element.getAttribute('src')).toBe(`about:blank#${h.reservation.lease}`)
  guest.emit('dom-ready')
  expect(guest.loadURL).toHaveBeenCalledWith(target.url)
  guest.state.url = target.url
  guest.state.title = 'Title'
  guest.state.back = true
  guest.state.forward = true
  guest.emit('did-navigate')
  expect(guest.clearHistory).toHaveBeenCalledOnce()
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'observed', target: { ...target, title: 'Title' } })
  expect(guest.element.getAttribute('aria-label')).toBe('Title')
  const writes = h.persist.mock.calls.length
  guest.emit('page-title-updated')
  expect(h.persist).toHaveBeenCalledTimes(writes)
  h.frame.loadUrl(target)
  h.frame.goBack()
  h.frame.goForward()
  expect(guest.reload).toHaveBeenCalledOnce()
  expect(guest.goBack).toHaveBeenCalledOnce()
  expect(guest.goForward).toHaveBeenCalledOnce()
  guest.state.url = `${target.url}next`
  guest.emit('did-navigate-in-page', { isMainFrame: false })
  expect(h.frame.getSnapshot().target?.url).toBe(target.url)
  guest.emit('did-navigate-in-page', { isMainFrame: true })
  guest.state.title = ''
  guest.state.loading = false
  guest.emit('page-title-updated')
  guest.emit('did-stop-loading')
  expect(h.frame.getSnapshot()).toMatchObject({ loading: false, target: { url: guest.state.url, title: 'example.test' } })
  const open = h.bridge.onOpenRequested.mock.calls[0]![1]
  open('https://new.example/')
  expect(h.openRequested).toHaveBeenCalledOnce()
  await h.frame.dispose()
  open('https://late.example/')
  guest.emit('did-navigate')
  h.frame.loadUrl(target)
  h.frame.reload()
  h.frame.goBack()
  expect(h.openRequested).toHaveBeenCalledOnce()
  expect(h.opens.size).toBe(0)
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
})

it('waits for native page readiness and cancels pending control when its frame is disposed', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  const command = { action: 'read' as const, maxText: 20, maxElements: 10, timeoutMs: 30000 }
  const pending = h.frame.control!(command, new AbortController().signal)
  const rejected = expect(pending).rejects.toBeDefined()
  expect(guest.executeJavaScript).not.toHaveBeenCalled()
  await h.frame.dispose()
  await rejected
  guest.emit('dom-ready')
  expect(guest.executeJavaScript).not.toHaveBeenCalled()
})

it('executes native control only after loading stops on its own webview', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  const command = { action: 'read' as const, maxText: 20, maxElements: 10, timeoutMs: 30000 }
  const pending = h.frame.control!(command, new AbortController().signal)
  guest.state.loading = false
  guest.emit('dom-ready')
  expect(guest.executeJavaScript).not.toHaveBeenCalled()
  guest.emit('did-stop-loading')
  expect(guest.executeJavaScript).not.toHaveBeenCalled()
  guest.state.url = target.url
  guest.state.loading = true
  guest.emit('did-navigate')
  expect(guest.executeJavaScript).not.toHaveBeenCalled()
  guest.state.loading = false
  guest.emit('did-stop-loading')
  await pending
  expect(guest.executeJavaScript).toHaveBeenCalledOnce()
  expect(guest.executeJavaScript.mock.calls[0]?.[1]).toBe(true)
})

it('releases an acquisition that finishes after attachment cancellation', async () => {
  const h = fixture()
  const pending = Promise.withResolvers<DesktopBrowserReservation>()
  h.bridge.acquire.mockReturnValueOnce(pending.promise)
  const unmount = h.mount()
  h.frame.loadUrl(target)
  try {
    await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledOnce() })
    unmount()
    const disposed = h.frame.dispose()
    expect(h.frame.dispose()).toBe(disposed)
    pending.resolve(h.reservation)
    await disposed
    expect(h.guests).toHaveLength(0)
    expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  } finally {
    pending.resolve(h.reservation)
  }
})

it('keeps a tab busy after cancellation until its native execution settles', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.state.url = target.url
  guest.state.loading = false
  guest.emit('dom-ready')
  guest.emit('did-navigate')
  const execution = Promise.withResolvers<unknown>()
  guest.executeJavaScript.mockReturnValueOnce(execution.promise)
  const abort = new AbortController()
  const command = { action: 'read' as const, maxText: 20, maxElements: 10, timeoutMs: 30000 }
  const pending = h.frame.control!(command, abort.signal)
  const rejected = expect(pending).rejects.toBeDefined()
  try {
    await vi.waitFor(() => { expect(guest.executeJavaScript).toHaveBeenCalledOnce() })
    abort.abort()
    await expect(h.frame.control!(command, new AbortController().signal)).rejects.toThrow('still running')
    execution.resolve({ url: target.url, title: 'Example', text: '', truncated: false, elements: [] })
    await rejected
    await h.frame.control!(command, new AbortController().signal)
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(2)
  } finally {
    execution.resolve({ url: target.url, title: 'Example', text: '', truncated: false, elements: [] })
    await rejected
  }
})

it('uses native navigation and reads only after its destination finishes loading', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  guest.state.url = target.url
  guest.state.loading = false
  guest.emit('dom-ready')
  guest.emit('did-navigate')
  const command = { action: 'navigate' as const, url: 'https://example.test/next', maxText: 20, maxElements: 10, timeoutMs: 30000 }
  const pending = h.frame.control!(command, new AbortController().signal)
  await vi.waitFor(() => { expect(guest.loadURL).toHaveBeenCalledWith(command.url) })
  expect(guest.executeJavaScript).not.toHaveBeenCalled()
  guest.state.url = command.url
  guest.state.loading = false
  guest.emit('did-navigate')
  guest.emit('did-stop-loading')
  await pending
  expect(guest.executeJavaScript).toHaveBeenCalledOnce()
  await expect(h.frame.control!({ ...command, url: 'file:///etc/passwd' }, new AbortController().signal)).rejects.toThrow('Invalid browser URL')
  expect(guest.loadURL).not.toHaveBeenCalledWith('file:///etc/passwd')
})

it('does not acquire a guest when Workspace resolution finishes after disposal', async () => {
  const h = fixture()
  const pending = Promise.withResolvers<string>()
  h.workspace.mockReturnValueOnce(pending.promise)
  h.mount()
  h.frame.loadUrl(target)
  try {
    const disposed = h.frame.dispose()
    pending.resolve('cwd:/late')
    await disposed
    expect(h.bridge.acquire).not.toHaveBeenCalled()
    h.mount()
    expect(h.guests).toHaveLength(0)
  } finally {
    pending.resolve('cwd:/late')
  }
})

it('recreates the guest after physical remount or crash without resolving Workspace again', async () => {
  const h = fixture()
  const unmount = h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  unmount()
  h.mount()
  const second = await h.guest()
  expect(second.element).not.toBe(first.element)
  expect(h.workspace).toHaveBeenCalledOnce()
  second.emit('dom-ready')
  expect(second.loadURL).toHaveBeenCalledWith(target.url)
  second.emit('render-process-gone')
  expect(h.frame.getSnapshot().error).toBeDefined()
  h.frame.reload()
  const third = await h.guest()
  third.emit('dom-ready')
  expect(third.loadURL).toHaveBeenCalledWith(target.url)
  expect(h.frame.getSnapshot().error).toBeUndefined()
  third.emit('destroyed')
  expect(h.frame.getSnapshot().error).toBeDefined()
})

it('contains acquisition, native command and release failures and keeps retry available', async () => {
  const h = fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.bridge.acquire.mockRejectedValueOnce(new Error('acquire failed'))
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  h.frame.reload()
  const guest = await h.guest()
  guest.emit('dom-ready')
  guest.state.url = target.url
  guest.emit('did-navigate')
  guest.reload.mockImplementationOnce(() => { throw new Error('command failed') })
  h.frame.reload()
  expect(h.frame.getSnapshot().error).toBeDefined()
  h.frame.reload()
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.getURL.mockImplementationOnce(() => { throw new Error('observation failed') })
  guest.emit('did-navigate')
  expect(h.frame.getSnapshot().error).toBeDefined()
  h.bridge.release.mockRejectedValueOnce(new Error('release failed'))
  await h.frame.dispose()
  expect(error.mock.calls.some(call => call[0] === 'Desktop browser guest release failed')).toBe(true)
})

it('ignores superseded and aborted load promises, but publishes an active navigation rejection', async () => {
  const h = fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  const stale = Promise.withResolvers<undefined>()
  guest.loadURL.mockReturnValueOnce(stale.promise)
  guest.emit('dom-ready')
  h.frame.loadUrl({ ...target, url: 'https://example.test/new' })
  stale.reject(new Error('old navigation failed'))
  await expect(stale.promise).rejects.toThrow('old navigation')
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.loadURL.mockRejectedValueOnce(Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' }))
  h.frame.loadUrl({ ...target, url: 'https://example.test/cancelled' })
  await Promise.resolve()
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.loadURL.mockRejectedValueOnce(new Error('active navigation failed'))
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  expect(error).toHaveBeenCalledOnce()
})
