import { useEffect, useRef, useState } from "react"
import { Terminal as TerminalIcon } from "lucide-react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { api, type Node } from "@/lib/api"
import { Input } from "@/components/ui/input"

type TerminalState = "connecting" | "online" | "closed" | "error"

function LiveTerminalDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const socket = useRef<WebSocket | null>(null)
  const [state, setState] = useState<TerminalState>("connecting")
  const [message, setMessage] = useState("正在连接 Hub…")

  useEffect(() => {
    let disposed = false
    let currentState: TerminalState = "connecting"
    const updateState = (next: TerminalState, text: string) => {
      currentState = next
      setState(next)
      setMessage(text)
    }
    const detail = (error: unknown) => error instanceof Error && error.message ? `：${error.message}` : ""
    const host = container
    if (!host) return
    updateState("connecting", "正在连接 Hub…")

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal/ws`
    let ws: WebSocket
    try {
      // Start the handshake before xterm touches the DOM. If xterm fails, the
      // Hub log still tells us whether the browser reached this point.
      ws = new WebSocket(url)
    } catch (error) {
      updateState("error", `浏览器无法创建终端连接${detail(error)}`)
      return
    }
    socket.current = ws
    const connectTimer = window.setTimeout(() => {
      if (!disposed && ws.readyState !== WebSocket.OPEN) {
        updateState("error", "无法连接 Hub 的终端通道，请检查反向代理的 WebSocket 配置")
        ws.close()
      }
    }, 10_000)

    const initialize = () => {
      const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 15,
        scrollback: 5000,
        theme: { background: "#0d1117", foreground: "#e6edf3", cursor: "#58a6ff" },
      })
      try {
        const fit = new FitAddon()
        terminal.loadAddon(fit)
        terminal.open(host)
        return { terminal, fit }
      } catch (error) {
        terminal.dispose()
        throw error
      }
    }
    let initialized: ReturnType<typeof initialize>
    try {
      initialized = initialize()
    } catch (error) {
      window.clearTimeout(connectTimer)
      updateState("error", `终端界面初始化失败${detail(error)}`)
      ws.close()
      socket.current = null
      return
    }
    const { terminal, fit } = initialized

    const resize = () => {
      if (disposed || !host.clientWidth || !host.clientHeight) return
      fit.fit()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }))
      }
    }
    const observer = new ResizeObserver(() => requestAnimationFrame(resize))
    observer.observe(host)

    const data = terminal.onData((input) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: input }))
    })
    const resized = terminal.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }))
    })

    ws.onopen = () => {
      window.clearTimeout(connectTimer)
      fit.fit()
      ws.send(JSON.stringify({ type: "connect", node_id: node.id, cols: terminal.cols, rows: terminal.rows }))
      if (!disposed) {
        setMessage("正在启动终端…")
      }
    }
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as { type?: string; message?: string; method?: string; params?: { data?: string; reason?: string; message?: string } }
        if (frame.type === "error") {
          updateState("error", frame.message || "终端连接失败")
        } else if (frame.method === "terminal.ready") {
          updateState("online", "已连接")
          terminal.focus()
        } else if (frame.method === "terminal.output" && frame.params?.data) {
          terminal.write(frame.params.data)
        } else if (frame.method === "terminal.error") {
          updateState("error", frame.params?.message || "终端发生错误")
          terminal.write(`\r\n\x1b[31m${frame.params?.message || "终端发生错误"}\x1b[0m\r\n`)
        } else if (frame.method === "terminal.exit") {
          updateState("closed", "终端进程已结束")
          terminal.write(`\r\n\x1b[90m终端进程已结束${frame.params?.reason ? `：${frame.params.reason}` : ""}\x1b[0m\r\n`)
        }
      } catch {
        updateState("error", "收到无法识别的终端数据")
      }
    }
    ws.onerror = () => {
      window.clearTimeout(connectTimer)
      if (!disposed && currentState !== "error") {
        updateState("error", "终端连接失败，请确认节点在线")
      }
    }
    ws.onclose = () => {
      window.clearTimeout(connectTimer)
      if (!disposed) {
        if (currentState !== "error" && currentState !== "closed") updateState("closed", "连接已关闭")
      }
    }

    return () => {
      disposed = true
      window.clearTimeout(connectTimer)
      observer.disconnect()
      data.dispose()
      resized.dispose()
      ws.close()
      socket.current = null
      terminal.dispose()
    }
  }, [node.id, container])

  const status = {
    connecting: "连接中",
    online: "在线",
    closed: "已关闭",
    error: "错误",
  }[state]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="grid h-[calc(100dvh_-_1rem)] w-[calc(100vw_-_1rem)] max-h-[calc(100dvh_-_1rem)] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3 overflow-hidden p-3 sm:h-[calc(100dvh_-_2rem)] sm:max-h-[calc(100dvh_-_2rem)] sm:max-w-7xl sm:p-4 2xl:max-w-[96rem]"
      >
        <DialogHeader className="px-1">
          <DialogTitle className="flex items-center gap-2"><TerminalIcon className="size-4" />{node.name} · Web Terminal</DialogTitle>
          <DialogDescription>终端命令在目标节点上以 root 权限执行。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-2"><span className={`size-2 rounded-full ${state === "online" ? "bg-ok" : state === "error" ? "bg-destructive" : "bg-muted-foreground"}`} />{status}</span>
          <span className="truncate" title={message}>{message}</span>
        </div>
        <div className="terminal-surface min-h-0 overflow-hidden rounded-md border bg-[#0d1117] p-2 shadow-xs">
          <div ref={setContainer} className="h-full min-h-0 w-full" />
        </div>
        <DialogFooter className="pt-1">
          <Button variant="ghost" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Access = { allowed: boolean; github: boolean; password_login: boolean }
export function TerminalDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const [access, setAccess] = useState<Access | null>(null)
  const [error, setError] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const load = () => api<Access>("/terminal/access").then(setAccess).catch((e: Error) => setError(e.message))
  useEffect(() => { void load() }, [])
  if (access?.allowed) return <LiveTerminalDialog node={node} onClose={onClose} />
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent>
    <DialogHeader><DialogTitle>确认终端访问身份</DialogTitle><DialogDescription>终端以 root 权限运行。请在最近 10 分钟内重新认证后打开。</DialogDescription></DialogHeader>
    {!access && !error && <p role="status">正在检查认证状态…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {access?.github && <Button asChild variant="outline"><a href="/api/auth/github">使用 GitHub 重新认证</a></Button>}
    {access?.password_login && <form className="space-y-3" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("")
      try { await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) }); setPassword(""); await load() }
      catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>
      <label htmlFor="terminal-reauth-password" className="text-sm">应急密码</label>
      <Input id="terminal-reauth-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
      <Button disabled={busy || !password} type="submit">{busy ? "认证中…" : "认证并打开终端"}</Button>
    </form>}
    {!access && error && <Button onClick={() => { setError(""); void load() }}>重试</Button>}
  </DialogContent></Dialog>
}
