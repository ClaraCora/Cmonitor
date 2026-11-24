import { useState } from "react"
import { flushSync } from "react-dom"
import { ArrowDown, ArrowUp, CalendarClock, Copy, Download, Eye, EyeOff, GripVertical, Pencil, Search, Server, Shield, Terminal, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { OfflineUpgradeButton } from "./OfflineUpgradeButton"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { addresses, api, terminalControl, type Node } from "@/lib/api"
import { bytes, CYCLES, money, monthUsage, uptime } from "@/lib/format"

type NodeActions = Record<"edit" | "bill" | "install" | "terminal" | "toggleTerminal" | "togglePublic" | "remove", (node: Node) => void>

function NodeName({ node }: { node: Node }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
    <span className="min-w-0 font-medium wrap-anywhere">{node.name}</span>
    {node.country && <span className="rounded border px-1 text-[11px] leading-4 text-muted-foreground">{node.country}</span>}
  </div>
}

function NodeStatus({ node }: { node: Node }) {
  const unseen = Date.now() / 1000 - node.last_seen
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={`size-1.5 rounded-full ${node.online ? "bg-ok" : "bg-muted-foreground"}`} />{node.online ? "在线" : "离线"}</span>
    {!node.public && <span className="inline-flex items-center gap-1"><EyeOff className="size-3" />不公开</span>}
    {node.agent_version && <span className="tnum wrap-anywhere">Cagent {node.agent_version}</span>}
    {!node.online && node.last_seen > 0 && unseen >= 60 && <span className="tnum">上次上报于 {uptime(unseen)}前</span>}
  </div>
}

function NodeAddresses({ node, copy }: { node: Node; copy: (value: string) => void }) {
  const values = addresses(node)
  return <div className="min-w-0 space-y-1">
    {values.length ? values.map(value => (
      <button key={value} type="button" title="点击复制地址" aria-label={`复制地址 ${value}`}
        className="group flex min-h-6 max-w-full items-center gap-1 rounded text-left text-xs leading-relaxed focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => copy(value)}>
        <span className="font-mono break-all">{value}</span>
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
  return <div className="tnum flex flex-wrap items-baseline gap-x-1 font-medium wrap-anywhere">
    {node.price > 0 ? money(node.price, node.currency) : "免费"}
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
  const visibility = node.public ? "隐藏节点" : "公开节点"
  const policy = node.terminal_enabled === false ? "允许节点终端" : "禁用节点终端"
  const controls = [
    { label: visibility, text: node.public ? "隐藏" : "公开", icon: node.public ? EyeOff : Eye, run: () => actions.togglePublic(node) },
    { label: terminal.text, text: "终端", icon: Terminal, run: () => actions.terminal(node), disabled: terminal.disabled },
    { label: policy, text: node.terminal_enabled === false ? "允许终端" : "禁用终端", icon: Shield, run: () => actions.toggleTerminal(node) },
    { label: "安装 Agent", text: "安装", icon: Download, run: () => actions.install(node), disabled: !canProvision },
    { label: mobile ? "编辑" : "编辑节点", text: "编辑", icon: Pencil, run: () => actions.edit(node) },
    { label: "续费设置", text: "续费", icon: CalendarClock, run: () => actions.bill(node) },
    { label: "删除节点", text: "删除", icon: Trash2, run: () => actions.remove(node), destructive: true },
    { label: "上移", text: "上移", icon: ArrowUp, run: () => onMove(-1), disabled: !canMoveUp },
    { label: "下移", text: "下移", icon: ArrowDown, run: () => onMove(1), disabled: !canMoveDown },
  ]
  const buttonStyle = mobile
    ? "min-h-11 gap-1.5 px-2 text-xs has-[>svg]:px-2 @min-[39rem]:flex-col @min-[39rem]:gap-0.5 @min-[39rem]:text-[11px]"
    : "h-10 min-w-8 flex-col gap-0.5 px-1 text-[11px] leading-none has-[>svg]:px-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11"

  return <div>
    <div role="group" aria-label={`${node.name} 操作`} className={mobile
      ? "grid grid-cols-3 gap-1 @min-[39rem]:grid-cols-9"
      : "flex flex-wrap justify-end gap-0.5"}>
      {controls.map(({label, text, icon: Icon, disabled, destructive, run}) => <Button
        key={text} type="button" size="sm" variant={mobile ? "outline" : "ghost"} title={label}
        aria-label={label} disabled={disabled} onClick={run}
        className={`${buttonStyle} ${destructive ? "text-destructive hover:text-destructive" : ""}`}>
        <Icon aria-hidden="true" className="size-3.5" />{text}
      </Button>)}
    </div>
    {terminal.disabled && <p className={`mt-1 text-xs text-muted-foreground ${mobile ? "" : "text-right"}`}>终端不可用：{terminal.text}</p>}
  </div>
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
  const needle = query.trim().toLowerCase()
  const filtered = !!needle
  const visible = filtered
    ? ordered.filter(node => [node.name, node.ip, node.ipv4, node.ipv6].some(value => value?.toLowerCase().includes(needle)))
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

  return <Card className="@container gap-0 overflow-hidden p-0">
    {!visible.length ? <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {filtered ? <Search aria-hidden="true" className="size-6 text-muted-foreground" /> : <Server aria-hidden="true" className="size-6 text-muted-foreground" />}
      <p role="status" className="text-sm font-medium">{filtered ? "没有匹配的节点" : "还没有节点"}</p>
      {filtered
        ? <Button size="sm" variant="outline" onClick={clearQuery}>清除搜索</Button>
        : <Button size="sm" variant="outline" disabled={!canProvision} onClick={onCreate}>添加首个节点</Button>}
    </div> : <>
      <ul className="divide-y md:hidden">
        {visible.map((node, index) => <li key={node.id} className="space-y-3 px-4 py-4">
          <NodeName node={node} />
          <NodeStatus node={node} />
          {node.offline_only && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>仅离线升级</span><OfflineUpgradeButton node={node} /></div>}
          <NodeAddresses node={node} copy={copy} />
          <dl className="flex flex-wrap items-start gap-x-5 gap-y-2 text-sm">
            <div><dt className="mb-1 text-xs text-muted-foreground">本期流量</dt><dd><NodeTraffic node={node} /></dd></div>
            <div><dt className="mb-1 text-xs text-muted-foreground">价格</dt><dd><NodePrice node={node} /></dd></div>
            <div><dt className="mb-1 text-xs text-muted-foreground">到期</dt><dd className="tnum">{expiry(node)}</dd></div>
          </dl>
          <div className="border-t pt-2">{rowActions(node, index, true)}</div>
        </li>)}
      </ul>
      <div className="hidden md:block">
        <Table className="table-fixed" aria-label="节点列表">
          <TableHeader className="bg-muted/50 [&_th]:text-xs [&_th]:text-muted-foreground">
            <TableRow>
              <TableHead scope="col" className="w-[15%] pl-4">名称</TableHead>
              <TableHead scope="col" className="w-[17%]">IP</TableHead>
              <TableHead scope="col" className="w-[10%]">状态</TableHead>
              <TableHead scope="col" className="w-[12%]">流量</TableHead>
              <TableHead scope="col" className="w-[8%]">价格</TableHead>
              <TableHead scope="col" className="w-[9%]">到期</TableHead>
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
                {node.offline_only && <div className="mt-1 [&_button]:h-auto [&_button]:min-h-8 [&_button]:max-w-full [&_button]:px-1.5 [&_button]:whitespace-normal"><OfflineUpgradeButton node={node} /></div>}
              </TableCell>
              <TableCell><NodeAddresses node={node} copy={copy} /></TableCell>
              <TableCell><NodeStatus node={node} /></TableCell>
              <TableCell><NodeTraffic node={node} /></TableCell>
              <TableCell><NodePrice node={node} /></TableCell>
              <TableCell className="tnum">{expiry(node)}</TableCell>
              <TableCell className="pr-3">{rowActions(node, index, false)}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </div>
    </>}
  </Card>
}
