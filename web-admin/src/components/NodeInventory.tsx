import { useEffect, useId, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { ArrowDown, ArrowUp, CalendarClock, Copy, Download, Eye, EyeOff, GripVertical, LockKeyhole, Pencil, Search, Server, ShieldCheck, ShieldOff, Terminal, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { OfflineUpgradeButton } from "./OfflineUpgradeButton"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { addresses, api, terminalControl, type Node } from "@/lib/api"
import { bytes, CYCLES, money, monthUsage, uptime } from "@/lib/format"
import "./node-inventory.css"

type NodeActions = Record<"edit" | "bill" | "install" | "terminal" | "toggleTerminal" | "togglePublic" | "remove", (node: Node) => void>

function NodeName({ node }: { node: Node }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    <span className="min-w-0 font-semibold wrap-anywhere">{node.name}</span>
    {node.country && <span className="node-country">{node.country}</span>}
  </div>
}

function NodeStatus({ node }: { node: Node }) {
  const unseen = Date.now() / 1000 - node.last_seen
  return <div className="node-status flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span className="node-status-pill" data-online={node.online}><span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{node.online ? "在线" : "离线"}</span>
    {!node.public && <span className="inline-flex items-center gap-1"><EyeOff aria-hidden="true" className="size-3" />不公开</span>}
    {node.agent_version && <span className="tnum wrap-anywhere">Cagent {node.agent_version}</span>}
    {!node.online && node.last_seen > 0 && unseen >= 60 && <span className="tnum">上次上报于 {uptime(unseen)}前</span>}
  </div>
}

function NodeAddresses({ node, copy }: { node: Node; copy: (value: string) => void }) {
  const values = addresses(node)
  return <div className="min-w-0 space-y-1">
    {values.length ? values.map(value => (
      <button key={value} type="button" title="点击复制地址" aria-label={`复制地址 ${value}`}
        className="node-address group flex min-h-6 max-w-full cursor-pointer items-center gap-1 rounded text-left text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => copy(value)}>
        <span translate="no" className="font-mono break-all">{value}</span>
        <Copy aria-hidden="true" className="size-3 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    )) : <span className="text-xs text-muted-foreground">暂无地址</span>}
    {!!node.network_interfaces?.length && <p className="text-xs text-muted-foreground wrap-anywhere">统计网卡：{node.network_interfaces.join(", ")}</p>}
  </div>
}

function NodeTraffic({ node }: { node: Node }) {
  return <div className="tnum space-y-1">
    <div className="flex flex-wrap items-baseline gap-x-1 font-medium">
      <span>{node.traffic_incomplete && "≥ "}{bytes(monthUsage(node))}</span>
      <span className="text-xs font-normal text-muted-foreground">/ {node.traffic_limit > 0 ? bytes(node.traffic_limit) : "不限量"}</span>
    </div>
    {node.traffic_incomplete && <div className="text-xs text-muted-foreground">本期历史不完整</div>}
  </div>
}

function NodePrice({ node }: { node: Node }) {
  return <div className="node-price tnum flex flex-wrap items-baseline gap-x-1 font-medium wrap-anywhere">
    <span>{node.price > 0 ? money(node.price, node.currency) : "免费"}</span>
    {node.price > 0 && CYCLES[node.billing_cycle] && <span className="text-xs font-normal text-muted-foreground">/ {CYCLES[node.billing_cycle]}</span>}
  </div>
}

function expiry(node: Node) {
  return node.permanent ? "永久有效" : node.expires_at || "未设置"
}

function RowActions({ node, actions, canProvision, canMoveUp, canMoveDown, onMove, mobile }: {
  node: Node; actions: NodeActions; canProvision: boolean; canMoveUp: boolean; canMoveDown: boolean; onMove: (delta: number) => void; mobile: boolean
}) {
  const terminal = terminalControl(node)
  const reasonId = useId()
  const policyDisabled = node.terminal_enabled === false
  const visibility = node.public ? "隐藏节点" : "公开节点"
  const controls = [
    { key: "visibility", label: visibility, text: node.public ? "隐藏" : "公开", icon: node.public ? EyeOff : Eye, run: () => actions.togglePublic(node) },
    { key: "terminal", label: terminal.text, text: "终端", icon: Terminal, run: () => actions.terminal(node), disabled: terminal.disabled },
    { key: "policy", label: policyDisabled ? "允许节点终端" : "禁用节点终端", text: policyDisabled ? "允许终端" : "禁用终端", icon: policyDisabled ? ShieldCheck : ShieldOff, run: () => actions.toggleTerminal(node) },
    { key: "install", label: "安装 Agent", text: "安装", icon: Download, run: () => actions.install(node), disabled: !canProvision },
    { key: "edit", label: mobile ? "编辑" : "编辑节点", text: "编辑", icon: Pencil, run: () => actions.edit(node) },
    { key: "billing", label: "续费设置", text: "续费", icon: CalendarClock, run: () => actions.bill(node) },
    { key: "delete", label: "删除节点", text: "删除", icon: Trash2, run: () => actions.remove(node) },
    { key: "up", label: "上移", text: "上移", icon: ArrowUp, run: () => onMove(-1), disabled: !canMoveUp },
    { key: "down", label: "下移", text: "下移", icon: ArrowDown, run: () => onMove(1), disabled: !canMoveDown },
  ]

  return <div className="node-actions" data-layout={mobile ? "mobile" : "table"}>
    <div role="group" aria-label={`${node.name} 操作`} className="node-action-grid">
      {controls.map(({key, label, text, icon: Icon, disabled, run}) => <Button
        key={key} type="button" size="sm" variant="ghost" title={label} className="node-action"
        data-action={key} data-policy-closed={key === "policy" && policyDisabled ? "" : undefined}
        aria-label={label} aria-describedby={key === "terminal" && terminal.disabled ? reasonId : undefined}
        disabled={disabled} onClick={run}>
        <Icon aria-hidden="true" className="size-3.5" />{text}
      </Button>)}
    </div>
    {terminal.disabled && <p className="node-terminal-note" id={reasonId}>
      <LockKeyhole aria-hidden="true" className="size-3 shrink-0" /><span>终端不可用：{terminal.text}</span>
    </p>}
  </div>
}

const statusLabels = { all: "全部", online: "在线", offline: "离线" } as const
type InventoryStatus = keyof typeof statusLabels

function readStatus(): InventoryStatus {
  const value = new URLSearchParams(location.search).get("status")
  return value === "online" || value === "offline" ? value : "all"
}

export function NodeInventory({ nodes, refresh, copy, actions, canProvision, onCreate, query, clearQuery }: {
  nodes: Node[]; refresh: () => void; copy: (value: string) => void; actions: NodeActions; canProvision: boolean; onCreate: () => void; query: string; clearQuery: () => void
}) {
  const [manualOrder, setManualOrder] = useState<number[]>([])
  const [dragging, setDragging] = useState<number | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const manualIds = new Set(manualOrder)
  const ordered = [
    ...manualOrder.map(id => byId.get(id)).filter((node): node is Node => !!node),
    ...nodes.filter(node => !manualIds.has(node.id)),
  ]
  const [status, setStatus] = useState(readStatus)
  const allFilter = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const sync = () => setStatus(readStatus())
    window.addEventListener("popstate", sync)
    return () => window.removeEventListener("popstate", sync)
  }, [])
  function chooseStatus(next: InventoryStatus) {
    const url = new URL(location.href)
    if (next === "all") url.searchParams.delete("status")
    else url.searchParams.set("status", next)
    history.replaceState(history.state, "", url)
    setStatus(next)
  }

  const online = nodes.filter(node => node.online).length
  const counts = { all: nodes.length, online, offline: nodes.length - online }
  const needle = query.trim().toLowerCase()
  const filtered = !!needle || status !== "all"
  const visible = filtered
    ? ordered.filter(node => (status === "all" || node.online === (status === "online")) &&
      (!needle || [node.name, node.ip, node.ipv4, node.ipv6].some(value => value?.toLowerCase().includes(needle))))
    : ordered
  const canSort = !filtered && !savingOrder

  async function moveNode(from: number, to: number) {
    if (!canSort || from < 0 || to < 0 || to >= ordered.length || from === to) return
    const previous = ordered.map(node => node.id)
    const next = [...previous]
    next.splice(to, 0, ...next.splice(from, 1))
    setSavingOrder(true)
    let painted: Promise<void> | undefined
    if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      painted = document.startViewTransition(() => flushSync(() => setManualOrder(next))).updateCallbackDone
    } else {
      setManualOrder(next)
    }
    try {
      await api("/nodes/order", { method: "PUT", body: JSON.stringify({ ids: next }) })
      refresh()
    } catch (err) {
      // A quick failure can arrive before the transition applies the local move.
      await painted
      setManualOrder(previous)
      toast.error((err as Error).message)
    } finally {
      await painted
      setSavingOrder(false)
    }
  }

  function rowActions(node: Node, index: number, mobile: boolean) {
    return <RowActions node={node} actions={actions} canProvision={canProvision} mobile={mobile}
      canMoveUp={canSort && index > 0} canMoveDown={canSort && index < ordered.length - 1} onMove={delta => { void moveNode(index, index + delta) }} />
  }

  return <Card className="node-glass node-inventory @container gap-0 overflow-hidden p-0">
    <div className="node-list-tools">
      <div role="group" aria-label="按节点状态筛选" className="node-status-filters">
        {(Object.keys(statusLabels) as InventoryStatus[]).map(key => (
          <Button key={key} ref={key === "all" ? allFilter : undefined} size="sm" variant="choice" aria-pressed={status === key} onClick={() => chooseStatus(key)}>
            {statusLabels[key]} <span className="tnum">{counts[key]}</span>
          </Button>
        ))}
      </div>
      {filtered && <span role="status" className="tnum text-xs text-muted-foreground">显示 {visible.length} 台</span>}
    </div>
    {!visible.length ? <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {filtered ? <Search aria-hidden="true" className="size-6 text-muted-foreground" /> : <Server aria-hidden="true" className="size-6 text-muted-foreground" />}
      <p role="status" className="text-sm font-medium">{!needle && status === "offline" && nodes.length ? "当前没有离线节点" : filtered ? "没有匹配的节点" : "还没有节点"}</p>
      {filtered
        ? <Button size="sm" variant="outline" onClick={() => { clearQuery(); chooseStatus("all"); allFilter.current?.focus() }}>清除筛选</Button>
        : <Button size="sm" variant="outline" disabled={!canProvision} onClick={onCreate}>添加首个节点</Button>}
    </div> : <>
      <ul className="node-mobile-list divide-y md:hidden">
        {visible.map((node, index) => <li key={node.id} className="space-y-3 px-4 py-4">
          <NodeName node={node} />
          <NodeStatus node={node} />
          {node.offline_only && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>仅离线升级</span><OfflineUpgradeButton node={node} className="node-offline-command" /></div>}
          <NodeAddresses node={node} copy={copy} />
          <dl className="flex flex-wrap items-start gap-x-5 gap-y-2 text-sm">
            <div><dt className="mb-1 text-xs text-muted-foreground">本期流量</dt><dd><NodeTraffic node={node} /></dd></div>
            <div><dt className="mb-1 text-xs text-muted-foreground">价格</dt><dd><NodePrice node={node} /></dd></div>
            <div><dt className="mb-1 text-xs text-muted-foreground">到期</dt><dd className="tnum">{expiry(node)}</dd></div>
          </dl>
          <div className="node-mobile-actions">{rowActions(node, index, true)}</div>
        </li>)}
      </ul>
      <div className="hidden md:block">
        <Table className="node-table table-fixed" aria-label="节点列表">
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-[15%] pl-4">名称</TableHead>
              <TableHead scope="col" className="w-[16%]">IP</TableHead>
              <TableHead scope="col" className="w-[9%]">状态</TableHead>
              <TableHead scope="col" className="w-[11%]">流量</TableHead>
              <TableHead scope="col" className="w-[10%]">价格</TableHead>
              <TableHead scope="col" className="w-[10%]">到期</TableHead>
              <TableHead scope="col" className="pr-4 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((node, index) => <TableRow key={node.id} style={{viewTransitionName: `node-${node.id}`}}
              className="data-[dragging]:opacity-45 data-[drop-target]:bg-accent [&_td]:py-3 [&_td]:whitespace-normal"
              data-dragging={dragging === node.id || undefined} data-drop-target={dropTarget === node.id && dragging !== node.id || undefined}
              onDragOver={event => {
                if (dragging === null || !canSort) return
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
              }}
              onDragEnter={() => { if (dragging !== null && canSort) setDropTarget(node.id) }}
              onDrop={event => {
                if (dragging === null || !canSort) return
                event.preventDefault()
                const from = ordered.findIndex(item => item.id === dragging)
                setDragging(null)
                setDropTarget(null)
                void moveNode(from, index)
              }}>
              <TableCell>
                <div className="flex items-center gap-1">
                  <button type="button" draggable={canSort} disabled={!canSort} aria-label={`拖动 ${node.name} 排序`}
                    title={filtered ? "清除筛选后可排序" : "拖动或按上下方向键排序"}
                    className="shrink-0 cursor-grab rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-35"
                    onDragStart={event => {
                      setDragging(node.id)
                      event.dataTransfer.effectAllowed = "move"
                      event.dataTransfer.setData("text/plain", String(node.id))
                    }}
                    onDragEnd={() => { setDragging(null); setDropTarget(null) }}
                    onKeyDown={event => {
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
                      event.preventDefault()
                      void moveNode(index, index + (event.key === "ArrowUp" ? -1 : 1))
                    }}><GripVertical aria-hidden="true" className="size-4" /></button>
                  <NodeName node={node} />
                </div>
                {node.offline_only && <div className="mt-1.5"><OfflineUpgradeButton node={node} className="node-offline-command" /></div>}
              </TableCell>
              <TableCell><NodeAddresses node={node} copy={copy} /></TableCell>
              <TableCell><NodeStatus node={node} /></TableCell>
              <TableCell><NodeTraffic node={node} /></TableCell>
              <TableCell><NodePrice node={node} /></TableCell>
              <TableCell className="node-expiry tnum wrap-anywhere">{expiry(node)}</TableCell>
              <TableCell className="pr-3">{rowActions(node, index, false)}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
    </>}
  </Card>
}
