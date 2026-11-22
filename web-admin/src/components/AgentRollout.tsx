import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { api, type Node } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

type Batch = { id: number; target: string; status: string; reason: string; items: {node: number; status: string}[] }
type Overview = { target: string; nodes: Record<number, string>; batch: Batch | null }
const labels: Record<string,string> = { ready: '可升级', offline: '离线', unenrolled: '需启用升级器', plaintext: 'HTTP 或未确认 HTTPS · 离线升级', current: '已达到目标版本', unknown: '版本未知', no_report: '等待指标上报' }
const phases: Record<string,string> = { ready: '等待节点领取', queued: '等待首台验证', waiting: '下载并校验', installing: '节点正在重启服务', observing: '等待新版重新上报', verified: '已恢复上报', failed: '未通过验证', skipped: '已跳过安装', unconfirmed: '结果待核实' }

const maxBatchSize = 100

export function AgentRollout({nodes}: {nodes: Node[]}) {
  const [open,setOpen] = useState(false)
  const [state,setState] = useState<Overview | null>(null)
  const [chosen,setChosen] = useState<number[]>([])
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const [revision,setRevision] = useState(0)
  useEffect(() => {
    if (!open) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const data = await api<Overview>('/agent-upgrades')
        if (active) setState(data)
      } catch (e) { if (active) {setState(null); setError((e as Error).message)} }
      if (active) timer = setTimeout(refresh, 3000)
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  },[open, revision])
  async function start() {
    setBusy(true); setError('')
    try {
      await api('/agent-upgrades', {method:'POST',body:JSON.stringify({nodes:chosen})})
      setChosen([]); setState(null)
    } catch(e) {setError((e as Error).message)}
    finally {setBusy(false); setRevision(n=>n+1)}
  }
  const name = (id:number) => nodes.find(n=>n.id===id)?.name ?? `节点 #${id}`
  const batch = state?.batch
  const eligible = nodes.filter(n => state?.nodes[n.id] === 'ready').map(n => n.id)
  const selectionStale = chosen.some(id => !eligible.includes(id))
  const bulkCount = Math.min(eligible.length, maxBatchSize)
  function selectEligible() {
    setChosen(ids => [...new Set([...ids.filter(id => eligible.includes(id)), ...eligible])].slice(0, maxBatchSize))
  }
  const locked = busy || batch?.status === 'running'
  return <Dialog open={open} onOpenChange={next=>{setOpen(next); if(next){setError('');setState(null);setChosen([])}}}>
    <DialogTrigger asChild><Button variant="outline"><Download/>升级 Agent</Button></DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>批量升级 Agent</DialogTitle><DialogDescription>首台以目标版本恢复上报后，其余已选节点将并行升级。</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!state && <p role="status">正在读取节点状态…</p>}
      {batch && <section className="space-y-2 rounded-lg border p-3 text-sm" aria-label="最近批次">
        <p className="font-medium" role="status">批次 #{batch.id} · v{batch.target} · {batch.status==='done'?'全部完成':batch.status==='stopped'?'已停止':batch.reason?'等待已开始的节点完成':'进行中'} · {batch.items.filter(i=>i.status==='verified').length}/{batch.items.length}</p>
        {batch.reason && <p>{batch.reason}</p>}
        <ol className="max-h-64 overflow-y-auto">{batch.items.map((item,i)=><li key={item.node} className="flex justify-between gap-3 py-1"><span>{i===0?'首台 · ':''}{name(item.node)}</span><span>{phases[item.status]}</span></li>)}</ol>
      </section>}
      {state && !locked && <fieldset className="space-y-1"><legend className="mb-2 font-medium">选择节点 · 目标 v{state.target}</legend>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={!bulkCount || (!selectionStale && chosen.length===bulkCount)} onClick={selectEligible}>
            {eligible.length > maxBatchSize ? `选满 ${maxBatchSize} 台` : '全选可升级节点'}
          </Button>
          <Button type="button" variant="ghost" disabled={!chosen.length} onClick={()=>setChosen([])}>清空选择</Button>
        </div>
        {selectionStale && <p role="alert" className="text-sm text-destructive">所选节点状态已变化，请重新选择可升级节点。</p>}
        <div className="max-h-64 overflow-auto">{nodes.map(n=>{const reason=state.nodes[n.id]??'offline';return <label key={n.id} className="flex min-h-11 items-center gap-3 border-b py-1.5 text-sm">
          <input type="checkbox" disabled={!chosen.includes(n.id) && (reason!=='ready' || chosen.length >= maxBatchSize)} checked={chosen.includes(n.id)} onChange={e=>setChosen(ids=>e.target.checked?[...ids,n.id]:ids.filter(id=>id!==n.id))}/>
          <span className="min-w-0 flex-1 break-words">{n.name}</span><span className="text-right text-xs text-muted-foreground">v{n.agent_version||'?'} · {labels[reason]}</span>
        </label>})}</div>
        {Object.values(state.nodes).includes('unenrolled') && <details className="pt-2 text-sm"><summary className="cursor-pointer">如何启用节点升级器</summary><p className="mt-2">在已安装 Agent 的 HTTPS 节点上以 root 下载本 Hub 的 <code>/agent-updater.py</code>，运行 <code>python3 -I agent-updater.py enable</code>。首次心跳后即可勾选。</p></details>}
      </fieldset>}
      {state && !locked && <DialogFooter><div className="mr-auto self-center text-sm">{chosen.length?`首台验证：${name(chosen[0])}`:'先勾选要验证的首台节点'}</div><Button disabled={!chosen.length || selectionStale} onClick={start}>开始升级{chosen.length?`（${chosen.length} 台）`:''}</Button></DialogFooter>}
    </DialogContent>
  </Dialog>
}
