/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { Scoped } from '@deepseek-ai/dsh-scope'

/** Fixed operations supported by the desktop guest, with bounded page observations. */
export interface SidebarBrowserCommand {
  readonly action: 'list' | 'open' | 'close' | 'read' | 'navigate' | 'back' | 'forward' | 'reload' | 'click' | 'fill' | 'press' | 'webmcp_list' | 'webmcp_execute'
  readonly tabId?: string | undefined
  readonly url?: string | undefined
  readonly ref?: string | undefined
  readonly text?: string | undefined
  readonly key?: string | undefined
  readonly method?: string | undefined
  /** JSON object encoded by the Host for a WebMCP invocation. */
  readonly input?: string | undefined
  readonly maxText: number
  readonly maxElements: number
  readonly timeoutMs: number
}

/** Readable page and element references from one document snapshot. */
export interface SidebarBrowserPage {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  readonly elements: { readonly ref: string; readonly tag: string; readonly label: string }[]
  /** Bounded JSON text containing method descriptors or the invoked method's result. */
  readonly webmcp?: { readonly kind: 'tools' | 'result'; readonly json: string; readonly truncated: boolean }
}

/** Session-local inventory, optionally accompanied by a page observation. */
export interface SidebarBrowserResult {
  readonly tabs: { readonly tabId: string; readonly url?: string | undefined }[]
  readonly tabId?: string
  readonly page?: SidebarBrowserPage
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Delegate a browser operation to a desktop connected to this Agent's Session.
     * @param request - command and cancellation lifetime; the Agent identifies the remote scope.
     * @mode waterfall
     */
    'sidebar-browser/request'(this: Scoped<Agent>,
      request: { readonly agent: Agent; readonly command: SidebarBrowserCommand; readonly signal: AbortSignal },
      next: () => Promise<SidebarBrowserResult>): Promise<SidebarBrowserResult>
  }
}

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
