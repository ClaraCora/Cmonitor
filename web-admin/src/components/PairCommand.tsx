import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api, ApiError } from '@/lib/api'

type PairResponse = { command: string; expires_at: number }
type Issued = { expires: number; command?: string; copied: boolean }
const expiryTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function PairCommand({ nodeId, name }: { nodeId: number; name: string }) {
  const [issued, setIssued] = useState<Issued | null>(null)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const request = useRef<AbortController | null>(null)
  const manual = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    function clearOnHide() {
      if (!document.hidden) return
      request.current?.abort()
      request.current = null
      setPending(false)
      setIssued(null)
      setMessage('')
    }
    document.addEventListener('visibilitychange', clearOnHide)
    return () => {
      document.removeEventListener('visibilitychange', clearOnHide)
      request.current?.abort()
      request.current = null
    }
  }, [])

  const expires = issued?.expires
  useEffect(() => {
    if (!expires) return
    const timer = setTimeout(() => {
      setIssued(null)
      setMessage('配对命令已过期，可以重新生成。')
    }, Math.max(0, expires * 1000 - Date.now()))
    return () => clearTimeout(timer)
  }, [expires])

  async function issue() {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    setIssued(null)
    setMessage('')
    try {
      const loading = api<PairResponse>(`/nodes/${nodeId}/maintenance/pair-command`, {
        method: 'POST', cache: 'no-store', signal: controller.signal,
      }).then(result => {
        if (controller.signal.aborted || !result?.command?.trim() ||
          !Number.isSafeInteger(result.expires_at) || result.expires_at * 1000 <= Date.now()) {
          throw new Error('pairing command unavailable')
        }
        return result
      })
      // Start the clipboard operation during the click for browsers that
      // require user activation. Its text comes from this single issuance.
      const clipboard = navigator.clipboard
      let writing: Promise<boolean> | undefined
      if (clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const content = loading.then(result => new Blob([result.command], { type: 'text/plain' }))
        void content.catch(() => {}) // Some browsers deny access before reading the item.
        try {
          writing = clipboard.write([new ClipboardItem({ 'text/plain': content })]).then(() => true, () => false)
        } catch {
          // Older clipboard implementations still support plain text.
        }
      }
      const result = await loading
      if (controller.signal.aborted) return
      const copied = writing ? await writing : await clipboard?.writeText?.(result.command).then(() => true, () => false) ?? false
      if (!controller.signal.aborted && result.expires_at * 1000 > Date.now()) {
        setIssued({ expires: result.expires_at, copied, command: copied ? undefined : result.command })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof ApiError && error.status === 403
          ? '当前会话无法生成配对命令。请重新登录管理员账户，再确认节点状态。'
          : '未能确认配对命令。请核对节点状态后重新生成。')
      }
    } finally {
      if (request.current === controller) {
        request.current = null
        setPending(false)
      }
    }
  }

  function selectCommand() {
    manual.current?.focus()
    manual.current?.select()
  }

  return <div className="space-y-2 rounded-md border p-3">
    <p className="text-sm">通过独立 SSH 或 Netcatty 登录「{name}」，以 root 身份执行一次。命令 10 分钟有效，重新生成会使旧命令失效。</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" disabled={pending} onClick={issue}>
        <Copy aria-hidden="true" />{pending ? '正在生成…' : issued ? '重新生成并复制' : '复制一次性配对命令'}
      </Button>
      {issued?.command && <Button type="button" size="sm" variant="outline" onClick={() => setIssued({ expires: issued.expires, copied: false })}>隐藏并清除命令</Button>}
    </div>
    {message && <p role="status" className="text-xs">{message}</p>}
    {issued && <p role="status" className="text-xs text-muted-foreground">
      {issued.copied ? '已复制。' : issued.command ? '浏览器无法写入剪贴板，请手动复制完整命令。' : '页面上的命令已清除。'}
      失效时间 {expiryTime.format(issued.expires * 1000)}。
    </p>}
    {issued?.command && <div className="space-y-1.5">
      <textarea ref={manual} aria-label={`${name} 的一次性配对命令`} readOnly spellCheck={false} autoComplete="off"
        className="block h-28 w-full resize-y rounded-md border bg-muted/40 p-2 font-mono text-xs" value={issued.command} />
      <Button type="button" size="sm" variant="outline" onClick={selectCommand}>全选配对命令</Button>
    </div>}
    <p className="text-xs text-muted-foreground">执行后，在这里核对升级器 v2 的最近心跳。</p>
  </div>
}
