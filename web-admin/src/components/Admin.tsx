import { lazy, Suspense, Children, cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react"
import { Bell, ChevronRight, Copy, Database, Download, Palette, Pencil, Plus, Radio, RefreshCw, Search, Send, Server, Settings, Shield, Trash2, Upload, Users } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { api, changes, GIB, needsInventory, provisioningSite, trafficCorrection, upload, type Node, type PingTask, type VisitorRow } from "@/lib/api"
import { bytes, CYCLES } from "@/lib/format"
import { AgentRollout } from "./AgentRollout"
import { NodeInventory } from "./NodeInventory"
import { OfflineUpgradeButton } from "./OfflineUpgradeButton"
import { trackRestore, useRestoreOperation } from "@/lib/restore"

// Counters the panel can correct after migration or an accounting error.
const TRAFFIC_FIELDS = [
  ["total_rx", "累计下行"],
  ["total_tx", "累计上行"],
  ["month_rx", "本期下行"],
  ["month_tx", "本期上行"],
] as const
const TRAFFIC_MODES: Record<string, string> = {
  sum: "上下行相加",
  max: "取较大值",
  up: "仅上行",
  down: "仅下行",
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success("已复制"),
    () => toast.error("复制失败"),
  )
}

function Field({ label, hint, className = "", children }: { label: string; hint?: React.ReactNode; className?: string; children: React.ReactNode }) {
  const id = useId()
  const link = (content: React.ReactNode, linked = false): [React.ReactNode, boolean] => {
    const result: React.ReactNode[] = []
    for (const child of Children.toArray(content)) {
      if (!isValidElement<Record<string, unknown>>(child)) { result.push(child); continue }
      if (!linked && (child.type === Input || child.type === SelectTrigger || child.type === "textarea" || child.type === "select")) {
        result.push(cloneElement(child, { id, "aria-describedby": hint ? `${id}-hint` : undefined })); linked = true
      } else if (child.props.children) {
        const [children, found] = link(child.props.children as React.ReactNode, linked)
        result.push(cloneElement(child, {}, children)); linked = found
      } else result.push(child)
    }
    return [result, linked]
  }
  const [controls] = link(children)
  return (
    <div className={`space-y-2 ${className}`}>
      <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
      {controls}
      {hint && <p id={`${id}-hint`} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

function LoadState({ error, retry }: { error: string; retry: () => void }) {
  return <div role={error ? "alert" : "status"} className="flex flex-wrap items-center gap-3 rounded-lg border p-4 text-sm">
    <span>{error ? `加载失败：${error}` : "正在加载…"}</span>
    {error && <Button size="sm" variant="outline" onClick={retry}>重新加载</Button>}
  </div>
}

function useDirtyGuard(dirty: boolean, busy = false) {
  useEffect(() => {
    if (!dirty && !busy) return
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    const navigate = (event: Event & { discarded?: boolean }) => {
      if (event.defaultPrevented || event.discarded) return
      if (busy || !window.confirm("有尚未保存的修改，确定放弃并离开？")) event.preventDefault()
      else event.discarded = true
    }
    addEventListener("beforeunload", unload)
    addEventListener("cmonitor:navigate", navigate)
    return () => { removeEventListener("beforeunload", unload); removeEventListener("cmonitor:navigate", navigate) }
  }, [dirty, busy])
  return () => !busy && (!dirty || window.confirm("有尚未保存的修改，确定放弃？"))
}


function ConfirmDialog({ title, description, confirmLabel, busy = false, canCancelWhileBusy = false, onClose, onConfirm }: {
  title: string
  description: string
  confirmLabel: string
  busy?: boolean
  canCancelWhileBusy?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const canClose = !busy || canCancelWhileBusy
  return (
    <Dialog open onOpenChange={(open) => !open && canClose && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={canClose}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-relaxed">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-t pt-4">
          <Button variant="ghost" onClick={onClose} disabled={!canClose}>取消</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateNode({ onClose, onSaved }: {
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)

  const canClose = useDirtyGuard(!!name, saving)
  const close = () => { if (canClose()) onClose() }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return toast.error("请填写节点名称")
    setSaving(true)
    try {
      await api("/nodes", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      })
      toast.success("节点已添加")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加节点</DialogTitle>
          <DialogDescription>添加后，在节点的「安装 Agent」中复制命令。使用注册窗口安装的 HTTPS 节点会自动配对升级器。单节点使用上报 Token 安装后，须另行配对维护凭据。</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={save}>
          <Field label="名称">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="香港 · 甲商家" />
          </Field>
          <DialogFooter className="border-t pt-4">
            <Button type="button" variant="ghost" onClick={close}>取消</Button>
            <Button type="submit" disabled={saving}>添加</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function NodeForm({ node, onClose, onSaved }: {
  node: Node
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(node)
  const [calibrate, setCalibrate] = useState(false)
  const [limitGib, setLimitGib] = useState(String(node.traffic_limit / GIB || ""))
  const [saving, setSaving] = useState(false)
  const gib = (bytes: number) => String(Number((bytes / GIB).toFixed(3)))
  const [traffic, setTraffic] = useState(() =>
    Object.fromEntries(TRAFFIC_FIELDS.map(([k]) => [k, gib(node[k])])) as Record<string, string>,
  )
  // Compared as entered rather than as bytes: rounding to GB would read as an
  // edit and zero a node that has transferred a few MB.
  const [pristine] = useState(traffic)
  const set = <K extends keyof Node>(k: K, v: Node[K]) => setForm((f) => ({ ...f, [k]: v }))

  const canClose = useDirtyGuard(calibrate || JSON.stringify(form) !== JSON.stringify(node) || limitGib !== String(node.traffic_limit / GIB || "") || JSON.stringify(traffic) !== JSON.stringify(pristine), saving)
  const close = () => { if (canClose()) onClose() }

  async function save() {
    if (!form.name.trim()) return toast.error("请填写节点名称")
    const patch = changes(node, {
      name: form.name.trim(),
      website: (form.website ?? "").trim(),
      public: form.public,
      remark: form.remark,
      tags: form.tags,
      traffic_mode: form.traffic_mode,
      traffic_limit: Math.round(Number(limitGib) * GIB),
      traffic_reset_day: Math.min(31, Math.max(1, Math.round(Number(form.traffic_reset_day) || 1))),
      notify: !!form.notify,
      muted_until: form.muted_until || 0,
    })
    const correction = trafficCorrection(pristine, traffic)
    if (calibrate) { correction.month_rx=Math.round(Number(traffic.month_rx)*GIB); correction.month_tx=Math.round(Number(traffic.month_tx)*GIB) }
    if ([patch.traffic_limit, ...Object.values(correction)].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v < 0))) {
      return toast.error("流量必须是有效的非负数，且不能超出精确计数范围")
    }
    if (patch.traffic_reset_day !== undefined && !window.confirm("修改重置日将按已保存的每日明细汇总本期流量。历史不足时会标记为不完整，可手动校正；累计流量不变。继续保存？")) return
    setSaving(true)
    try {
      await api(`/nodes/${node.id}`, { method: "PUT", body: JSON.stringify({ ...patch, traffic_correction: correction }) })
      toast.success("节点设置已保存")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <Field label="名称">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="官网地址" hint="填写完整的 HTTP 或 HTTPS 地址；登录后在展示页的 VPS 名称后显示官网按钮，留空不显示。">
            <Input
              type="url"
              aria-label="官网地址"
              value={form.website ?? ""}
              maxLength={2048}
              onChange={(e) => set("website", e.target.value)}
              placeholder="https://example.com"
            />
          </Field>
          <Field
            label="标签"
            hint={<>多个标签使用分号（;）分隔；在标签末尾添加颜色，例如 1Gbps&lt;green&gt;。<a className="underline underline-offset-2 hover:text-foreground" href="https://www.radix-ui.com/themes/docs/theme/color" target="_blank" rel="noreferrer">查看可用颜色</a></>}
          >
            <Input
              value={form.tags ?? ""}
              maxLength={512}
              onChange={(e) => set("tags", e.target.value)}
              placeholder="二网精品; 1Gbps<green>"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="每月流量额度 (GB)" hint="留空或 0 不限">
              <Input type="number" value={limitGib} onChange={(e) => setLimitGib(e.target.value)} placeholder="1024" />
            </Field>
            <Field label="流量计算方式">
              <Select value={form.traffic_mode} onValueChange={(v) => set("traffic_mode", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TRAFFIC_MODES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="每月重置日" hint="1–31。更改后按每日记录汇总；历史不足会标注，累计流量不变">
              <Input type="number" min={1} max={31} value={form.traffic_reset_day} onChange={(e) => set("traffic_reset_day", Number(e.target.value))} />
            </Field>
            <Field label="备注" hint="仅管理员可见">
              <Input value={form.remark ?? ""} onChange={(e) => set("remark", e.target.value)} placeholder="商家、用途" />
            </Field>
          </div>
          {node.traffic_incomplete && <p role="status" className="text-sm text-muted-foreground">本期流量历史不完整，当前仅包含已记录的用量。请同时校正本期上下行以确认完整计数。</p>}
          <details className="rounded-lg border bg-muted/30 px-3 py-2.5">
            <summary className="cursor-pointer text-sm font-medium">流量校正</summary>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              按 GB 填入需要校正的值，未修改的计数器继续正常累计。
            </p>
            <label className="mt-3 flex items-center gap-3 text-sm"><Switch checked={calibrate} onCheckedChange={setCalibrate} />确认本期上下行是完整用量</label>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {TRAFFIC_FIELDS.map(([key, label]) => (
                <Field key={key} label={`${label} (GB)`}>
                  <Input
                    type="number"
                    step="0.001"
                    value={traffic[key]}
                    onChange={(e) => setTraffic((t) => ({ ...t, [key]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </details>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span>
              <span className="block font-medium">公开显示</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">关闭后只在管理后台可见</span>
            </span>
            <Switch checked={form.public} onCheckedChange={(v) => set("public", v)} />
          </label>
          <Field label="维护期间暂停通知" hint="到时自动恢复；只暂停这台节点的异常与流量通知。">
            <Select value={(form.muted_until || 0) > Date.now()/1000 ? String(form.muted_until) : "0"} onValueChange={(value) => set("muted_until", Number(value))}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">正常接收</SelectItem>
                {(form.muted_until || 0)>Date.now()/1000 && <SelectItem value={String(form.muted_until)}>暂停至 {new Date(form.muted_until!*1000).toLocaleString("zh-CN")}</SelectItem>}
                {[1,4,24].map(hours => <SelectItem key={hours} value={String(Math.floor(Date.now()/1000)+hours*3600)}>暂停 {hours} 小时</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span>
              <span className="block font-medium">异常通知</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">接收离线、磁盘和 TCP 探测异常及恢复通知</span>
            </span>
            <Switch checked={!!form.notify} onCheckedChange={(v) => set("notify", v)} />
          </label>
        </div>
        <DialogFooter className="sticky -bottom-6 border-t bg-background py-3">
          <Button variant="ghost" onClick={close}>取消</Button>
          <Button onClick={save} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BillingForm({ node, onClose, onSaved }: {
  node: Node
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(node)
  // Text rather than a number: a numeric state cannot represent an empty field,
  // so clearing it would snap back to 0 mid-entry. Empty means free.
  const [price, setPrice] = useState(node.price > 0 ? String(node.price) : "")
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Node>(k: K, v: Node[K]) => setForm((f) => ({ ...f, [k]: v }))

  const dirty = JSON.stringify(form) !== JSON.stringify(node) || price !== (node.price > 0 ? String(node.price) : "")
  const canClose = useDirtyGuard(dirty, saving)
  const close = () => { if (canClose()) onClose() }
  const [history, setHistory] = useState<{ old_date: string; new_date: string; created_at: number }[]>([])
  useEffect(() => { api<{ history: typeof history }>(`/nodes/${node.id}/renewals`).then(d => setHistory(d.history)).catch((e: Error) => toast.error(`续费记录加载失败：${e.message}`)) }, [node.id])
  async function renew() {
    if (dirty) return toast.info("请先保存付款周期和到期时间，再确认续费")
    if (!window.confirm("确认已经完成付款？系统将按当前付款周期顺延一次，并保存记录。")) return
    setSaving(true)
    try {
      await api(`/nodes/${node.id}/renew`, { method: "POST", body: JSON.stringify({ expected_expiry: node.expires_at }) })
      toast.success("已确认续费并记录")
      onSaved(); onClose()
    } catch (e) { toast.error((e as Error).message) } finally { setSaving(false) }
  }
  async function save() {
    if (!Number.isFinite(Number(price)) || Number(price)<0) return toast.error("价格必须是有效的非负数")
    setSaving(true)
    try {
      await api(`/nodes/${node.id}`, {
        method: "PUT",
        body: JSON.stringify(changes(node, {
          price: Math.max(0, Number(price) || 0),
          currency: form.currency,
          billing_cycle: form.billing_cycle,
          expires_at: form.expires_at || null,
          permanent: !!form.permanent,
        })),
      })
      toast.success("续费设置已保存")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="价格" hint="留空或 0 为免费">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="免费"
              />
            </Field>
            <Field label="货币">
              <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["USD", "CNY", "EUR", "GBP", "JPY"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="付款周期">
              <Select value={form.billing_cycle} onValueChange={(v) => set("billing_cycle", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CYCLES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="到期类型">
              <Select value={form.permanent ? "permanent" : "dated"} onValueChange={(value) => { set("permanent", value === "permanent"); if (value === "permanent") set("expires_at", null) }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="dated">按日期 / 未设置</SelectItem><SelectItem value="permanent">永久有效</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="到期时间" hint="留空表示未设置。在线不会自动顺延到期日。">
              <Input type="date" disabled={!!form.permanent} value={form.expires_at ?? ""} onChange={(e) => set("expires_at", e.target.value)} />
            </Field>
          </div>
        </div>
        {history.length > 0 && <details className="text-sm"><summary className="cursor-pointer">最近续费记录</summary><ul className="mt-2 space-y-1 text-xs text-muted-foreground">{history.map((item, index) => <li key={index}>{new Date(item.created_at * 1000).toLocaleString("zh-CN")} · {item.old_date} → {item.new_date}</li>)}</ul></details>}
        <DialogFooter className="sticky -bottom-6 border-t bg-background py-3">
          <Button variant="secondary" onClick={renew} disabled={saving || dirty || !node.expires_at || ["once", "free"].includes(node.billing_cycle)}>确认已续费</Button>
          <Button variant="ghost" onClick={close}>取消</Button>
          <Button onClick={save} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Built here rather than fetched: the node list already carries the token, so
// viewing an install command is a read rather than an action. Reissuing one to
// display it would take the running agent offline.
function installCommand(site: string, token: string, seconds: number, skipUpdater: boolean) {
  site = provisioningSite(site)
  if (!site) return ""
  const args = [`--server ${site}`, `--token ${token}`, `--interval ${seconds}`]
  if (skipUpdater) args.push("--no-updater")
  return `curl --proto '=https' -fsS ${site}/install.sh | sh -s -- ${args.join(" ")}`
}

// One command for a batch of machines. The key belongs to the hub, is valid only
// within the window it opened, and each machine exchanges it for a token of its
// own, so unlike an install command this text is no one's credential and can be
// used directly in a loop.
function registerCommand(site: string, key: string, skipUpdater: boolean) {
  site = provisioningSite(site)
  if (!site) return ""
  const args = [`--server ${site}`, `--register ${key}`]
  if (skipUpdater) args.push("--no-updater")
  return `curl --proto '=https' -fsS ${site}/install.sh | sh -s -- ${args.join(" ")}`
}

function UpdaterOption({ skip, onChange }: { skip: boolean; onChange: (value: boolean) => void }) {
  return <div className="space-y-2 text-sm">
    <p className="text-muted-foreground">使用注册窗口安装的 HTTPS 节点会自动配对升级器。单节点使用上报 Token 安装后，须另行配对维护凭据。之后可在后台发起 Agent 升级。</p>
    <label className="flex items-center gap-2"><input type="checkbox" checked={skip} onChange={event => onChange(event.target.checked)} />本次跳过升级器安装</label>
  </div>
}

// The window lives on the hub; this reads it back and counts down, which is also
// what makes an expired one disappear from the panel without interaction.
function useRegisterWindow() {
  const [key, setKey] = useState("")
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    api<Settings>("/settings")
      .then((s) => { setKey(String(s.register_key ?? "")); setUntil(Number(s.register_until ?? 0)) })
      .catch(() => {})
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])

  return {
    key,
    left: key === "" ? 0 : Math.max(0, until - now),
    async open() {
      try {
        const w = await api<{ register_key: string; register_until: string }>("/register-window", { method: "POST" })
        setKey(w.register_key)
        setUntil(Number(w.register_until))
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
    async close() {
      try {
        await api("/register-window", { method: "DELETE" })
        setKey("")
        setUntil(0)
        toast.success("注册窗口已关闭")
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
  }
}

function RegisterDialog({ site, reg, onClose }: {
  site: string
  reg: ReturnType<typeof useRegisterWindow>
  onClose: () => void
}) {
  const [skipUpdater, setSkipUpdater] = useState(false)
  const command = reg.left > 0 ? registerCommand(site, reg.key, skipUpdater) : ""
  const clock = `${Math.floor(reg.left / 60)}:${String(reg.left % 60).padStart(2, "0")}`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>批量添加</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            开启窗口后，在每台能访问 Hub HTTPS 域名的机器上以 root 执行同一条命令。每台机器以自己的主机名注册并取得独立凭证。仅能通过 HTTP 上报的机器请单独添加节点并离线安装。
          </p>
          {command ? (
            <div className="space-y-2">
              <UpdaterOption skip={skipUpdater} onChange={setSkipUpdater} />
              <Label className="text-sm font-medium">安装命令</Label>
              <pre className="h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed select-all">
                {command}
              </pre>
              <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                <span>
                  <span className="block font-medium">窗口 {clock} 后自动关闭</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    到点自动失效，装完了也可以现在就关
                  </span>
                </span>
                <Button variant="outline" size="sm" onClick={reg.close}>立即关闭</Button>
              </div>
            </div>
          ) : (
            <Button onClick={reg.open}>开启一小时窗口</Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button onClick={() => copy(command)} disabled={!command}>
            <Copy className="size-4" /> 复制
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InstallDialog({ node, site, onClose, onRotated }: {
  node: Node
  site: string
  onClose: () => void
  onRotated: () => void
}) {
  const [token, setToken] = useState(node.token ?? "")
  const [interval, setInterval] = useState("1")
  const [rotating, setRotating] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [skipUpdater, setSkipUpdater] = useState(false)
  const [offline, setOffline] = useState(node.offline_only || node.terminal_reason === "plaintext")

  const seconds = Math.min(3600, Math.max(1, Math.round(Number(interval) || 1)))
  const command = token ? installCommand(site, token, seconds, skipUpdater) : ""

  async function rotate() {
    setRotating(true)
    try {
      const fresh = await api<{ token: string }>(`/nodes/${node.id}/token`, { method: "POST" })
      setToken(fresh.token)
      setConfirmRotate(false)
      toast.success("凭证已换发，请更新节点上的 Token")
      onRotated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRotating(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <Field label="安装方式">
            <Select value={offline ? "offline" : "https"} onValueChange={value => setOffline(value === "offline")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="https">HTTPS 在线安装</SelectItem><SelectItem value="offline">HTTP 上报 · 离线维护</SelectItem></SelectContent>
            </Select>
          </Field>
          {offline ? <div className="space-y-3 text-sm">
            {node.offline_only ? <p>通过独立 SSH 登录该节点，使用预置的校验工具。点击下方按钮取得当前版本的完整升级命令。</p> : <>
            <p>从可信设备取得该版本的归档摘要，并通过 SSH 放入校验工具。将 SHA256 和 PACKAGE 分别设为可信摘要和 HTTP 包地址，在原节点以 root 执行以下命令。</p>
            <pre className="overflow-auto rounded-lg border bg-muted/40 p-3 text-xs select-all">sh /root/agent-offline-install.sh "$SHA256" "$PACKAGE"</pre></>}
            <p>首次安装须使用本节点 Token 配置 HTTP 地址和服务。<a href="https://github.com/ClaraCora/Cmonitor/blob/main/OFFLINE_DEPLOY.md" target="_blank" rel="noreferrer" className="text-primary underline">查看离线安装步骤</a></p>
            {token && <Button variant="outline" size="sm" onClick={() => copy(token)}>复制节点 Token</Button>}
          </div> : <>
            <Field label="上报间隔（秒）" hint="1–3600，默认 1 秒">
              <Input type="number" min={1} max={3600} value={interval} onChange={(e) => setInterval(e.target.value)} />
            </Field>
            <UpdaterOption skip={skipUpdater} onChange={setSkipUpdater} />
            <div className="space-y-2">
              <Label className="text-sm font-medium">安装命令</Label>
              <pre className="h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed select-all">
                {/* A node added before the hub kept tokens has nothing to show
                    until one is reissued. */}
                {command || "旧版本创建的凭证不可读取，换发后显示"}
              </pre>
            </div>
          </>}
          <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span>
              <span className="block font-medium">换发凭证</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                旧凭证和维护授权会失效。更新 Token 后，HTTPS 节点需重新配对升级器。
              </span>
            </span>
            <Button variant="outline" size="sm" disabled={rotating} onClick={() => setConfirmRotate(true)}>
              换发
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          {offline && node.offline_only ? <OfflineUpgradeButton node={node} /> : <Button onClick={() => copy(offline ? 'sh /root/agent-offline-install.sh "$SHA256" "$PACKAGE"' : command)} disabled={!offline && !command}>
            <Copy className="size-4" /> {offline ? "复制命令模板" : "复制"}
          </Button>}
        </DialogFooter>
      </DialogContent>
      {confirmRotate && (
        <ConfirmDialog
          title={`给「${node.name}」换发凭证？`}
          description="旧凭证立即作废，节点需要更新 Token 后才能恢复上报。"
          confirmLabel="换发凭证"
          busy={rotating}
          onClose={() => setConfirmRotate(false)}
          onConfirm={rotate}
        />
      )}
    </Dialog>
  )
}

const TerminalDialog = lazy(() => import("./TerminalDialog").then(m => ({ default: m.TerminalDialog })))

function Nodes({ nodes, refresh, site, canProvision }: { nodes: Node[]; refresh: () => void; site: string; canProvision: boolean }) {
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Node | null>(null)
  const [billing, setBilling] = useState<Node | null>(null)
  const [installing, setInstalling] = useState<Node | null>(null)
  const [terminal, setTerminal] = useState<Node | null>(null)
  const [registering, setRegistering] = useState(false)
  const reg = useRegisterWindow()
  const [deleting, setDeleting] = useState<Node | null>(null)
  const [removing, setRemoving] = useState(false)
  async function toggleTerminal(n: Node) {
    try {
      await api(`/nodes/${n.id}/terminal`, { method: "PUT", body: JSON.stringify({ enabled: n.terminal_enabled === false }) })
      refresh(); toast.success(n.terminal_enabled === false ? "已允许节点终端" : "已禁用节点终端，现有连接已关闭")
    } catch (e) { toast.error((e as Error).message) }
  }

  async function togglePublic(n: Node) {
    try {
      await api(`/nodes/${n.id}`, { method: "PUT", body: JSON.stringify({ public: !n.public }) })
      toast.success(n.public ? `「${n.name}」已在状态页隐藏` : `「${n.name}」已在状态页显示`)
      refresh()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/nodes/${deleting.id}`, { method: "DELETE" })
      toast.success("已删除")
      setDeleting(null)
      refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="nodes-page @container/nodes min-w-0 space-y-3">
      <header className="node-glass node-toolbar">
        <h1>节点管理</h1>
        <div className="node-search relative min-w-0">
          <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="ps-9" placeholder="搜索名称或地址" aria-label="搜索节点"
            value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="node-toolbar-actions">
          <AgentRollout nodes={nodes} site={site} />
          <Button variant="outline" disabled={!canProvision} onClick={() => setRegistering(true)}>
            <Server /> 批量添加{reg.left > 0 && ` · ${Math.ceil(reg.left / 60)} 分`}
          </Button>
          <Button disabled={!canProvision} onClick={() => setCreating(true)}>
            <Plus /> 添加节点
          </Button>
        </div>
      </header>
      {!canProvision && <p className="rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">添加或安装节点需要通过 HTTPS 域名访问面板。</p>}
      <NodeInventory nodes={nodes} refresh={refresh} canProvision={canProvision} copy={copy} query={query} clearQuery={() => setQuery("")}
        onCreate={() => setCreating(true)}
        actions={{
          edit: setEditing, bill: setBilling, install: setInstalling, terminal: setTerminal,
          toggleTerminal, togglePublic, remove: setDeleting,
        }}
      />

      {creating && (
        <CreateNode
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      )}
      {editing && (
        <NodeForm
          node={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {billing && (
        <BillingForm node={billing} onClose={() => setBilling(null)} onSaved={refresh} />
      )}
      {registering && <RegisterDialog site={site} reg={reg} onClose={() => { setRegistering(false); refresh() }} />}

      {installing && (
        <InstallDialog
          node={installing}
          site={site}
          onClose={() => setInstalling(null)}
          onRotated={refresh}
        />
      )}
      {terminal && <Suspense fallback={<p role="status">正在加载终端…</p>}><TerminalDialog node={terminal} onClose={() => setTerminal(null)} /></Suspense>}
      {deleting && (
        <ConfirmDialog
          title={`删除节点「${deleting.name}」？`}
          description="历史指标、流量记录和凭证一并删除，不可恢复。"
          confirmLabel="删除节点"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  )
}

const VisitorOverview = lazy(() => import("./VisitorOverview"))

function Visitors() {
  const [rows, setRows] = useState<VisitorRow[] | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const currentRequest = useRef(0)
  const load = async () => {
    const request = ++currentRequest.current
    setLoading(true)
    setError("")
    try {
      const data = await api<{ visits: VisitorRow[] }>("/visitor-log")
      if (request === currentRequest.current) setRows(data.visits)
    } catch (e) {
      if (request === currentRequest.current) setError((e as Error).message || "网络错误")
    } finally {
      if (request === currentRequest.current) setLoading(false)
    }
  }
  useEffect(() => { queueMicrotask(load) }, [])

  const clear = async () => {
    setClearing(true)
    try {
      await api("/visitor-log", { method: "DELETE" })
      currentRequest.current++
      setRows([])
      setLoading(false)
      setError("")
      setConfirmClear(false)
      toast.success("已清空访客记录")
    } catch (e) {
      toast.error((e as Error).toString())
    } finally {
      setClearing(false)
    }
  }

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">访客记录</h1>
          <p className="mt-1 text-sm text-muted-foreground">状态页最近 100 次访问</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={loading || clearing} onClick={load} title="刷新" aria-label="刷新">
            <RefreshCw aria-hidden="true" />刷新
          </Button>
          <Button variant="ghost" size="icon" disabled={!rows?.length || clearing} onClick={() => setConfirmClear(true)} title="清空访客记录" aria-label="清空访客记录">
            <Trash2 aria-hidden="true" className="text-destructive" />
          </Button>
        </div>
      </div>
      {rows === null && <LoadState error={error} retry={load} />}
      {rows !== null && loading && <p role="status" className="text-sm text-muted-foreground">正在刷新访客记录…</p>}
      {rows !== null && error && <p role="alert" className="rounded-lg border p-3 text-sm [overflow-wrap:anywhere]">
        刷新失败，当前显示上次加载的记录。{error}
      </p>}
      {rows && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在加载访客分布…</p>}>
        <VisitorOverview rows={rows} />
      </Suspense>}
      {confirmClear && <ConfirmDialog title="清空访客记录？" description="全部访客记录将被删除，不可恢复。" confirmLabel="清空" busy={clearing} onClose={() => setConfirmClear(false)} onConfirm={clear} />}
    </section>
  )
}

function Ping({ nodes }: { nodes: Node[] }) {
  const [tasks, setTasks] = useState<PingTask[]>([])
  const [editing, setEditing] = useState<Partial<PingTask> | null>(null)
  const [initialEditing, setInitialEditing] = useState<Partial<PingTask> | null>(null)
  const [nodeQuery, setNodeQuery] = useState("")
  const [saveError, setSaveError] = useState("")
  const nameInput = useRef<HTMLInputElement>(null)
  const targetInput = useRef<HTMLInputElement>(null)
  const openEditor = (value: Partial<PingTask>) => {
    setNodeQuery("")
    setSaveError("")
    setInitialEditing(value)
    setEditing(value)
  }
  const [deleting, setDeleting] = useState<PingTask | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)

  const [error, setError] = useState("")
  const [loaded, setLoaded] = useState(false)
  const latest = useRef(0)
  const load = async () => {
    const request = ++latest.current
    setError("")
    try {
      const { tasks } = await api<{ tasks: PingTask[] }>("/ping-tasks")
      if (request === latest.current) { setTasks(tasks); setLoaded(true) }
    } catch (e) {
      if (request === latest.current) setError((e as Error).message || "网络错误")
    }
  }
  useEffect(() => { queueMicrotask(load) }, [])

  const canClose = useDirtyGuard(editing !== null && JSON.stringify(editing) !== JSON.stringify(initialEditing), saving)
  const closeEditor = () => { if (canClose()) setEditing(null) }
  async function save() {
    if (!editing) return
    if (!editing.name?.trim()) {
      setSaveError("请输入监控名称。")
      nameInput.current?.focus()
      return
    }
    const target = editing.target?.trim() ?? ""
    const match = /^(?:\[[^\]\s]+\]|[^:[\]\s/]+):(\d+)$/.exec(target)
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
      setSaveError("请输入主机和 1–65535 之间的端口，例如 example.com:443。IPv6 地址请用方括号包裹。")
      targetInput.current?.focus()
      return
    }
    setSaveError("")
    setSaving(true)
    try {
      await api("/ping-tasks", { method: "POST", body: JSON.stringify(editing) })
      toast.success(editing.nodes?.length ? "已保存监控分配" : "监控已保存，尚未分配运行节点")
      setEditing(null)
      load()
    } catch (e) {
      setSaveError((e as Error).message || "保存失败，请重试")
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/ping-tasks/${deleting.id}`, { method: "DELETE" })
      toast.success("监控已删除")
      setDeleting(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  const toggle = (id: number) =>
    setEditing((t) => {
      if (!t) return t
      const nodes = t.nodes ?? []
      return { ...t, nodes: nodes.includes(id) ? nodes.filter((n) => n !== id) : [...nodes, id] }
    })

  const coveredNodes = new Set(tasks.flatMap((task) => task.nodes)).size
  const selectedCount = editing?.nodes?.length ?? 0
  const query = nodeQuery.trim().toLowerCase()
  const visibleNodes = query ? nodes.filter((node) => node.name.toLowerCase().includes(query)) : nodes
  const visibleIds = new Set(visibleNodes.map(node => node.id))
  const selectedVisible = (editing?.nodes ?? []).filter(id => visibleIds.has(id)).length
  function setVisibleSelection(selected: boolean) {
    setEditing((task) => {
      if (!task) return task
      const assigned = (task.nodes ?? []).filter(id => !visibleIds.has(id))
      return { ...task, nodes: selected ? [...assigned, ...visibleIds] : assigned }
    })
  }
  const desktopColumns = "lg:grid-cols-[minmax(0,1fr)_minmax(5rem,0.25fr)_minmax(6rem,0.3fr)_auto]"

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">延迟监控</h1>
          {loaded && !error && (
            <p className="tnum mt-1 text-sm text-muted-foreground">{tasks.length} 个监控目标 · 已分配至 {coveredNodes} 个节点</p>
          )}
        </div>
        <Button onClick={() => openEditor({ name: "", target: "", interval: 60, nodes: [] })}>
          <Plus /> 添加监控
        </Button>
      </header>
      {(error || !loaded) && <LoadState error={error} retry={load} />}
      {tasks.length > 0 && (
        <Card className="gap-0 overflow-hidden p-0">
          <div aria-hidden="true" className={`hidden items-center gap-4 border-b bg-muted/50 px-5 py-2.5 text-xs font-medium text-muted-foreground lg:grid ${desktopColumns}`}>
            <span>监控目标</span><span>探测间隔</span><span>运行节点</span><span className="w-28 text-right">操作</span>
          </div>
          <ul aria-label="监控目标" className="divide-y">
            {tasks.map((task) => (
              <li key={task.id} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5 lg:gap-x-4 ${desktopColumns}`}>
                <div className="col-span-2 min-w-0 space-y-1 lg:col-auto">
                  <h2 className="text-sm font-semibold [overflow-wrap:anywhere]">{task.name}</h2>
                  <p className="font-mono text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{task.target}</p>
                </div>
                <div className="tnum flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground lg:contents lg:text-sm">
                  <span><span className="lg:sr-only">每 </span>{task.interval} 秒</span>
                  <span className={task.nodes.length ? "lg:text-foreground" : "font-medium"}>
                    {task.nodes.length ? <>{task.nodes.length} 个节点</> : "未分配节点"}
                  </span>
                </div>
                <div className="flex items-center justify-end gap-1 lg:w-28">
                  <Button variant="ghost" size="sm" className="h-10" onClick={() => openEditor(task)} aria-label={`编辑监控：${task.name}`}>
                    <Pencil /> 编辑
                  </Button>
                  <Button variant="ghost" size="icon" className="size-10 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleting(task)} title="删除监控" aria-label={`删除监控：${task.name}`}>
                    <Trash2 />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {loaded && !error && tasks.length === 0 && (
        <Card className="items-center gap-2 px-5 py-10 text-center">
          <Radio aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">还没有延迟监控。</p>
          <p className="text-sm text-muted-foreground">添加目标并分配节点后，节点会定时上报 TCP 连接耗时。</p>
        </Card>
      )}

      {editing && (
        <Dialog open onOpenChange={(open) => !open && closeEditor()}>
          <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
            <DialogHeader className="shrink-0 px-5 pt-5 pr-12 pb-4 text-left">
              <DialogTitle>{editing.id ? "编辑监控" : "添加监控"}</DialogTitle>
              <DialogDescription>设置 TCP 探测目标，并指定哪些节点负责上报。</DialogDescription>
            </DialogHeader>
            <form onSubmit={(event) => { event.preventDefault(); if (!saving) void save() }} className="flex min-h-0 flex-col">
              <div className="min-h-0 overflow-y-auto px-5 pb-4">
                <fieldset disabled={saving} className="min-w-0 space-y-4">
                <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
                  <Field label="名称">
                    <Input ref={nameInput} required autoFocus={!editing.id} value={editing.name ?? ""} onChange={(e) => { setSaveError(""); setEditing({ ...editing, name: e.target.value }) }} placeholder="Cloudflare" />
                  </Field>
                  <Field label="间隔（秒）" hint="5–3600 秒">
                    <Input required type="number" min="5" max="3600" value={editing.interval ?? ""} onChange={(e) => setEditing({ ...editing, interval: e.target.value === "" ? undefined : Number(e.target.value) })} />
                  </Field>
                </div>
                <Field label="目标地址" hint="填写主机和端口。IPv6 示例：[2001:db8::1]:443">
                  <Input ref={targetInput} required autoCapitalize="none" spellCheck={false} value={editing.target ?? ""} onChange={(e) => { setSaveError(""); setEditing({ ...editing, target: e.target.value }) }} placeholder="1.1.1.1:443" />
                </Field>
                <fieldset className="min-w-0 border-t pt-3">
                  <legend className="float-left w-full text-sm font-medium">运行节点</legend>
                  {nodes.length > 8 && <div className="clear-both pt-2">
                    <Input type="search" value={nodeQuery} aria-label="查找运行节点" placeholder="按节点名称查找"
                      onChange={event => setNodeQuery(event.target.value)}
                      onKeyDown={event => { if (event.key === "Enter") event.preventDefault() }} />
                  </div>}
                  <div className="clear-both mb-2 flex min-h-9 items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="tnum" aria-live="polite">已选 {selectedCount} / {nodes.length}{query && ` · 匹配 ${visibleNodes.length}`}</span>
                    {nodes.length > 0 && (
                      <div className="flex gap-1">
                        <Button type="button" variant="ghost" size="sm" disabled={selectedVisible === visibleNodes.length} onClick={() => setVisibleSelection(true)}>{query ? "选中匹配" : "全选"}</Button>
                        <Button type="button" variant="ghost" size="sm" disabled={!selectedVisible} onClick={() => setVisibleSelection(false)}>{query ? "取消匹配" : "清空"}</Button>
                      </div>
                    )}
                  </div>
                  <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border bg-muted/20 p-1.5 sm:grid-cols-2">
                    {visibleNodes.map((n) => (
                      <label key={n.id} className="flex min-h-10 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-accent has-checked:bg-primary/10 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
                        <input type="checkbox" checked={editing.nodes?.includes(n.id) ?? false} onChange={() => toggle(n.id)} className="size-4 shrink-0 accent-primary" />
                        <span className="[overflow-wrap:anywhere]">{n.name}</span>
                      </label>
                    ))}
                    {nodes.length === 0 && <p className="p-2 text-sm text-muted-foreground sm:col-span-2">暂无节点。添加节点后即可分配此监控。</p>}
                    {nodes.length > 0 && visibleNodes.length === 0 && <p className="p-2 text-sm text-muted-foreground sm:col-span-2">没有匹配的节点，请更换名称。</p>}
                  </div>
                  {nodes.length > 0 && !selectedCount && <p className="mt-2 text-xs text-muted-foreground">未分配节点时，只保存监控，不会开始探测。</p>}
                </fieldset>
                </fieldset>
              </div>
              <div className="shrink-0 border-t px-5 py-3">
                {saveError && <p role="alert" className="mb-2 max-h-20 overflow-auto text-sm text-destructive [overflow-wrap:anywhere]">{saveError}</p>}
                <DialogFooter className="flex-row justify-end">
                  <Button type="button" variant="ghost" onClick={closeEditor} disabled={saving}>取消</Button>
                  <Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
                </DialogFooter>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`删除监控「${deleting.name}」？`}
          description="该监控及其历史延迟记录一并删除，不可恢复。"
          confirmLabel="删除监控"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  )
}

type Theme = {
  name: string
  short: string
  description: string
  version: string
  author: string
  url: string
  selected: boolean
  // 内置主题在二进制里，没有目录可删。装上一份同名的会顶替它，那一份就是普通
  // 主题，删掉之后内置的重新顶上。
  builtin: boolean
}

function Themes() {
  const [themes, setThemes] = useState<Theme[] | null>(null)
  const [busy, setBusy] = useState("")
  const [doomed, setDoomed] = useState<Theme | null>(null)
  const [zoomed, setZoomed] = useState<Theme | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const [error, setError] = useState("")
  const load = () => { setError(""); return api<{ themes: Theme[] }>("/themes").then((data) => setThemes(data.themes)).catch((e: Error) => setError(e.message || "网络错误")) }
  useEffect(() => { queueMicrotask(load) }, [])

  async function select(short: string) {
    setBusy(`select:${short}`)
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ theme: short }) })
      setThemes((old) => old?.map((theme) => ({ ...theme, selected: theme.short === short })) ?? old)
      dispatchEvent(new Event("cmonitor:site-updated"))
      toast.success("主题已切换")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  async function install(file: File) {
    setBusy("upload")
    try {
      const { theme } = await upload<{ theme: Theme }>("/themes", file)
      // The hub reads a theme from disk on every request, so it is already live;
      // reloading the list only brings this page up to date.
      toast.success(`已安装 ${theme.name} ${theme.version}`)
      dispatchEvent(new Event("cmonitor:site-updated"))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  // Only a theme whose manifest names a GitHub repository has a source to update
  // from; the hub refuses anything else, and this merely hides the button.
  const updatable = (theme: Theme) => theme.url.startsWith("https://github.com/")

  async function update(theme: Theme) {
    setBusy(`update:${theme.short}`)
    try {
      const { updated, version } = await api<{ updated: boolean; version: string }>(
        `/themes/${theme.short}/update`,
        { method: "POST" },
      )
      toast.success(updated ? `${theme.name} 已更新到 ${version}` : `${theme.name} 已是最新版本 ${version}`)
      if (updated) {
        dispatchEvent(new Event("cmonitor:site-updated"))
        await load()
      }
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  async function remove(theme: Theme) {
    setBusy("delete")
    try {
      await api(`/themes/${theme.short}`, { method: "DELETE" })
      toast.success(`已删除 ${theme.name}`)
      dispatchEvent(new Event("cmonitor:site-updated"))
      setDoomed(null)
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  if (!themes) return <LoadState error={error} retry={load} />
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">主题</h1>
      {error && <LoadState error={error} retry={load} />}
      <Card className="gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:p-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">安装主题</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            上传可信来源的 <code>theme.tar.gz</code>。同名主题会被替换，主题代码将在访客浏览器中执行。
          </p>
        </div>
        <div className="shrink-0">
          <Button size="sm" disabled={!!busy} onClick={() => picker.current?.click()}>
            <Upload /> {busy === "upload" ? "安装中…" : "上传主题包"}
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".gz,.tgz,application/gzip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (file) install(file)
            }}
          />
        </div>
      </Card>

      {/* items-start：有预览图和没有的卡片不该为了等高而留白 */}
      <div className="grid items-start gap-3 sm:grid-cols-2">
        {themes.map((theme) => (
          <Card key={theme.short} className={`min-w-0 gap-3 p-4 sm:p-5 ${theme.selected ? "border-primary/35" : ""}`}>
            {/* 主题包里可选的 preview.png，所以后端不用告诉前端有没有这张图：
                没有就是 404，图一直不显示。hidden 挂在 <a> 上而不是 <img> 上——
                隐藏的是整个链接，否则卡片里留着一个高度为 0 却照样吃 gap-4 的空
                链接。必须从 hidden 开始：带边框的 aspect-video 空盒子会在响应回
                来之前就画出来，闪一下再消失。
                缩略图被压到卡片那点宽度，比例不是 16:9 的还会被 object-cover
                裁掉边，所以图本身要能点开看原尺寸——就地开一个对话框，不跳走。 */}
            <button
              type="button"
              title="查看完整预览图"
              hidden
              className="cursor-zoom-in"
              onClick={() => setZoomed(theme)}
            >
              <img
                src={`/api/themes/${theme.short}/preview`}
                alt={`${theme.name} 预览图`}
                onLoad={(e) => { e.currentTarget.parentElement!.hidden = false }}
                className="aspect-video w-full rounded-md border object-cover object-top"
              />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 break-words font-semibold">{theme.name}</h2>
                {theme.selected && <Badge>当前</Badge>}
                {theme.builtin && <Badge variant="secondary" className="font-normal">内置</Badge>}
              </div>
              {theme.description && <p className="mt-2 break-words text-sm leading-relaxed">{theme.description}</p>}
              <p className="mt-1.5 break-words text-xs text-muted-foreground">
                {[theme.author, theme.version].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              <Button size="sm" variant={theme.selected ? "secondary" : "default"} disabled={theme.selected || !!busy || !!error} onClick={() => select(theme.short)}>
                {busy === `select:${theme.short}` ? "切换中…" : theme.selected ? "使用中" : "使用"}
              </Button>
              {updatable(theme) && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="从 GitHub 的最新 Release 检查更新"
                  aria-label={`从 GitHub 更新 ${theme.name}`}
                  disabled={!!busy || !!error}
                  onClick={() => update(theme)}
                >
                  <RefreshCw className={busy === `update:${theme.short}` ? "animate-spin" : ""} />
                  {busy === `update:${theme.short}` ? "检查中…" : "检查更新"}
                </Button>
              )}
              {/* The built-in theme is served from the binary and has no
                  directory to delete -- it is also the fallback everything
                  else lands on. */}
              {!theme.builtin && (
                <Button size="icon" variant="ghost" title={`删除 ${theme.name}`} aria-label={`删除 ${theme.name}`} disabled={!!busy || !!error} onClick={() => setDoomed(theme)}>
                  <Trash2 />
                </Button>
              )}
              {theme.url && <a className="ml-auto py-2 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground" href={theme.url} target="_blank" rel="noreferrer">源码</a>}
            </div>
          </Card>
        ))}
      </div>

      {/* 原图，不是卡片上那张裁过的：宽度给到 4xl，高度让 80vh 兜住，
          object-contain 保证整张都在框里而不是被切一刀。 */}
      {zoomed && (
        <Dialog open onOpenChange={(open) => !open && setZoomed(null)}>
          <DialogContent className="sm:max-w-4xl">
            <DialogHeader>
              <DialogTitle>{zoomed.name} 预览图</DialogTitle>
              <DialogDescription>{zoomed.author} · {zoomed.version}</DialogDescription>
            </DialogHeader>
            <img
              src={`/api/themes/${zoomed.short}/preview`}
              alt={`${zoomed.name} 预览图`}
              className="max-h-[80vh] w-full rounded-md border object-contain"
            />
          </DialogContent>
        </Dialog>
      )}

      {doomed && (
        <ConfirmDialog
          title={`删除 ${doomed.name}？`}
          description={
            doomed.short === "default"
              ? "装上的这份会从磁盘上删掉，公开页回到 hub 内置的那份默认主题。"
              : doomed.selected
                ? "这是当前使用的主题，删除后公开页会回到内置的默认主题。"
                : "主题目录会从磁盘上删掉，重新上传主题包可以装回来。"
          }
          confirmLabel={busy === "delete" ? "删除中…" : "删除"}
          busy={!!busy}
          onClose={() => { if (!busy) setDoomed(null) }}
          onConfirm={() => remove(doomed)}
        />
      )}
    </div>
  )
}

type Settings = Record<string, string | boolean>

const SECRET_FLAGS: Record<string, string> = {
  notify_telegram_token: "notify_telegram_token_set",
  notify_webhook_url: "notify_webhook_url_set",
  notify_webhook_headers: "notify_webhook_headers_set",
  github_client_secret: "github_secret_set",
}

// When the write succeeds but the following read fails, keep only what that
// write confirms. Passwords and tokens never become saved form values.
function confirmedSettings(patch: Record<string, string>): Settings {
  const confirmed: Settings = {}
  for (const [key, value] of Object.entries(patch)) {
    const flag = SECRET_FLAGS[key]
    confirmed[key] = flag || key === "admin_password" ? "" : value
    if (flag) confirmed[flag] = !!value
  }
  if (["github_client_id", "github_client_secret", "github_allowed_users"].some(key => key in patch)) {
    confirmed.github_ready = false
    confirmed.github_verified = false
    confirmed.github_status_unknown = true
  }
  return confirmed
}

// Two pages write settings, and each loads only what it displays.
function useSettings() {
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const [s, setS] = useState<Settings | null>(null)
  const [error, setError] = useState("")
  const [baseline, setBaseline] = useState<Settings | null>(null)
  const load = () => { setError(""); api<Settings>("/settings").then(data => { setBaseline(data); setS(data) }).catch((e: Error) => setError(e.message || "网络错误")) }
  useEffect(() => { queueMicrotask(load) }, [])
  const dirtyKeys = new Set(Object.keys(s ?? {}).filter(key => (s?.[key] ?? "") !== (baseline?.[key] ?? "")))
  const dirty = dirtyKeys.size > 0
  useDirtyGuard(dirty, saving)
  return {
    s, saving, error, load, baseline, dirty, dirtyKeys,
    set: (k: string, v: string) => setS((old) => ({ ...(old ?? {}), [k]: v })),
    save: async (patch: Record<string, string>) => {
      if (inFlight.current) return false
      inFlight.current = true
      setSaving(true)
      try {
        const result = await api<{ reauth_required?: boolean }>("/settings", { method: "PUT", body: JSON.stringify(patch) })
        if (result.reauth_required) {
          dispatchEvent(new Event("cmonitor:reauth-required"))
          return true
        }
        // Only the saved keys and the `*_set` flags are taken from the hub: a
        // credential comes back as a flag, so the typed value must not linger,
        // while another card's unsaved edits on the same page must survive.
        let confirmed: Settings
        try {
          const fresh = await api<Settings>("/settings")
          confirmed = Object.fromEntries(Object.keys(patch).map(key => [key, fresh[key] ?? ""]))
          confirmed.github_status_unknown = false
          for (const [key, value] of Object.entries(fresh)) {
            if (key.endsWith("_set") || ["github_ready","github_verified","password_login"].includes(key)) confirmed[key] = value
          }
          toast.success("已保存")
        } catch {
          confirmed = confirmedSettings(patch)
          toast.info("设置已保存，最新状态读取失败，请刷新页面确认")
        }
        setBaseline(old => ({ ...old, ...confirmed }))
        setS((old) => {
          const next = { ...old }
          for (const [key,value] of Object.entries(confirmed)) {
            if (!(key in patch) || old?.[key] === s?.[key]) next[key] = value
          }
          return next
        })
        if ("site_name" in patch || "public_page" in patch) dispatchEvent(new Event("cmonitor:site-updated"))
        return true
      } catch (e) {
        toast.error((e as Error).message)
        return false
      } finally {
        inFlight.current = false
        setSaving(false)
      }
    },
  }
}

function SettingsTab() {
  const { s, set, save, saving, dirty, dirtyKeys, error, load } = useSettings()
  if (!s) return <LoadState error={error} retry={load} />

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">设置</h1>
      <Card className="gap-0 overflow-hidden p-0">
        <form onSubmit={event => {
          event.preventDefault()
          const patch = Object.fromEntries([...dirtyKeys].map(key => [key, String(s[key] ?? "").trim()]))
          if (dirty) void save(patch)
        }}>
        <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <section aria-labelledby="public-settings-title" className="min-w-0 space-y-5 p-4 sm:p-5">
            <h2 id="public-settings-title" className="text-sm font-semibold">公开状态页</h2>
            <Field label="站点名称">
              <Input value={String(s.site_name ?? "")} onChange={(e) => set("site_name", e.target.value)} placeholder="Monitor" />
            </Field>
            <Field label="预设筛选标签" hint="每行一个，也可用中英文分号分隔。最多 12 个，每个 32 字，重复项自动合并。按钮按填写顺序显示在国别之前，精确匹配标签文字。留空隐藏。">
              <textarea
                rows={3}
                className={TEXTAREA}
                value={String(s.preset_tag ?? "")}
                onChange={(e) => set("preset_tag", e.target.value)}
                placeholder={"例如：游走\n主力\n备用"}
              />
            </Field>
            <div className="divide-y border-y">
              <div className="flex items-center justify-between gap-4 py-3">
                <div>
                  <div id="public-page-label" className="text-sm">开放公开状态页</div>
                  <p id="public-page-hint" className="mt-0.5 text-xs text-muted-foreground">关闭后，所有页面均需登录才能访问。</p>
                </div>
                <Switch
                  aria-labelledby="public-page-label"
                  aria-describedby="public-page-hint"
                  checked={s.public_page !== "off"}
                  onCheckedChange={(v) => set("public_page", v ? "on" : "off")}
                />
              </div>
              <div className="flex items-center justify-between gap-4 py-3">
                <span id="visitor-card-label" className="text-sm">在状态页底部显示访客信息</span>
                <Switch
                  aria-labelledby="visitor-card-label"
                  checked={s.visitor_card !== "off"}
                  onCheckedChange={(v) => set("visitor_card", v ? "on" : "off")}
                />
              </div>
            </div>
          </section>
          <section aria-labelledby="hub-settings-title" className="min-w-0 space-y-5 p-4 sm:p-5">
            <h2 id="hub-settings-title" className="text-sm font-semibold">Hub 运行设置</h2>
            <Field label="历史数据保留天数" hint="可保留 1–3650 天。超期明细自动清理，累计流量不受影响。">
              <Input
                type="number"
                min={1} max={3650} step={1} required
                value={String(s.retention_days ?? "")}
                onChange={(e) => set("retention_days", e.target.value)}
                placeholder="7"
              />
            </Field>
            <Field
              label="GitHub 代理"
              hint="留空直连。仅在 hub 自己拉不到 GitHub Release 时填。这个地址返回的字节会被安装到每一台节点上，只填信得过的镜像"
            >
              <Input
                type="url" pattern="https://.+" title="请输入以 https:// 开头的地址，或留空以直连 GitHub"
                value={String(s.github_proxy ?? "")}
                onChange={(e) => set("github_proxy", e.target.value)}
                placeholder="https://ghfast.top"
              />
            </Field>
          </section>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t bg-muted/20 px-4 py-3 sm:px-5">
          {dirty && <span className="text-xs text-muted-foreground">有未保存的修改</span>}
          <Button size="sm" type="submit" disabled={saving || !dirty}>
            {saving ? "保存中…" : "保存站点设置"}
          </Button>
        </div>
        </form>
      </Card>
    </div>
  )
}

const TEXTAREA =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"

// One offline alert, filled in the way the hub fills a template: in a single pass,
// JSON-escaped for the webhook body. Previews only; nothing here is sent.
const SAMPLE_NOTE: Record<string, string> = {
  event: "offline",
  node: "香港 · 甲商家",
  title: "🔴 香港 · 甲商家 离线",
  message: "最后上报 09-15 20:13 +08:00",
  time: "09-15 20:16 +08:00",
}

const PLACEHOLDERS = "{{title}} {{message}} {{node}} {{event}} {{site}} {{time}}"

function TemplatePreview({ template, site, json = false }: { template: string; site: string; json?: boolean }) {
  if (!template.trim()) return <p className="text-xs text-muted-foreground">留空保存即恢复默认模板</p>
  const values = { ...SAMPLE_NOTE, site }
  let out = template.replace(/\{\{(event|node|title|message|site|time)\}\}/g, (_, key: keyof typeof values) =>
    json ? JSON.stringify(values[key]).slice(1, -1) : values[key],
  )
  if (json) {
    try {
      out = JSON.stringify(JSON.parse(out), null, 2)
    } catch {
      return (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          代入后不是合法 JSON，保存会被拒绝。占位符要写在引号里，例如 "text": "{"{{title}}"}"
        </p>
      )
    }
  }
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">预览（以一条离线通知为例）</div>
      <pre className="overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">{out}</pre>
    </div>
  )
}

// A channel's form, collapsed until needed. The summary carries whether the
// channel is configured, so the closed card still answers the common question.
function ChannelCard({ title, configured, dirty, children }: { title: string; configured: boolean; dirty: boolean; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <details className="group">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2 text-sm font-medium">
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
            {title}
          </span>
          <Badge variant={configured ? "secondary" : "outline"}>{dirty ? "待保存" : configured ? "已配置" : "未配置"}</Badge>
        </summary>
        <div className="mt-4 space-y-4">{children}</div>
      </details>
    </Card>
  )
}

// Offline alerts are opt-in per node, so turning them on for a fleet needs one
// place rather than one dialog per node.
function OfflineNodes({ nodes, refresh }: { nodes: Node[]; refresh: () => void }) {
  const [busy, setBusy] = useState(false)

  async function apply(targets: Node[], on: boolean) {
    const changed = targets.filter(node => !!node.notify !== on)
    if (!changed.length) return
    setBusy(true)
    try {
      // Awaited in turn, the requests would cost one round trip per node, and
      // the two-second stream would render each one as it lands.
      const results = await Promise.allSettled(changed.map(node =>
        api(`/nodes/${node.id}`, { method: "PUT", body: JSON.stringify({ notify: on }) })
      ))
      const failed = changed.filter((_, i) => results[i].status === "rejected")
      if (failed.length) {
        const names = failed.slice(0, 3).map(node => node.name).join("、")
        toast.error(`${failed.length} 台未能更新离线通知`, { description: names + (failed.length > 3 ? " 等" : "") + "。请重试。" })
      } else {
        toast.success(`已${on ? "打开" : "关闭"} ${changed.length} 台节点的离线通知`)
      }
    } finally {
      refresh()
      setBusy(false)
    }
  }

  const enabled = nodes.filter((n) => n.notify).length
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">离线通知</h2>
          <p className="mt-1 text-xs text-muted-foreground">{nodes.length ? `已打开 ${enabled} / ${nodes.length} 台，开关立即生效。` : "添加节点后，可在这里开启离线通知。"}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy || enabled === nodes.length} onClick={() => apply(nodes, true)}>全部打开</Button>
          <Button size="sm" variant="ghost" disabled={busy || enabled === 0} onClick={() => apply(nodes, false)}>全部关闭</Button>
        </div>
      </div>
      {nodes.length > 0 && (
        <div className="grid max-h-64 grid-cols-1 gap-x-6 gap-y-1 overflow-y-auto sm:grid-cols-2">
          {nodes.map((node) => (
            <label key={node.id} htmlFor={`notify-node-${node.id}`} className="flex min-h-10 min-w-0 cursor-pointer items-center justify-between gap-3 text-sm">
              <span className="truncate" title={node.name}>{node.name}</span>
              <Switch id={`notify-node-${node.id}`} checked={!!node.notify} disabled={busy} onCheckedChange={(v) => apply([node], v)} />
            </label>
          ))}
        </div>
      )}
    </Card>
  )
}

type Delivery = { id: string; title: string; created_at: number; channel: string; status: string; attempts: number; last_error: string }
function NotificationHistory() {
  const [items, setItems] = useState<Delivery[] | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState("")
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  function load() {
    setLoading(true)
    setRevision(previous => previous + 1)
  }
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let timer: ReturnType<typeof setTimeout> | undefined
    api<{ items: Delivery[] }>("/notify/history", { signal })
      .then(data => { if (!signal.aborted) { setItems(data.items); setError("") } })
      .catch((e: Error) => { if (!signal.aborted) setError(e.message || "网络错误") })
      .finally(() => {
        if (!signal.aborted) {
          setLoading(false)
          timer = setTimeout(load, 15000)
        }
      })
    return () => { controller.abort(); clearTimeout(timer) }
  }, [revision])
  async function retry(id: string) {
    setBusy(id)
    try {
      await api(`/notify/${id}/retry`, { method: "POST" })
      toast.success("此条通知的失败渠道已加入重试队列")
      load()
    } catch (e) { toast.error((e as Error).message) }
    finally { setBusy("") }
  }
  return <Card className="gap-3 p-5">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium">最近投递记录</h2>
      <Button size="sm" variant="ghost" disabled={loading} onClick={load}>{loading ? "刷新中…" : "刷新"}</Button>
    </div>
    {(error || !items) && <LoadState error={error} retry={load} />}
    {items?.length === 0 && !error && <p className="text-sm text-muted-foreground">还没有投递记录。通知送往渠道后，可在这里查看结果。</p>}
    {!!items?.length && <ul className="max-h-96 divide-y overflow-y-auto">
      {items.map((item, index) => {
        const failed = item.status === "failed"
        const status = failed ? "投递失败" : item.status === "delivered" ? "接收端已接受" :
          item.status === "pending" ? (item.attempts ? "等待重试" : "等待投递") : item.status
        // The Hub retries all failed channels for an event in one request.
        const canRetry = failed && !items.slice(0, index).some(row => row.id === item.id && row.status === "failed")
        return <li key={`${item.id}:${item.channel}`} className="space-y-1.5 py-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="min-w-0 [overflow-wrap:anywhere]">{item.title}</span>
            <span className={`text-xs ${failed ? "text-destructive" : "text-muted-foreground"}`}>{status}</span>
          </div>
          <p className="text-xs text-muted-foreground">{new Date(item.created_at * 1000).toLocaleString("zh-CN")} · {item.channel} · 尝试 {item.attempts} 次</p>
          {item.last_error && <p className="text-xs text-destructive [overflow-wrap:anywhere]">{item.last_error}</p>}
          {canRetry && <Button size="sm" variant="outline" disabled={loading || !!busy || !!error} onClick={() => retry(item.id)}>{busy === item.id ? "提交中…" : "重试失败渠道"}</Button>}
        </li>
      })}
    </ul>}
  </Card>
}

function Notify({ nodes, refresh }: { nodes: Node[]; refresh: () => void }) {
  const { s, set, save, saving, baseline, dirtyKeys, error, load } = useSettings()
  const [testing, setTesting] = useState(false)
  const [clear, setClear] = useState<"telegram" | "webhook" | "headers" | null>(null)
  if (!s) return <LoadState error={error} retry={load} />
  const text = (k: string) => String(s[k] ?? "")
  // A credential is sent only when something was typed: the field starts empty
  // because the hub never returns the stored value.
  const typed = (...keys: string[]) =>
    Object.fromEntries(keys.filter((k) => typeof s[k] === "string" && s[k] !== "").map((k) => [k, text(k)]))
  const secretHint = (k: string) => (s[`${k}_set`] ? "已设置，留空不变" : "未设置")
  const dirty = [...dirtyKeys]
  const telegramDirty = dirty.some(key => key.startsWith("notify_telegram_"))
  const webhookDirty = dirty.some(key => key.startsWith("notify_webhook_"))
  const ruleKeys = dirty.filter(key => !key.startsWith("notify_telegram_") && !key.startsWith("notify_webhook_"))
  const telegramReady = !!baseline?.notify_telegram_token_set && !!String(baseline.notify_telegram_chat ?? "").trim()
  const webhookReady = !!baseline?.notify_webhook_url_set
  const testHint = telegramDirty || webhookDirty ? "请先保存渠道修改，再发送测试。" :
    !telegramReady && !webhookReady ? "配置并保存至少一个通知渠道后，可发送测试。" : ""
  const clearActions = {
    telegram: { title: "清除 Telegram 渠道", description: "将移除已保存的 Bot Token 和 Chat ID，并停止向 Telegram 投递通知。", patch: { notify_telegram_token: "", notify_telegram_chat: "" } },
    webhook: { title: "清除 Webhook 渠道", description: "将移除已保存的 URL 和请求头，并停止向 Webhook 投递通知。", patch: { notify_webhook_url: "", notify_webhook_headers: "" } },
    headers: { title: "清除请求头", description: "Webhook 将不再携带自定义请求头。", patch: { notify_webhook_headers: "" } },
  } satisfies Record<string, { title: string; description: string; patch: Record<string, string> }>

  async function test() {
    setTesting(true)
    try {
      const { sent } = await api<{ sent: string[] }>("/notify/test", { method: "POST" })
      toast.success(`测试通知已发送：${sent.join("、")}`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="@container space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">通知</h1>
          <Button size="sm" variant="outline" disabled={testing || saving || !!testHint} aria-describedby={testHint ? "notify-test-hint" : undefined} onClick={test}>
            <Send /> {testing ? "发送中…" : "发送测试"}
          </Button>
        </div>
      {testHint && <p id="notify-test-hint" role="status" className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">{testHint}</p>}
      <div className="grid items-start gap-4 @4xl:grid-cols-2">
      <ChannelCard title="Telegram" configured={telegramReady} dirty={telegramDirty}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bot Token" hint={secretHint("notify_telegram_token")}>
            <Input
              type="password"
              autoComplete="off"
              placeholder={s.notify_telegram_token_set ? "••••••••" : "123456:ABC-DEF…"}
              value={text("notify_telegram_token")}
              onChange={(e) => set("notify_telegram_token", e.target.value)}
            />
          </Field>
          <Field label="Chat ID" hint="数字 ID，群组是负数；公开频道可填 @频道名">
            <Input value={text("notify_telegram_chat")} onChange={(e) => set("notify_telegram_chat", e.target.value)} placeholder="-1001234567890" />
          </Field>
        </div>
        <Field label="消息模板" hint={`纯文本。占位符 ${PLACEHOLDERS}`}>
          <textarea rows={3} className={TEXTAREA} value={text("notify_telegram_text")} onChange={(e) => set("notify_telegram_text", e.target.value)} />
        </Field>
        <TemplatePreview template={text("notify_telegram_text")} site={text("site_name") || "Monitor"} />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={saving || testing || !telegramDirty}
            onClick={() =>
              save({
                notify_telegram_chat: text("notify_telegram_chat"),
                notify_telegram_text: text("notify_telegram_text"),
                ...typed("notify_telegram_token"),
              })
            }
          >
            保存 Telegram
          </Button>
          {s.notify_telegram_token_set && (
            <Button size="sm" variant="ghost" disabled={saving || testing} onClick={() => setClear("telegram")}>
              清除渠道
            </Button>
          )}
        </div>
      </ChannelCard>

      <ChannelCard title="Webhook" configured={webhookReady} dirty={webhookDirty}>
        <Field label="接收渠道" hint="自动识别官方域名；自建中转请明确选择渠道。通用 HTTP 仅确认接收端返回成功。">
          <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={text("notify_webhook_kind") || "auto"} onChange={e => set("notify_webhook_kind", e.target.value)}>
            <option value="auto">自动识别</option><option value="http">通用 HTTP</option><option value="wecom">企业微信</option><option value="dingtalk">钉钉</option><option value="feishu">飞书 / Lark</option>
          </select>
        </Field>
        <Field label="自定义成功字段" hint="可选，JSON Pointer，例如 /code；设置后必须匹配预期值。">
          <Input value={text("notify_webhook_success_path")} onChange={e => set("notify_webhook_success_path", e.target.value)} placeholder="/code" />
        </Field>
        <Field label="预期 JSON 值" hint='例如 0、true 或 "ok"'>
          <Input value={text("notify_webhook_success_value")} placeholder="0" onChange={e => set("notify_webhook_success_value", e.target.value)} />
        </Field>
        <Field label="URL" hint={secretHint("notify_webhook_url")}>
          <Input
            type="password"
            autoComplete="off"
            placeholder={s.notify_webhook_url_set ? "••••••••" : "https://…"}
            value={text("notify_webhook_url")}
            onChange={(e) => set("notify_webhook_url", e.target.value)}
          />
        </Field>
        <Field label="请求头" hint={`可选，一行一个。${s.notify_webhook_headers_set ? "已设置，留空不变" : ""}`}>
          <textarea
            rows={2}
            className={TEXTAREA}
            placeholder={s.notify_webhook_headers_set ? "••••••••" : "Authorization: Bearer xxx"}
            value={text("notify_webhook_headers")}
            onChange={(e) => set("notify_webhook_headers", e.target.value)}
          />
        </Field>
        <Field label="请求体" hint={`以 POST 发送，Content-Type 为 application/json。占位符 ${PLACEHOLDERS}，须写在引号内`}>
          <textarea rows={4} className={TEXTAREA} value={text("notify_webhook_body")} onChange={(e) => set("notify_webhook_body", e.target.value)} />
        </Field>
        <TemplatePreview template={text("notify_webhook_body")} site={text("site_name") || "Monitor"} json />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={saving || testing || !webhookDirty}
            onClick={() => save({ notify_webhook_kind: text("notify_webhook_kind") || "auto", notify_webhook_success_path: text("notify_webhook_success_path"), notify_webhook_success_value: text("notify_webhook_success_value") || "0", notify_webhook_body: text("notify_webhook_body"), ...typed("notify_webhook_url", "notify_webhook_headers") })}
          >
            保存 Webhook
          </Button>
          {s.notify_webhook_headers_set && (
            <Button size="sm" variant="ghost" disabled={saving || testing} onClick={() => setClear("headers")}>
              清除请求头
            </Button>
          )}
          {s.notify_webhook_url_set && (
            <Button size="sm" variant="ghost" disabled={saving || testing} onClick={() => setClear("webhook")}>
              清除渠道
            </Button>
          )}
        </div>
      </ChannelCard>

      </div>
      <OfflineNodes nodes={nodes} refresh={refresh} />

      <Card className="gap-4 p-5">
        <form className="space-y-4" onSubmit={event => {
          event.preventDefault()
          if (ruleKeys.length) void save(Object.fromEntries(ruleKeys.map(key => [key,text(key)])))
        }}>
        <h2 className="font-semibold">提醒规则</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="离线宽限期（分钟）" hint="断开超过这么久才算离线，1–30">
            <Input type="number" required min={1} max={30} value={text("notify_grace")} onChange={(e) => set("notify_grace", e.target.value)} />
          </Field>
          <Field label="流量提醒（%）" hint="本期用量达到该比例和 100% 时各提醒一次，0 关闭">
            <Input type="number" required min={0} max={100} value={text("notify_traffic")} onChange={(e) => set("notify_traffic", e.target.value)} />
          </Field>
          <Field label="到期提醒（天）" hint="每天 9 点汇总这么多天内到期的节点，0 关闭">
            <Input type="number" required min={0} max={365} value={text("notify_expiry")} onChange={(e) => set("notify_expiry", e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {([
            ["notify_disk_percent","磁盘告警阈值（%）","0 关闭；恢复阈值低 5 个百分点",0,100],
            ["notify_disk_minutes","磁盘持续时间（分钟）","达到阈值并持续 1–120 分钟才提醒",1,120],
            ["notify_ping_failures","TCP 连续失败次数","最多 20 次，0 关闭；成功后发恢复通知",0,20],
            ["notify_cooldown","重复告警冷却（分钟）","恢复后再次提醒的间隔，1–1440 分钟",1,1440],
          ] as const).map(([key,label,hint,min,max]) => <Field key={key} label={label} hint={hint}><Input type="number" required min={min} max={max} value={text(key)} onChange={e => set(key,e.target.value)} /></Field>)}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch aria-labelledby="notify-login-label" checked={s.notify_login !== "off"} onCheckedChange={(v) => set("notify_login", v ? "on" : "off")} />
          <span id="notify-login-label">登录后台时提醒</span>
        </div>
        <div>
          <Button size="sm" type="submit" disabled={saving || !ruleKeys.length}>保存提醒规则</Button>
        </div>
        </form>
      </Card>
      <NotificationHistory />
      {clear && <ConfirmDialog title={clearActions[clear].title + "？"} description={clearActions[clear].description}
        confirmLabel={saving ? "清除中…" : clearActions[clear].title} busy={saving}
        onClose={() => { if (!saving) setClear(null) }}
        onConfirm={async () => { if (await save(clearActions[clear].patch)) setClear(null) }} />}
    </section>
  )
}

// The two ways into this panel, on their own page: the GitHub identity it trusts
// and the password that works when GitHub does not.
type Session = { id: string; current: boolean; created_at: number }

type TerminalEvent = { ts: number; actor: string; node_id: number; action: string; correlation: string }
const TERMINAL_ACTIONS: Record<string, string> = {
  open_requested: "请求开启", ready: "已连接", agent_error: "节点拒绝", closed: "已关闭",
  enabled: "允许终端", disabled: "禁用终端",
}

function TerminalHistory() {
  const [items, setItems] = useState<TerminalEvent[] | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [request, setRequest] = useState(0)

  function load() {
    setLoading(true)
    setError("")
    setRequest(n => n + 1)
  }
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    api<{ items: TerminalEvent[] }>("/terminal/history", { signal })
      .then(data => { if (!signal.aborted) setItems(data.items) })
      .catch((e: Error) => { if (!signal.aborted) setError(e.message || "网络错误") })
      .finally(() => { if (!signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [request])
  return (
    <Card className="min-w-0 gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">终端访问审计</h2>
        <Button size="sm" variant="ghost" disabled={loading} onClick={load} aria-label="刷新终端访问审计">{loading ? "刷新中…" : "刷新"}</Button>
      </div>
      <p className="text-xs text-muted-foreground">最近 100 条访问记录，不记录命令和终端内容。</p>
      {(error || !items) && <LoadState error={error} retry={load} />}
      {!error && items?.length === 0 && <p className="text-sm text-muted-foreground">暂无终端访问记录</p>}
      {!!items?.length && <ul aria-label="终端访问记录" className="max-h-80 divide-y overflow-y-auto">
        {items.map((item, i) => (
          <li key={i} className="space-y-1 py-2.5 text-xs first:pt-0 last:pb-0 [overflow-wrap:anywhere]">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-sm font-medium">节点 {item.node_id} · {TERMINAL_ACTIONS[item.action] ?? item.action}</span>
              <time className="tnum text-muted-foreground">{new Date(item.ts * 1000).toLocaleString("zh-CN")}</time>
            </div>
            <p className="text-muted-foreground">操作者 {item.actor}{item.correlation && <> · 关联 ID <code>{item.correlation}</code></>}</p>
          </li>
        ))}
      </ul>}
    </Card>
  )
}

function Sessions() {
  const [rows, setRows] = useState<Session[] | null>(null)
  const [selected, setSelected] = useState<Session | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [request, setRequest] = useState(0)
  function load() {
    setError("")
    setRequest(n => n + 1)
  }
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    api<Session[]>("/sessions", { signal })
      .then(data => { if (!signal.aborted) setRows(data) })
      .catch((e: Error) => { if (!signal.aborted) setError(e.message || "网络错误") })
    return () => controller.abort()
  }, [request])

  async function revoke() {
    if (!selected || busy) return
    setBusy(true)
    try {
      await api(`/sessions/${selected.id}`, { method: "DELETE" })
      setRows(old => old?.filter(row => row.id !== selected.id) ?? null)
      setSelected(null)
      toast.success("该登录会话已撤销")
    } catch (e) {
      toast.error((e as Error).message || "撤销失败，请重试")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="min-w-0 gap-4 p-4 sm:p-5">
      <div>
        <h2 className="text-sm font-semibold">登录会话</h2>
        <p className="mt-1 text-xs text-muted-foreground">每次登录保留 14 天。撤销会话后，对应设备需要重新登录。</p>
      </div>
      {(error || !rows) && <LoadState error={error} retry={load} />}
      {rows?.length === 0 && <p className="text-sm text-muted-foreground">暂无有效登录会话</p>}
      {!!rows?.length && <ul className="max-h-80 divide-y overflow-y-auto">
        {rows.map(session => {
          const time = new Date(session.created_at * 1000).toLocaleString("zh-CN")
          return <li key={session.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0">
            <time className="tnum text-sm">{time}</time>
            {session.current ? <Badge variant="secondary">当前会话</Badge> :
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setSelected(session)} aria-label={`撤销 ${time} 的会话`}>撤销</Button>}
          </li>
        })}
      </ul>}
      {selected && <ConfirmDialog title="撤销此登录会话？" description={`会话创建于 ${new Date(selected.created_at * 1000).toLocaleString("zh-CN")}。该设备需要重新登录，当前会话不受影响。`}
        confirmLabel={busy ? "撤销中…" : "确认撤销"} busy={busy} onClose={() => setSelected(null)} onConfirm={revoke} />}
    </Card>
  )
}

function Security({ site }: { site: string }) {
  const { s, set, save, saving, dirty: githubDirty, error, load } = useSettings()
  const [password, setPassword] = useState("")
  useDirtyGuard(password.length > 0)
  const [sessionRevision, setSessionRevision] = useState(0)
  const passwordEnabled = s?.password_login !== "off"
  const verified = !!s?.github_verified && !githubDirty
  let passwordHint = "请先保存 GitHub 配置并成功登录验证，才能关闭。"
  if (!passwordEnabled) passwordHint = "已关闭。重启或升级不会重新开启。"
  else if (s?.github_status_unknown) passwordHint = "请刷新页面确认 GitHub 登录验证状态，再关闭应急密码。"
  else if (verified) passwordHint = "关闭后仅允许 GitHub 登录，密码登录的设备会退出。"
  const callback = `${site.replace(/\/$/, "")}/api/auth/github/callback`

  return (
    <section className="@container space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">安全</h1>
      {!s ? <LoadState error={error} retry={load} /> : <div className="grid items-start gap-4 @4xl:grid-cols-2">
      <Card className="min-w-0 gap-4 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-semibold">GitHub 单点登录</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            OAuth App 回调地址 <code className="rounded bg-muted px-1 [overflow-wrap:anywhere]">{callback}</code>
          </p>
        </div>
        <div className="grid gap-4 min-[600px]:grid-cols-2">
          <Field label="Client ID">
            <Input disabled={!passwordEnabled || saving} value={String(s.github_client_id ?? "")} onChange={(e) => set("github_client_id", e.target.value)} />
          </Field>
          <Field label="Client Secret" hint={s.github_secret_set ? "已设置，留空不变" : "未设置"}>
            <Input disabled={!passwordEnabled || saving} type="password" autoComplete="off" value={String(s.github_client_secret ?? "")} placeholder={s.github_secret_set ? "••••••••" : ""} onChange={(e) => set("github_client_secret", e.target.value)} />
          </Field>
        </div>
        {String(s.github_client_id ?? "") !== "" && String(s.github_allowed_users ?? "").trim() === "" && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            白名单为空，GitHub 登录拒绝所有人。填入用户名并保存后生效。
          </p>
        )}
        <Field label="允许登录的 GitHub 用户名" hint="多个用户名用逗号分隔。保存空名单会拒绝所有 GitHub 登录。">
          <Input disabled={!passwordEnabled || saving} value={String(s.github_allowed_users ?? "")} onChange={(e) => set("github_allowed_users", e.target.value)} placeholder="GitHub 用户名" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            disabled={!githubDirty || !passwordEnabled || saving}
            onClick={async () => {
              const patch: Record<string, string> = {
                github_client_id: String(s.github_client_id ?? ""),
                github_allowed_users: String(s.github_allowed_users ?? ""),
              }
              if (typeof s.github_client_secret === "string" && s.github_client_secret) {
                patch.github_client_secret = s.github_client_secret
              }
              if (await save(patch)) setSessionRevision(n => n + 1)
            }}
          >
            {saving ? "保存中…" : "保存 GitHub 设置"}
          </Button>
          {!!s.github_ready && !verified && !githubDirty && <Button size="sm" variant="outline" asChild><a href="/api/auth/github">验证 GitHub 登录</a></Button>}
          <Badge variant={verified ? "secondary" : "outline"}>{githubDirty ? "有未保存的修改" : verified ? "已验证" : s.github_status_unknown ? "验证状态待确认" : s.github_ready ? "待登录验证" : "未配置完整"}</Badge>
        </div>
        {githubDirty && <p className="text-xs text-muted-foreground">更改 GitHub 登录配置后，已有 GitHub 会话将退出，需要重新验证。</p>}
        {!passwordEnabled && <p className="text-sm text-muted-foreground">修改 GitHub 配置前，请先开启应急密码。</p>}
      </Card>

      <Card className="min-w-0 gap-4 p-4 sm:p-5">
        <div>
          <h2 className="text-sm font-semibold">应急密码</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            GitHub 不可用时的备用入口。修改后其它设备登录立即失效，当前设备不受影响。
          </p>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label id="password-login-label">允许应急密码登录</Label>
            <p id="password-login-hint" className="text-sm text-muted-foreground">
              {passwordHint}
            </p>
          </div>
          <Switch aria-labelledby="password-login-label" aria-describedby="password-login-hint" checked={passwordEnabled} disabled={saving || (passwordEnabled && !verified)} onCheckedChange={async (enabled) => { if (await save({ password_login: enabled ? "on" : "off" })) setSessionRevision(n => n + 1) }} />
        </div>
        {!passwordEnabled && <p className="text-sm text-muted-foreground">GitHub 无法登录时，可在 Hub 服务器执行 <code className="break-all">sudo /opt/monitor/monitor-hub --db /opt/monitor/data/monitor.db --reset-password</code> 恢复。</p>}
        <Field label="新密码" hint="至少 12 位；修改密码不会自动开启密码登录">
          <Input type="password" disabled={saving} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <div>
          <Button
            size="sm"
            disabled={saving || password.length < 12}
            onClick={async () => { if (await save({ admin_password: password })) { setPassword(""); setSessionRevision(n => n + 1) } }}
          >
            修改密码
          </Button>
        </div>
      </Card>
      </div>}
      <div className="grid items-start gap-4 @4xl:grid-cols-2">
        <Sessions key={sessionRevision} />
        <TerminalHistory />
      </div>
    </section>
  )
}

type DbInfo = {
  path: string
  size: number
  wal: number
  free: number
  /** Timestamp of the earliest history row, null on a database with none. */
  oldest: number | null
  retention: number
  backup_success?: string | null
  backup_error?: string | null
  scheduled_backup?: {
    scheduler: { state: "active" | "inactive" | "not_installed" | "unavailable"; boot_enabled?: boolean; calendar?: string | null; random_delay?: string | null; next_run?: string | null }
    policy: { directory: string; keep: number; offsite: boolean } | null
    copies: number | null
    checked_at: number | null
    timezone: string | null
    stale?: boolean
  }
  rows: Record<string, number>
}

// The only two tables whose row count indicates anything about size. Every other
// holds one row per node or per key.
const DB_ROWS: [string, string][] = [
  ["metric", "历史明细"],
  ["ping_record", "延迟记录"],
  ["visitor_log", "访客记录"],
]

function Data() {
  const [info, setInfo] = useState<DbInfo | null>(null)
  const [busy, setBusy] = useState("")
  const [confirm, setConfirm] = useState<"vacuum" | null>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [sent, setSent] = useState(0)
  const [fileError, setFileError] = useState("")
  const operation = useRestoreOperation()
  // Closing the dialog must stop the upload rather than merely hide it: restore
  // is the one irreversible action here, and it takes minutes on a large
  // backup.
  const abort = useRef<AbortController | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const [error, setError] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const load = () => { setError(""); setRefreshing(true); return api<DbInfo>("/db").then(setInfo).catch((e: Error) => setError(e.message || "网络错误")).finally(() => setRefreshing(false)) }
  useEffect(() => { queueMicrotask(load) }, [])

  async function vacuum() {
    setBusy("vacuum")
    try {
      const { pruned, freed } = await api<{ pruned: number; freed: number }>("/db/vacuum", { method: "POST" })
      toast.success(`已清理 ${pruned} 行，回收 ${bytes(freed)}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
      setConfirm(null)
    }
  }

  useDirtyGuard(false, busy === "restore" && !!pending)
  useEffect(() => () => abort.current?.abort(), [])
  async function restore(file: File) {
    if (abort.current || operation) return
    const controller = new AbortController()
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, "0")).join("")
    abort.current = controller
    setBusy("restore")
    setSent(0)
    setFileError("")
    let submitted = false
    try {
      // A cancelled upload has no effect on the live database.
      await upload("/db/restore", file, setSent, controller.signal, { "x-cmonitor-restore-id": id })
      if (controller.signal.aborted) throw new DOMException("aborted", "AbortError")
      submitted = true
      trackRestore(id)
      setPending(null)
      await api(`/db/restore/${id}/apply`, { method: "POST", signal: AbortSignal.timeout(15_000) })
    } catch (e) {
      if (submitted) {
        toast.info("恢复结果待确认，正在查询操作状态。请勿重复导入。")
      } else {
        void api(`/db/restore/${id}`, { method: "DELETE" }).catch(() => {})
        setPending(null)
        if (controller.signal.aborted) toast.info("上传已取消，尚未提交恢复")
        else setFileError(`上传未完成，尚未提交恢复：${(e as Error).message || "网络错误"}。可重新选择备份文件。`)
      }
    } finally {
      abort.current = null
      setBusy("")
    }
  }

  if (!info) return <section className="space-y-4"><h1 className="text-2xl font-semibold tracking-tight">数据与备份</h1><LoadState error={error} retry={load} /></section>
  const backup = info.scheduled_backup
  const calendar = backup?.scheduler.calendar
  const daily = calendar?.match(/^\*-\*-\* (\d{2}:\d{2}):\d{2}$/)?.[1]
  const delay = backup?.scheduler.random_delay?.replace(/min/g, " 分钟").replace(/sec/g, " 秒")
  const backupState = backup?.scheduler.state === "active" ? "已启用" : backup?.scheduler.state === "inactive" ? "已停用" : backup?.scheduler.state === "not_installed" ? "尚未安装定时任务" : "无法确认定时任务状态"
  const stat = (label: string, value: string) => (
    <div key={label} className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tnum mt-1 text-sm font-medium [overflow-wrap:anywhere]">{value}</dd>
    </div>
  )

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">数据与备份</h1>
      {error && <LoadState error={error} retry={load} />}
      <Card className="gap-4 p-4 sm:p-5" aria-labelledby="scheduled-backup-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="scheduled-backup-title" className="text-sm font-semibold">自动备份</h2>
            <Badge variant="secondary" role="status" className="whitespace-normal">{backupState}{backup?.scheduler.state === "active" && backup.scheduler.boot_enabled === false ? "（未设置开机启用）" : ""}</Badge>
          </div>
          <Button size="sm" variant="secondary" disabled={refreshing || !!busy || !!operation} onClick={load}>
            <RefreshCw className={refreshing ? "animate-spin" : ""} /> {refreshing ? "刷新中…" : "刷新备份状态"}
          </Button>
        </div>
        {info.backup_error && <p role="alert" className="rounded-md bg-destructive/10 [overflow-wrap:anywhere] px-3 py-2 text-sm text-destructive">最近备份失败：{info.backup_error}</p>}
        {backup?.stale && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">备份状态尚未上报或已过期，请检查服务器上的状态上报任务。</p>}
        <dl className="grid gap-4 rounded-lg bg-muted/45 p-3 sm:grid-cols-3 sm:p-4">
          {stat("最近成功（本地时间）", info.backup_success ? new Date(Number(info.backup_success) * 1000).toLocaleString("zh-CN") : "尚无成功记录")}
          {stat("下次执行（服务器时间）", (backup?.scheduler.state === "active" ? backup.scheduler.next_run : null)?.replace(/^\w+ (\d{4}-\d{2}-\d{2}) /, "$1 ") ?? "暂无下次执行时间")}
          {stat("已有备份", backup?.copies != null ? `${backup.copies} 份` : "无法读取备份目录")}
        </dl>
        <dl className="grid gap-4 sm:grid-cols-3">
          {stat("执行时间（服务器时间）", calendar ? `${daily ? `每天 ${daily}` : calendar}${delay && delay !== "0" ? `，最多延后 ${delay}` : ""}` : "暂无计划信息")}
          {stat("保留策略", backup?.policy ? `最近 ${backup.policy.keep} 份及最近 ${backup.policy.keep} 个备份日期的每日副本` : "等待备份任务上报")}
          {stat("异机复制", backup?.policy ? backup.policy.offsite ? "已配置" : "未配置，目前仅保存在本机" : "等待备份任务上报")}
        </dl>
        {backup?.policy && <p className="break-all text-xs text-muted-foreground">备份目录：<code>{backup.policy.directory}</code></p>}
        <p className="text-xs leading-relaxed text-muted-foreground">
          新备份成功后才清理超出的旧备份；保留份数与历史数据保留天数分别计算。保留策略和目录来自最近一次备份任务。
          {backup?.checked_at != null && <> {backup.timezone && <>服务器时区：{backup.timezone}。</>} 状态上报于 {new Date(backup.checked_at * 1000).toLocaleString("zh-CN")}。</>} 状态每分钟更新一次。
        </p>
      </Card>
      <Card className="gap-4 p-4 sm:p-5">
        <h2 className="text-sm font-semibold">数据库</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {stat("文件大小", bytes(info.size))}
          {stat("预写日志", bytes(info.wal))}
          {stat("可回收空间", bytes(info.free))}
          {stat("保留天数", `${info.retention} 天`)}
          {/* 和保留天数并排：跨度小于保留期是还没攒够，大于保留期就是每小时
              那次 prune 没在跑。 */}
          {stat("历史跨度", info.oldest ? `${Math.floor((Date.now() / 1000 - info.oldest) / 86400)} 天` : "—")}
          {DB_ROWS.map(([key, label]) => stat(label, (info.rows[key] ?? 0).toLocaleString()))}
        </dl>
        <p className="break-all border-t pt-3 text-xs text-muted-foreground">
          数据库路径：<code>{info.path}</code>
        </p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0 justify-between gap-4 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold">回收空间</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              按保留天数清掉过期明细，再重建数据库文件把空出来的页还给磁盘（SQLite 的 VACUUM）。
              重建期间需要与数据库等量的空闲磁盘，过程中面板和上报会短暂变慢。
            </p>
          </div>
          <div>
            <Button size="sm" variant="secondary" disabled={!!busy || !!operation} onClick={() => setConfirm("vacuum")}>
              {busy === "vacuum" ? "回收中…" : "立即回收"}
            </Button>
          </div>
        </Card>

        <Card className="min-w-0 justify-between gap-4 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold">手动备份与恢复</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              导出的数据库含节点凭证与密码哈希，请妥善保管。恢复时请选择这里导出的备份，最大 256 MiB。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* The browser's own download: the file is streamed straight from
                the response, never held in the page. */}
            <Button size="sm" asChild>
              <a href="/api/db/backup" download>
                <Download /> 导出备份
              </a>
            </Button>
            <Button size="sm" variant="secondary" disabled={!!busy || !!operation} onClick={() => picker.current?.click()}>
              <Upload /> 导入备份
            </Button>
            <input
              ref={picker}
              type="file"
              accept=".db,application/octet-stream"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ""
                if (!file) return
                if (!file.size || file.size > 256 * 1024 * 1024) {
                  setFileError(!file.size ? "所选文件为空，请重新选择备份。" : "备份超过 256 MiB，请重新选择文件。")
                  return
                }
                setFileError("")
                setPending(file)
              }}
            />
          </div>
          {fileError && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{fileError}</p>}
        </Card>
      </div>

      {confirm === "vacuum" && (
        <ConfirmDialog
          title="回收空间？"
          description="超出保留天数的历史明细会被删除，然后重建数据库文件。累计流量不受影响。"
          confirmLabel="开始回收"
          busy={!!busy}
          onClose={() => setConfirm(null)}
          onConfirm={vacuum}
        />
      )}
      {pending && (
        <ConfirmDialog
          title="用备份覆盖当前数据？"
          description={`校验通过后，${pending.name}（${bytes(pending.size)}）将覆盖当前节点、设置和历史记录，所有设备需重新登录。Hub 会先备份当前数据库。`}
          confirmLabel={busy === "restore" ? `已上传 ${bytes(sent)} / ${bytes(pending.size)}` : "确认恢复"}
          busy={!!busy}
          canCancelWhileBusy={busy === "restore"}
          onClose={() => { abort.current?.abort(); setPending(null) }}
          onConfirm={() => restore(pending)}
        />
      )}
    </div>
  )
}

// Each area is its own route rather than a tab, so a page can be linked to and a
// reload returns to the same section.
const ADMIN_SECTIONS = [
  { path: "/clara/nodes", label: "节点", icon: Server },
  { path: "/clara/visitors", label: "访客", icon: Users },
  { path: "/clara/ping", label: "延迟", icon: Radio },
  { path: "/clara/notify", label: "通知", icon: Bell },
  { path: "/clara/data", label: "数据与备份", icon: Database },
  { path: "/clara/themes", label: "主题", icon: Palette },
  { path: "/clara/security", label: "安全", icon: Shield },
  { path: "/clara/settings", label: "设置", icon: Settings },
] as const

export function Admin({
  path,
  go,
  nodes,
  nodeError,
  staleSince,
  refresh,
  site,
  canProvision,
}: {
  path: string
  go: (to: string) => void
  nodes: Node[] | null
  nodeError: string | null
  staleSince: number | null
  refresh: () => void
  site: string
  canProvision: boolean
}) {
  const section = ADMIN_SECTIONS.find(item => item.path === path)
  const usesNodes = needsInventory(path)
  useEffect(() => {
    const previous = document.title
    document.title = `${section?.label ?? "页面不存在"} · Monitor 后台`
    return () => { document.title = previous }
  }, [section])

  function renderSection() {
    switch (path) {
      case "/clara/visitors": return <Visitors />
      case "/clara/data": return <Data />
      case "/clara/themes": return <Themes />
      case "/clara/security": return <Security site={site} />
      case "/clara/settings": return <SettingsTab />
    }
    if (!section) return <Card className="items-start gap-3 p-5">
      <h1 className="text-xl font-semibold">后台页面不存在</h1>
      <p className="text-sm text-muted-foreground">请从导航选择页面，或返回节点管理。</p>
      <Button variant="outline" onClick={() => go("/clara/nodes")}>返回节点管理</Button>
    </Card>
    if (!nodes) return <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{section.label}</h1>
      <div role={nodeError ? "alert" : "status"} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 text-sm">
        <span className="min-w-0 [overflow-wrap:anywhere]">{nodeError ? `节点列表加载失败：${nodeError}` : "正在加载节点列表…"}</span>
        {nodeError && <Button variant="outline" size="sm" onClick={refresh}>重新加载节点</Button>}
      </div>
    </section>
    if (path === "/clara/ping") return <Ping nodes={nodes} />
    if (path === "/clara/notify") return <Notify nodes={nodes} refresh={refresh} />
    return <Nodes nodes={nodes} refresh={refresh} site={site} canProvision={canProvision} />
  }

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:gap-6">
      <nav aria-label="后台导航" className="grid grid-cols-4 gap-1 rounded-xl border bg-card p-1.5 shadow-sm backdrop-blur-md min-[800px]:grid-cols-8 lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100dvh-6rem)] lg:w-40 lg:shrink-0 lg:flex-col lg:self-start lg:overflow-y-auto lg:p-2 xl:w-44">
        {ADMIN_SECTIONS.map(({ path: to, label, icon: Icon }) => {
          const active = path === to
          return (
            <Button key={to} asChild variant="choice" size="sm"
              className="min-h-10 min-w-0 rounded-lg px-1 text-xs has-[>svg]:px-1 min-[460px]:text-sm lg:justify-start lg:gap-2.5 lg:px-3 lg:has-[>svg]:px-3">
              <a href={to} aria-current={active ? "page" : undefined} onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                e.preventDefault()
                if (!active) go(to)
              }}>
                <Icon aria-hidden="true" className="hidden size-4 shrink-0 min-[460px]:block min-[800px]:hidden lg:block" />
                {label}
              </a>
            </Button>
          )
        })}
      </nav>

      <div className="min-w-0 flex-1 space-y-4">
        {usesNodes && nodes && staleSince !== null && <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-popover px-4 py-2 text-sm">
          <span>节点数据更新中断。当前显示 {new Date(staleSince).toLocaleTimeString("zh-CN")} 收到的状态。</span>
          <Button variant="outline" size="sm" onClick={refresh}>重试</Button>
        </div>}
        {renderSection()}
      </div>
    </div>
  )
}
