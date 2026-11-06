/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { createIframePage } from './pages.ts'
import { createElectronPage } from './electron/pages.ts'
import type { DesktopBrowserBridge } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'
import { parseBrowserAddress } from './browser/url.ts'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Optional initial Browser URL. */
    browser: { readonly url?: string }
  }
}

/** Required Browser services. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'remote', 'sessions']

/** Register the Browser type, localized guide entry, body, and title. */
export function apply(ctx: Context): void {
  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.new' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('browser', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-browser: shortcut')
  })
  const store = createBrowserStore()
  const openTabs = ctx.sidebarRight.openTabs
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly browser?: DesktopBrowserBridge }
  }).dshDesktop
  const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined
  ctx.effect(() => ctx.locale.register(namespace, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: desktop !== undefined }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context, factory: (sessionId: BrowserBodyProps['sessionId']) => BrowserPageFactory): void => {
    const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
    const mounted = new Set<() => void>()
    const lifetime = new AbortController()
    scope.effect(() => async () => {
      lifetime.abort()
      const pending = [...controllers.values()].map(controller => controller.dispose())
      controllers.clear()
      await Promise.all(pending)
    }, 'ui-sidebar-browser.frames')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
      inject: (sessionId, actions) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions)
          return existing
        }
        const controller = createBrowserControllers(actions, factory(sessionId), tabId =>
          openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId))
        const injected: BrowserInjected = { ...controller, mount(request) {
          const release = controller.mount(request)
          for (const listener of mounted) listener()
          return release
        } }
        controllers.set(sessionId, injected)
        return injected
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
    if (desktop !== undefined) scope.remote.$on('sidebar-browser/request', async function (request, next) {
      const sessionId = scope.sessions.scopeOf(this)
      if (sessionId === undefined) return next()
      const signal = AbortSignal.any([request.signal, lifetime.signal])
      signal.throwIfAborted()
      const command = request.command
      const tabs = () => openTabs.getSnapshot().filter(tab => tab.sessionId === sessionId && tab.kind === 'browser')
      const inventory = () => tabs().map(tab => ({
        tabId: tab.tabId, url: controllers.get(sessionId)?.controller(tab.tabId)?.getSnapshot().frame.target?.url,
      }))
      if (command.action === 'list') return { tabs: inventory() }
      let tabId = command.tabId as TabId | undefined
      if (command.action === 'open') {
        const parsed = parseBrowserAddress(command.url ?? '', location.origin)
        if (!parsed.ok) throw new Error(`Invalid browser URL: ${parsed.reason}`)
        const previous = new Set(tabs().map(tab => tab.tabId))
        scope.sidebarRight.openTabIn(sessionId, 'browser', { params: { url: parsed.target.url } })
        tabId = tabs().find(tab => !previous.has(tab.tabId))?.tabId
        if (tabId === undefined) throw new Error('Open this conversation before opening a browser tab.')
      }
      if (tabId === undefined || !tabs().some(tab => tab.tabId === tabId)) throw new Error('Browser tab does not belong to this conversation.')
      if (command.action === 'close') {
        scope.sidebarRight.closeIn(sessionId, tabId)
        return { tabs: inventory() }
      }
      const id = tabId
      const controller = await new Promise<NonNullable<ReturnType<BrowserInjected['controller']>>>((resolve, reject) => {
        const clean = (): void => { mounted.delete(check); unsubscribe(); signal.removeEventListener('abort', cancel) }
        const cancel = (): void => { clean(); reject(new Error('Browser operation cancelled.', { cause: signal.reason })) }
        const check = (): void => {
          if (!tabs().some(tab => tab.tabId === id)) { clean(); reject(new Error('Browser tab was closed.')); return }
          const value = controllers.get(sessionId)?.controller(id)
          if (value !== undefined) { clean(); resolve(value) }
        }
        const unsubscribe = openTabs.subscribe(check)
        mounted.add(check)
        signal.addEventListener('abort', cancel, { once: true })
        check()
      })
      const page = await controller.control({ ...command, action: command.action === 'open' ? 'read' : command.action }, signal)
      return { tabs: inventory(), tabId: id, page }
    })
  }
  if (desktop === undefined) installFrames(ctx, () => createIframePage)
  else ctx.inject(['workspaces'], (scope) => {
    installFrames(scope, sessionId => options => createElectronPage(options, desktop,
      signal => browserWorkspace(scope.workspaces.list, sessionId, signal)))
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
