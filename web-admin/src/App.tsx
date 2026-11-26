import { readPreference, savePreference } from "@/lib/storage"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ExternalLink, LogOut, Moon, Sun } from "lucide-react"
import { toast, Toaster } from "sonner"

const Admin = lazy(() => import("@/components/Admin").then(m => ({ default: m.Admin })))
import { Login } from "@/components/Login"
import { RestoreStatus } from "@/components/RestoreStatus"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, ApiError, needsInventory, provisioningSite, useNodes } from "@/lib/api"

type Me = { authed: boolean; github: boolean; password_login: boolean; hub_version: string | null; embedded_theme_version?: string; active_theme_version?: string; site_name: string; public_page: boolean; site: string; can_provision: boolean }

// `/clara` alone is not a page; it is normalised to the first section so that a
// bookmark and the OAuth redirect both resolve to a real route.
function normalise(p: string) {
  return p === "/clara" || p === "/clara/" ? "/clara/nodes" : p.replace(/\/$/, "") || "/clara/nodes"
}

function usePath() {
  const [path, setPath] = useState(() => {
    const start = normalise(location.pathname)
    if (start !== location.pathname) history.replaceState({}, "", start + location.search + location.hash)
    return start
  })
  useEffect(() => {
    const sync = () => {
      if (normalise(location.pathname) === path) return // A section link stays in the same form.
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
      window.scrollTo(0, 0)
    }, []),
  ] as const
}

function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = readPreference("theme")
    return saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  })
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    savePreference("theme", dark ? "dark" : "light")
  }, [dark])
  return [dark, () => setDark((d) => !d)] as const
}

function AdminApp() {
  const [path, go] = usePath()
  const [signingOut, setSigningOut] = useState(false)
  const [dark, toggleTheme] = useTheme()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const meRequest = useRef(0)
  const subscribed = !!me?.authed && needsInventory(path)
  const { nodes, error, refresh, stale, lastUpdatedAt, connection } = useNodes(subscribed)
  const sorted = useMemo(() => nodes && [...nodes].sort((a, b) => a.sort - b.sort || a.id - b.id), [nodes])

  const loadMe = useCallback(() => {
    // `|| "..."` because an empty message reads as no error: api() falls back to
    // res.statusText, which HTTP/2 and HTTP/3 removed, so a bodiless 502 from a
    // proxy arrives as "". The check below would then take the loading branch and
    // the retry button would never render.
    const request = ++meRequest.current
    return api<Me>("/me")
      .then((next) => { if (meRequest.current === request) { setMe(next); setMeError("") } })
      .catch((e: Error) => { if (meRequest.current === request) setMeError(e.message || "网络错误") })
  }, [])
  useEffect(() => {
    loadMe()
    const siteUpdated = () => { void loadMe() }
    const reauthenticate = () => {
      setMe(null)
      setMeError("")
      void loadMe()
    }
    addEventListener("cmonitor:site-updated", siteUpdated)
    addEventListener("cmonitor:reauth-required", reauthenticate)
    return () => {
      removeEventListener("cmonitor:site-updated", siteUpdated)
      removeEventListener("cmonitor:reauth-required", reauthenticate)
    }
  }, [loadMe])
  useEffect(() => {
    const restored = () => { loadMe(); refresh() }
    addEventListener("cmonitor:restore-complete", restored)
    return () => removeEventListener("cmonitor:restore-complete", restored)
  }, [loadMe, refresh])

  // Pages without a live stream still need to notice a revoked session.
  useEffect(() => {
    if (!me?.authed || subscribed) return
    let pending: AbortController | null = null
    async function check() {
      if (document.hidden || pending) return
      const request = new AbortController()
      pending = request
      try {
        await api("/auth/session", {signal: request.signal, cache: "no-store"})
      } catch (e) {
        if (request.signal.aborted || !(e instanceof ApiError)) return
        if (e.status === 401) dispatchEvent(new Event("cmonitor:reauth-required"))
        else if (e.status === 404) void loadMe() // While an older Hub is still serving this tab.
      } finally { if (pending === request) pending = null }
    }
    const timer = setInterval(check, 15_000)
    document.addEventListener("visibilitychange", check)
    return () => { pending?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", check) }
  }, [me?.authed, subscribed, loadMe])

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
        <Login github={me.github} passwordEnabled={me.password_login} onDone={loadMe} />
        <Toaster position="top-center" theme={dark ? "dark" : "light"} />
      </>
    )
  }


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
      <a href="#admin-content" className="admin-skip-link">跳转到后台内容</a>
      <header className="admin-topbar sticky top-0 z-10 border-b backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-2 px-3 sm:gap-4 sm:px-6">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={32} height={32} className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <a href="/" className="truncate rounded-sm font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring" title={me.site_name || "Monitor"}>{me.site_name || "Monitor"}</a>
              <span title={`内置主题 ${me.embedded_theme_version ?? "未知"} · 当前主题 ${me.active_theme_version ?? "未知"}`} className="shrink-0 text-xs text-muted-foreground">
                <span className={me.hub_version ? "hidden sm:inline" : ""}>后台</span>
                {me.hub_version && <span className="font-mono sm:ml-2">Hub v{me.hub_version}</span>}
              </span>
            </div>
            {subscribed && lastUpdatedAt && <div title="节点状态最近更新" className="tnum flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${stale ? "bg-warn" : connection === "live" ? "bg-ok" : "bg-muted-foreground"}`} />
              {stale ? "更新中断" : connection === "live" ? "实时更新" : "轮询更新"}
              <time dateTime={new Date(lastUpdatedAt).toISOString()} title="最近更新">{new Date(lastUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</time>
            </div>}
          </div>
          <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
            <Button variant="ghost" size="sm" className="size-11 sm:w-auto" asChild>
              <a href="/" aria-label="状态面板" title="状态面板"><ExternalLink aria-hidden="true" /><span className="hidden sm:inline">状态面板</span></a>
            </Button>
            <Button variant="ghost" size="icon-lg" className="size-11" onClick={toggleTheme} title="切换主题" aria-label="切换主题" aria-pressed={dark}>
              {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </Button>
            <Button variant="ghost" size="icon-lg" className="size-11" onClick={signOut} disabled={signingOut} title="退出登录" aria-label="退出登录">
              <LogOut aria-hidden="true" />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] space-y-4 px-3 py-4 sm:px-6 sm:py-6">
        <Suspense fallback={<Skeleton role="status" aria-label="正在加载后台" className="h-96" />}>
          <Admin
            path={path}
            go={go}
            nodes={sorted}
            nodeError={error}
            staleSince={stale ? lastUpdatedAt : null}
            refresh={refresh}
            // The hub's own public URL rather than this browser's address: the
            // panel is frequently reached over a loopback port behind a proxy,
            // while the install command and OAuth callback need the real one.
            site={me.site || location.origin}
            canProvision={me.can_provision && !!provisioningSite(location.origin) && !!provisioningSite(me.site || location.origin)}
          />
        </Suspense>
      </div>

      <Toaster position="top-center" theme={dark ? "dark" : "light"} />
    </div>
  )
}

export default function App() {
  return <><RestoreStatus /><AdminApp /></>
}
