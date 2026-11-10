import { useCallback, useEffect, useState } from "react"
import { ExternalLink, LogOut, Moon, Sun } from "lucide-react"
import { toast, Toaster } from "sonner"

import { Admin } from "@/components/Admin"
import { Login } from "@/components/Login"
import { RestoreStatus } from "@/components/RestoreStatus"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, provisioningSite, useNodes } from "@/lib/api"

type Me = { authed: boolean; github: boolean; password_login: boolean; hub_version: string | null; site_name: string; public_page: boolean; site: string; can_provision: boolean }

// `/clara` alone is not a page; it is normalised to the first section so that a
// bookmark and the OAuth redirect both resolve to a real route.
function normalise(p: string) {
  return p === "/clara" || p === "/clara/" ? "/clara/nodes" : p.replace(/\/$/, "") || "/clara/nodes"
}

function usePath() {
  const [path, setPath] = useState(() => {
    const start = normalise(location.pathname)
    if (start !== location.pathname) history.replaceState({}, "", start + location.search)
    return start
  })
  useEffect(() => {
    const sync = () => {
      if (!dispatchEvent(new Event("cmonitor:navigate", {cancelable:true}))) { history.pushState({},"",path); return }
      setPath(normalise(location.pathname))
    }
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [path])
  return [
    path,
    useCallback((next: string) => {
      if (!dispatchEvent(new Event("cmonitor:navigate", { cancelable: true }))) return
      const to = normalise(next)
      history.pushState({}, "", to)
      setPath(to)
    }, []),
  ] as const
}

function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("theme")
    return saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  })
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    localStorage.setItem("theme", dark ? "dark" : "light")
  }, [dark])
  return [dark, () => setDark((d) => !d)] as const
}

function AdminApp() {
  const [path, go] = usePath()
  const [signingOut, setSigningOut] = useState(false)
  const [dark, toggleTheme] = useTheme()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, admin, error, refresh, stale, lastUpdatedAt, connection } = useNodes()

  const loadMe = useCallback(() => {
    // `|| "..."` because an empty message reads as no error: api() falls back to
    // res.statusText, which HTTP/2 and HTTP/3 removed, so a bodiless 502 from a
    // proxy arrives as "". The check below would then take the loading branch and
    // the retry button would never render.
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message || "网络错误"))
  }, [])
  useEffect(() => {
    loadMe()
  }, [loadMe])
  useEffect(() => {
    const restored = () => { loadMe(); refresh() }
    addEventListener("cmonitor:restore-complete", restored)
    return () => removeEventListener("cmonitor:restore-complete", restored)
  }, [loadMe, refresh])

  // Every frame declares its audience. The hub closes the stream when the session
  // behind it is revoked -- signed out from another device, a password change, a
  // restore -- and the reconnect returns as anonymous: the public list, with
  // private nodes absent and every admin field empty, rendered inside a panel that
  // still appears signed in. `authed` is read only at mount and after signing in,
  // so nothing else detects this. /api/me already handles signing out.
  useEffect(() => {
    if (me?.authed && admin === false) loadMe()
  }, [admin, me?.authed, loadMe])

  // Only while there is nothing else to show. Login's onDone reloads /me, so a
  // transient failure in the second after signing in would otherwise replace the
  // entire signed-in panel with a full-page error while the node list streamed
  // normally.
  if (!me) return (
    <div className="grid min-h-svh place-items-center p-6 text-sm text-muted-foreground">
      {meError ? <div className="space-y-3 text-center"><p role="alert">加载失败：{meError}</p><Button onClick={loadMe}>重试</Button></div> : "加载中…"}
    </div>
  )

  if (!me.authed) {
    return (
      <>
        <Login github={me.github} passwordEnabled={me.password_login} onDone={() => { loadMe(); refresh(); go("/clara/nodes") }} />
        <Toaster position="top-center" theme={dark ? "dark" : "light"} />
      </>
    )
  }

  const sorted = [...(nodes ?? [])].sort((a, b) => a.sort - b.sort || a.id - b.id)

  async function signOut() {
    if (signingOut || !dispatchEvent(new Event("cmonitor:navigate", { cancelable: true }))) return
    setSigningOut(true)
    try {
      await api("/auth/logout", { method: "POST" })
      location.assign("/")
    } catch {
      const current = await api<Me>("/me").catch(() => null)
      if (current?.authed === false) location.assign("/")
      else toast.error(current ? "退出失败，请重试" : "无法确认退出结果，请恢复网络后重试")
    } finally { setSigningOut(false) }
  }

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3">
          {/* The site name is the way back to the status page, as in the
              theme's own header. */}
          <a href="/" className="flex items-center gap-2 font-semibold transition-opacity hover:opacity-70">
            <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" className="size-5 rounded-md" />
            {me.site_name || "Monitor"}
          </a>
          <span className="text-xs text-muted-foreground">后台{me.hub_version && <span className="ml-2 whitespace-nowrap font-mono">Hub v{me.hub_version}</span>}</span>
          <div className="flex-1" />
          {/* The status page is a separate app, so this is a navigation. */}
          <Button variant="ghost" size="sm" asChild>
            <a href="/">
              <ExternalLink /> 状态面板
            </a>
          </Button>
          <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题">
            {dark ? <Sun /> : <Moon />}
          </Button>
          <Button variant="ghost" size="icon" onClick={signOut} disabled={signingOut} title="退出登录">
            <LogOut />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-6">
        {stale && <p role="status" className="rounded-lg border p-3 text-sm">数据更新中断。以下为 {lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString("zh-CN") : "—"} 收到的历史状态，请勿据此判断当前在线情况。<Button variant="ghost" size="sm" onClick={refresh}>重试</Button></p>}
        {!stale && lastUpdatedAt && <p className="text-xs text-muted-foreground">{connection === "live" ? "实时更新" : "轮询更新"} · 最近更新 {new Date(lastUpdatedAt).toLocaleTimeString("zh-CN")}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!nodes ? (
          <Skeleton className="h-64" />
        ) : (
          <Admin
            path={path}
            go={go}
            nodes={sorted}
            refresh={refresh}
            // The hub's own public URL rather than this browser's address: the
            // panel is frequently reached over a loopback port behind a proxy,
            // while the install command and OAuth callback need the real one.
            site={me.site || location.origin}
            canProvision={me.can_provision && !!provisioningSite(location.origin) && !!provisioningSite(me.site || location.origin)}
          />
        )}
      </main>

      <Toaster position="top-center" theme={dark ? "dark" : "light"} />
    </div>
  )
}

export default function App() {
  return <><RestoreStatus /><AdminApp /></>
}
