import { useCallback, useEffect, useRef, useState } from "react"
import { nextInventory, type InventorySnapshot } from "./inventory-live.ts"

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  last_seen: number
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  permanent?: boolean
  traffic_incomplete?: boolean
  muted_until?: number
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  month_start: string
  /** Panel only. */
  hostname?: string
  /** ISO 3166-1 alpha-2, derived from the address the agent connects from. */
  country: string
  ip?: string
  ipv4?: string
  ipv6?: string
  remark?: string
  /** Provider website. Only returned to signed-in callers. */
  website?: string
  /** Public labels. Separate entries with semicolons; `<color>` is theme metadata. */
  tags: string
  /** Panel only. Empty for nodes created before the hub retained a copy. */
  token?: string
  /** Panel only. Whether going offline and returning are announced. */
  notify?: boolean
  /** Panel only. This node uses manual, offline upgrades. */
  offline_only?: boolean
  terminal_capable?: boolean
  terminal_enabled?: boolean
  terminal_reason?: "available" | "policy" | "plaintext" | "unknown" | "offline"
  network_interfaces?: string[] | null
}

export type PingTask = { id: number; name: string; target: string; interval: number; nodes: number[] }

/** One status-page view, newest first. Geo fields are empty until the hub's
 * lookup answers, or forever for an address that has none. */
export type VisitorRow = {
  id: number
  ts: number
  ip: string
  ua: string
  city?: string
  region?: string
  country?: string
  org?: string
}

/** Form snapshots must never overwrite fields the user did not edit. */
export function changes<T extends object>(initial: T, values: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial[key as keyof T])) as Partial<T>
}

export const GIB = 1024 ** 3

/** Web Terminal was added to Cagent 1.1.0. */
export function supportsTerminal(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  if (!match) return false
  const current = match.slice(1, 4).map(Number)
  const minimum = [1, 1, 0]
  for (let i = 0; i < minimum.length; i += 1) {
    if (current[i] !== minimum[i]) return current[i] > minimum[i]
  }
  return true
}

export function terminalControl(n: Pick<Node, "online" | "agent_version" | "terminal_capable" | "terminal_enabled" | "terminal_reason">) {
  if (!n.online) return { disabled: true, text: "节点离线" }
  if (n.terminal_enabled === false) return { disabled: true, text: "管理员已禁用终端" }
  if (!supportsTerminal(n.agent_version)) return { disabled: true, text: "请升级 Cagent 至 1.1.0 或更高版本" }
  if (n.terminal_reason === "plaintext") return { disabled: true, text: "当前 HTTP 连接仅支持监控上报" }
  if (n.terminal_capable === false || n.terminal_reason === "policy") return { disabled: true, text: "Agent 已禁用终端" }
  return { disabled: false, text: n.terminal_reason === "available" ? "打开 Web Terminal" : "打开终端（旧版 Agent 未报告连接能力）" }
}

/**
 * The traffic fields as a `TrafficPatch`: GB entered by hand, bytes on the wire,
 * and only the counters actually given a value.
 *
 * An emptied field means the counter is left unchanged rather than set to zero.
 * The patch is entirely `Option` and `set_traffic` COALESCEs, so omitting the key
 * expresses that; sending 0 would clear a lifetime total, the one figure that may
 * never decrease and that nothing can recompute. Zeroing deliberately remains one
 * keystroke away.
 */
export function trafficCorrection(
  pristine: Record<string, string>,
  typed: Record<string, string>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(changes(pristine, typed))
      .filter(([, value]) => String(value).trim() !== "")
      .map(([key, value]) => [key, Math.round(Number(value) * GIB)]),
  )
}

/** Private, carrier-grade NAT, loopback or link-local: unreachable from outside the machine's own network. */
function isLocalV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
}

/**
 * The addresses shown for a node. The agent reports its interfaces; `ip` is
 * where its connection arrived from, which the hub canonicalizes to dotted form
 * for IPv4. Behind NAT the interface holds only a private IPv4 while the
 * connection arrives from the public one, so that address leads. `ip` alone is
 * also the fallback for an agent too old to report its interfaces.
 */
export function addresses(node: Pick<Node, "ip" | "ipv4" | "ipv6">): string[] {
  const reported = [node.ipv4, node.ipv6].filter(Boolean) as string[]
  const { ip } = node
  if (!ip) return reported
  if (node.ipv4 && isLocalV4(node.ipv4) && ip.includes(".") && !isLocalV4(ip)) return [ip, ...reported]
  return reported.length ? reported : [ip]
}

/** Installation commands require a TLS origin with a domain, never an IP. */
export function provisioningSite(site: string): string {
  try {
    const u = new URL(site)
    return u.protocol === "https:" && !u.hostname.startsWith("[") && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
      && u.hostname !== "localhost" && !u.hostname.endsWith(".localhost") && !u.username && !u.password
      && u.pathname === "/" && !u.search && !u.hash ? u.origin : ""
  } catch {
    return ""
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Writes are never replayed automatically: callers can query their result. */
export async function api<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort(init.signal?.reason)
  if (init.signal?.aborted) cancel()
  else init.signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const headers = new Headers(init.headers)
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json")
  try {
    const res = await fetch(`/api${path}`, { ...init, headers, signal: controller.signal })
    if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText || `HTTP ${res.status}`)
    return res.status === 204 ? undefined as T : await res.json()
  } catch (error) {
    if (timedOut) throw new Error("请求超时，请重试；写入操作请先刷新确认结果")
    throw error
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener("abort", cancel)
  }
}

/**
 * 4 MiB: the only size a reverse proxy must pass, whatever the file behind it
 * weighs. The hub accepts up to 8 MiB per request, so this can change without
 * touching the server or negotiating first.
 */
const CHUNK = 4 * 1024 * 1024

/**
 * Uploads a file one chunk at a time. There is no upload id: the hub tracks an
 * upload by the length of what it has already written, so a chunk states only
 * where it begins. The last one carries the result.
 */
export async function upload<T>(
  path: string,
  file: File,
  onProgress?: (sent: number) => void,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  if (file.size === 0) throw new ApiError(400, "文件是空的")
  let last: Response | null = null
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    // A chunk boundary is a genuine stopping point: the hub applies nothing until
    // the last piece lands, and `offset = 0` truncates whatever an abandoned
    // attempt left behind, so aborting here leaves the state unchanged.
    if (signal?.aborted) throw new DOMException("aborted", "AbortError")
    const res = await fetch(`/api${path}?offset=${offset}&total=${file.size}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", ...headers },
      body: file.slice(offset, offset + CHUNK),
      signal,
    })
    if (!res.ok) {
      // A 413 never reached the hub: the proxy in front answered, and only its
      // own logs record it. The message names the setting responsible.
      throw new ApiError(
        res.status,
        res.status === 413
          ? "反向代理拒收了 4 MiB 的分片，把 nginx 的 client_max_body_size 调到 8m"
          : (await res.text()) || res.statusText,
      )
    }
    last = res
    onProgress?.(Math.min(offset + CHUNK, file.size))
  }
  return last!.json()
}

export function needsInventory(path: string) {
  return ["/clara/nodes", "/clara/ping", "/clara/notify"].includes(path)
}

export function useNodes(enabled: boolean) {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [stale, setStale] = useState(false)
  const [connection, setConnection] = useState("connecting")
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const lastSuccess = useRef(0)
  const refresh = useCallback(() => setReload(n => n + 1), [])

  useEffect(() => {
    if (!enabled) {
      lastSuccess.current = 0
      // Discard private inventory when leaving the panel or ending a session.
      // oxlint-disable-next-line react/set-state-in-effect
      setNodes(null)
      setLastUpdatedAt(null)
      setStale(false)
      setError(null)
      return
    }

    let socket: WebSocket | null = null
    let request: AbortController | null = null
    let watchdog: ReturnType<typeof setInterval> | undefined
    let running = false
    let live = false
    let lastFrame = 0
    let lastPoll = 0
    let retryAt = 0

    function receive(list: Node[], source: "polling" | "live") {
      lastSuccess.current = Date.now()
      setLastUpdatedAt(lastSuccess.current)
      setConnection(source)
      setStale(false)
      setNodes(list)
      setError(null)
    }
    function abortPoll() {
      request?.abort()
      request = null
    }
    function revoke() {
      stop()
      setNodes(null)
      setLastUpdatedAt(null)
      dispatchEvent(new Event("cmonitor:reauth-required"))
    }
    async function poll() {
      if (!running || live || request) return
      const current = new AbortController()
      request = current
      lastPoll = Date.now()
      try {
        const frame = await api<{admin: boolean; nodes: Node[]}>("/nodes?view=inventory", {signal: current.signal})
        if (request !== current) return
        if (frame.admin === false) { revoke(); return }
        if (frame.admin !== true || !Array.isArray(frame.nodes)) throw new Error("节点列表格式无效")
        receive(frame.nodes, "polling")
      } catch (e) {
        if (request !== current) return
        if (e instanceof ApiError && e.status === 401) revoke()
        else setError(e instanceof Error && e.message || "无法获取最新状态")
      } finally { if (request === current) request = null }
    }
    function disconnect() {
      const old = socket
      socket = null
      live = false
      old?.close()
    }
    function recover() {
      disconnect()
      retryAt = Date.now() + 5000
      setConnection("reconnecting")
      void poll()
    }
    function connect() {
      const scheme = location.protocol === "https:" ? "wss" : "ws"
      try { socket = new WebSocket(`${scheme}://${location.host}/api/ws?view=inventory&format=delta-v1`) }
      catch { recover(); return }
      const current = socket
      lastFrame = Date.now()
      let base: InventorySnapshot | null = null
      current.onmessage = event => {
        if (socket !== current) return
        try {
          const frame = JSON.parse(event.data)
          if (frame.admin === false) { revoke(); return }
          base = nextInventory(base, frame)
          lastFrame = Date.now()
          live = true
          abortPoll()
          receive(base.nodes, "live")
        } catch { recover() }
      }
      current.onclose = current.onerror = () => { if (socket === current) recover() }
    }
    function start() {
      if (running || document.hidden) return
      running = true
      lastPoll = Date.now()
      setConnection("connecting")
      connect()
      watchdog = setInterval(() => {
        const now = Date.now()
        if (lastSuccess.current && now - lastSuccess.current >= 15_000) setStale(true)
        if (socket && now - lastFrame >= 10_000) recover()
        else if (!socket && now >= retryAt) connect()
        if (!live && now - lastPoll >= 5000) void poll()
      }, 1000)
    }
    function stop() {
      running = false
      clearInterval(watchdog)
      disconnect()
      abortPoll()
    }
    function visibility() { if (document.hidden) stop(); else start() }
    document.addEventListener("visibilitychange", visibility)
    start()
    return () => { document.removeEventListener("visibilitychange", visibility); stop() }
  }, [enabled, reload])

  return { nodes, error, lastUpdatedAt, stale, connection, refresh }
}
