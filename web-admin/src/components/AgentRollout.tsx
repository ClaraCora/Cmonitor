import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { api, ApiError, provisioningSite, type Node } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { OfflineUpgradeButton } from './OfflineUpgradeButton'
import { PairCommand } from './PairCommand'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

type BatchItem = { node: number; status: string; reason?: string; deadline?: number; updated_at?: number }
type Batch = { id: number; target: string; status: string; reason: string; items: BatchItem[] }
type WorkerHeartbeat = { protocol: number; last_seen: number }
type Policy = 'offline_only' | 'paired' | 'unpaired'
type Overview = { target: string; nodes: Record<number, string>; batch: Batch | null; workers?: Record<number, WorkerHeartbeat>; maintenance?: Record<number, Policy> }
const policyLabel: Record<Policy, string> = { offline_only: '仅上报 · 仅离线升级', paired: '已配对维护凭据', unpaired: '待配对维护凭据' }
const labels: Record<string, string> = { ready: '可升级', offline: '离线', unenrolled: '需启用升级器', plaintext: 'HTTP 或未确认 HTTPS · 离线升级', current: '已达到目标版本', unknown: '版本未知', no_report: '等待指标上报' }
const phases: Record<string, string> = {
  ready: '等待节点领取', queued: '等待首台验证', waiting: '下载并校验', installing: '正在安装并重启服务',
  observing: '等待新版重新上报', verified: '已恢复上报', failed: '升级失败', skipped: '已跳过安装',
  unconfirmed: '结果待核实', rollback_pending: '等候升级器领取回滚任务', rolling_back: '正在恢复旧版', rolled_back: '已恢复旧版',
}
const maxBatchSize = 100
const retryableOutcomes = new Set(['failed', 'skipped', 'rolled_back'])
const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

function WorkerInfo({ heartbeat }: { heartbeat?: WorkerHeartbeat }) {
  const known = heartbeat?.protocol === 1 || heartbeat?.protocol === 2
  return <span className="block text-xs leading-relaxed text-muted-foreground">
    {known ? `升级器 v${heartbeat.protocol}` : '升级器协议未记录'}
    {!!heartbeat?.last_seen && <> · 最近心跳 {timeFormat.format(heartbeat.last_seen * 1000)}</>}
  </span>
}

function MaintenanceSettings({ nodes, policies, states, workers, allowPair, refresh }: {
  nodes: Node[]; policies: Record<number, Policy>; states: Record<number, string>
  workers?: Record<number, WorkerHeartbeat>; allowPair: boolean; refresh: () => void
}) {
  const [id, setId] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const selected = nodes.find(node => node.id === Number(id))
  const policy = policies[Number(id)]
  const state = states[Number(id)]
  // The Hub reports these eligibility reasons only after confirming a TLS session.
  const canPair = allowPair && selected?.online && policy === 'unpaired' && !selected.offline_only
    && ['current', 'unenrolled', 'ready', 'unknown', 'no_report'].includes(state)
  const heartbeat = workers?.[Number(id)]
  const recentV2 = heartbeat?.protocol === 2 && heartbeat.last_seen >= Date.now() / 1000 - 120
  async function change(action: 'grant' | 'revoke' | 'offline') {
    if (!id || pending || !policy) return
    const node = nodes.find(n => n.id === Number(id))
    if (!node) return
    if (action !== 'grant' && !window.confirm(action === 'offline'
      ? `将 ${node.name} 固定为仅上报并撤销在线维护权限？`
      : `撤销 ${node.name} 的维护凭据？再次在线升级前需要重新配对。`)) return
    setPending(true)
    setMessage('')
    try {
      const result = await api<{ node?: number; credential?: string }>(`/nodes/${id}/maintenance`, {
        method: 'POST', body: JSON.stringify({ action }),
      })
      if (action === 'grant') {
        if (result.node !== node.id || !result.credential?.startsWith('cmu_')) throw new Error('凭据响应不完整，请重新读取配对状态。')
        const url = URL.createObjectURL(new Blob([JSON.stringify(result)], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `agent-maintenance-node-${node.id}.json`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setMessage('已生成凭据文件。通过 SSH 或 SFTP 放到本节点的 /opt/monitor/agent-maintenance.json，设为 root 所有、权限 0600，再启用升级器。')
      } else {
        setMessage(action === 'offline' ? '已设为仅离线升级。' : '已撤销维护凭据。')
      }
    } catch (error) {
      setMessage((error as Error).message || '操作结果未确认，请刷新后查看。')
    } finally {
      setPending(false)
      refresh()
    }
  }
  return <details className="text-sm" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">管理节点维护凭据</summary>
    <div className="mt-2 space-y-2">
      <select aria-label="维护凭据所属节点" value={id} disabled={pending} onChange={event => { setId(event.target.value); setMessage('') }}
        className="w-full rounded-md border bg-background px-2 py-2">
        <option value="">选择节点</option>
        {nodes.map(node => <option key={node.id} value={node.id}>{node.name} · {policyLabel[policies[node.id]] ?? '未知'}</option>)}
      </select>
      {expanded && canPair && <PairCommand key={selected.id} nodeId={selected.id} name={selected.name} />}
      {policy === 'paired' && <div role="status" className="space-y-1 text-sm">
        <p>{recentV2 ? '已收到升级器 v2 心跳' : '已配对，等待升级器 v2 的新心跳'}</p>
        <WorkerInfo heartbeat={heartbeat} />
      </div>}
      {policy && policy !== 'offline_only' && <div className="flex flex-wrap gap-2">
        {policy === 'unpaired' && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => change('grant')}>下载本节点维护凭据</Button>}
        {policy === 'paired' && <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => change('revoke')}>撤销凭据</Button>}
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => change('offline')}>设为仅离线升级</Button>
      </div>}
      {message && <p role="status" className="break-words text-xs">{message}</p>}
    </div>
  </details>
}

function BatchProgress({ batch, name }: { batch: Batch; name: (id: number) => string }) {
  const counts: Record<string, number> = {}
  for (const item of batch.items) counts[item.status] = (counts[item.status] ?? 0) + 1
  const status = batch.status === 'running'
    ? (batch.reason ? '等待已开始的节点完成' : '进行中')
    : ({ done: '全部完成', stopped: '已停止' }[batch.status] ?? '状态未知')
  return (
    <section aria-label="最近批次" className="min-w-0 space-y-2 rounded-lg border p-3 text-sm">
      <p role="status" className="font-medium">批次 #{batch.id} · v{batch.target} · {status}</p>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>已验证 {counts.verified ?? 0}/{batch.items.length}</span>
        {['failed', 'skipped', 'rolled_back', 'unconfirmed'].filter(key => counts[key]).map(key => (
          <span key={key}>{phases[key]} {counts[key]}</span>
        ))}
      </p>
      {batch.reason && <p className="break-words">{batch.reason}</p>}
      <ol className="max-h-64 divide-y overflow-y-auto border-t">
        {batch.items.map((item, index) => (
          <li key={item.node} className="space-y-1 py-2">
            <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{index === 0 ? '首台 · ' : ''}{name(item.node)}</span>
              <span>{phases[item.status] ?? '未知阶段'}</span>
            </div>
            {item.reason && <p className="break-words text-xs">{item.reason}</p>}
            {(!!item.updated_at || !!item.deadline) && <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {!!item.updated_at && <span>更新于 {timeFormat.format(item.updated_at * 1000)}</span>}
              {!!item.deadline && <span>截止 {timeFormat.format(item.deadline * 1000)}</span>}
            </p>}
          </li>
        ))}
      </ol>
    </section>
  )
}

export function AgentRollout({ nodes, site }: { nodes: Node[]; site: string }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<Overview | null>(null)
  const [fresh, setFresh] = useState(false)
  const [chosen, setChosen] = useState<number[]>([])
  const [readError, setReadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!open || busy) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data = await api<Overview>('/agent-upgrades', { signal: controller.signal })
        if (controller.signal.aborted) return
        setState(data)
        setFresh(true)
        setReadError('')
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) setState(null)
        setReadError((error as Error).message || '网络错误')
        setFresh(false)
      }
      timer = setTimeout(refresh, 3000)
    }
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [open, busy, revision])

  const names = new Map(nodes.map(node => [node.id, node.name]))
  const name = (id: number) => names.get(id) ?? `节点 #${id}`
  const batch = state?.batch
  const eligible = nodes.filter(node => state?.nodes[node.id] === 'ready').map(node => node.id)
  const ready = new Set(eligible)
  const retryNodes = batch?.status === 'stopped' && batch.target === state?.target
    ? batch.items.filter(item => retryableOutcomes.has(item.status) && ready.has(item.node)).map(item => item.node)
    : []
  const selectionStale = chosen.some(id => !ready.has(id))
  const bulkCount = Math.min(eligible.length, maxBatchSize)
  const updaterSite = provisioningSite(site)
  const canChoose = state && batch?.status !== 'running'
  function select(ids: number[]) {
    setChosen(ids)
    setSubmitError('')
  }
  async function start() {
    if (busy || !fresh || !canChoose || !chosen.length || selectionStale) return
    setBusy(true)
    setFresh(false)
    setSubmitError('')
    try {
      await api('/agent-upgrades', { method: 'POST', body: JSON.stringify({ nodes: chosen }) })
      setChosen([])
    } catch (error) {
      // A lost response can mean the new batch already exists. Refresh its
      // status before enabling another submit, and never replay the write.
      setSubmitError(error instanceof ApiError && error.status < 500
        ? error.message
        : '未收到提交确认，请核对最近批次后再操作。')
    } finally {
      setBusy(false)
      setRevision(value => value + 1)
    }
  }
  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      setFresh(false)
      setReadError('')
      setSubmitError('')
      setChosen([])
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild><Button variant="outline"><Download />升级 Agent</Button></DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>批量升级 Agent</DialogTitle>
          <DialogDescription>首台以目标版本恢复上报后，其余已选节点将并行升级。关闭窗口后批次仍会继续。</DialogDescription>
        </DialogHeader>
        {readError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
          <span>{state ? '刷新失败，显示上次读取的状态。' : '无法读取节点状态。'}{readError}</span>
          <Button size="sm" variant="outline" onClick={() => setRevision(value => value + 1)}>重新读取</Button>
        </div>}
        {!fresh && !busy && !readError && <p role="status" className="text-sm text-muted-foreground">{state ? '正在更新上次读取的状态…' : '正在读取节点状态…'}</p>}
        {submitError && <p role="alert" className="text-sm text-destructive">{submitError}</p>}
        {batch && <BatchProgress batch={batch} name={name} />}
        {state && !canChoose && <details className="text-sm">
          <summary className="cursor-pointer font-medium">查看各节点升级器</summary>
          <ul className="mt-2 max-h-64 divide-y overflow-y-auto">
            {nodes.map(node => <li key={node.id} className="py-2">
              <span className="[overflow-wrap:anywhere]">{node.name}</span>
              <WorkerInfo heartbeat={state.workers?.[node.id]} />
              {state.maintenance?.[node.id] === 'offline_only' && <div className="mt-1"><OfflineUpgradeButton node={node} /></div>}
            </li>)}
          </ul>
        </details>}
        {canChoose && <fieldset disabled={!fresh || busy} className="min-w-0 space-y-2">
          <legend className="mb-2 font-medium">选择节点 · 目标 v{state.target}</legend>
          <div className="flex flex-wrap items-center gap-2">
            {retryNodes.length > 0 && <Button type="button" variant="outline" onClick={() => select(retryNodes)}>
              选择可重试节点（{retryNodes.length} 台）
            </Button>}
            <Button type="button" variant="outline" disabled={!bulkCount || (!selectionStale && chosen.length === bulkCount)}
              onClick={() => select([...new Set([...chosen.filter(id => ready.has(id)), ...eligible])].slice(0, maxBatchSize))}>
              {eligible.length > maxBatchSize ? `选满 ${maxBatchSize} 台` : '全选可升级节点'}
            </Button>
            <Button type="button" variant="ghost" disabled={!chosen.length} onClick={() => select([])}>清空选择</Button>
          </div>
          {selectionStale && <p role="alert" className="text-sm text-destructive">所选节点状态已变化，请重新选择可升级节点。</p>}
          <div className="max-h-64 overflow-y-auto">
            {nodes.map(node => {
              const reason = state.nodes[node.id] ?? 'offline'
              const selected = chosen.includes(node.id)
              return <div key={node.id} className="border-b py-2">
                <label className="grid min-h-7 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 text-sm">
                <input type="checkbox" disabled={!selected && (reason !== 'ready' || chosen.length >= maxBatchSize)} checked={selected}
                  onChange={() => select(selected ? chosen.filter(id => id !== node.id) : [...chosen, node.id])} />
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{node.name}</span>
                <span className="col-start-2 text-xs leading-relaxed text-muted-foreground">Agent v{node.agent_version || '?'} · {labels[reason] ?? '状态未知'}
                  <WorkerInfo heartbeat={state.workers?.[node.id]} />
                </span>
                </label>
                {state.maintenance?.[node.id] === 'offline_only' && <div className="mt-1 pl-6"><OfflineUpgradeButton node={node} /></div>}
              </div>
            })}
          </div>
        </fieldset>}
        {updaterSite && canChoose && fresh && state.maintenance && <MaintenanceSettings
          nodes={nodes} policies={state.maintenance} states={state.nodes} workers={state.workers}
          allowPair={provisioningSite(location.origin) === updaterSite} refresh={() => setRevision(value => value + 1)} />}
        {updaterSite && state && <details className="text-sm">
          <summary className="cursor-pointer">在已有 HTTPS 节点上启用或修复升级器</summary>
          <p className="mt-2 text-muted-foreground">先通过 SSH 或 SFTP 将本节点的维护凭据放到位，再以 root 执行。完成后核对升级器的最近心跳。</p>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg border p-3 text-xs select-all">{`curl --proto '=https' -fsS ${updaterSite}/install.sh | sh -s -- --updater-only`}</pre>
        </details>}
        {canChoose && <DialogFooter>
          <span className="mr-auto min-w-0 self-center text-sm [overflow-wrap:anywhere]">{chosen.length ? `首台验证：${name(chosen[0])}` : '先勾选要验证的首台节点'}</span>
          <Button disabled={!fresh || busy || !chosen.length || selectionStale} onClick={start}>
            {busy ? '正在提交…' : `开始升级${chosen.length ? `（${chosen.length} 台）` : ''}`}
          </Button>
        </DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
