import { useRef, useState } from "react"
import { Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api, type Node } from "@/lib/api"

type Command = { command: string; version: string }

export function OfflineUpgradeButton({ node }: { node: Node }) {
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState<Command | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const text = useRef<HTMLTextAreaElement>(null)

  async function copyCommand() {
    if (busy) return
    setBusy(true)
    try {
      const loading = api<Command>(`/nodes/${node.id}/offline-upgrade-command`, { cache: "no-store" }).then(result => {
        if (!result?.command?.trim() || !result.version) throw new Error("Hub 返回的升级命令不完整")
        return result
      })
      // Safari requires the write to begin during the click, even though the
      // authenticated request must finish before its text is available.
      let writing: Promise<boolean> | undefined
      const clipboard = navigator.clipboard
      if (clipboard?.write && typeof ClipboardItem !== "undefined") {
        const content = loading.then(result => new Blob([result.command], { type: "text/plain" }))
        void content.catch(() => {}) // The browser may refuse the write before reading the item.
        try {
          writing = clipboard.write([new ClipboardItem({ "text/plain": content })]).then(() => true, () => false)
        } catch {
          // Browsers without support for promised items can still write plain text.
        }
      }
      const result = await loading
      const copied = writing ? await writing : await clipboard?.writeText(result.command).then(() => true, () => false)
      if (copied) {
        toast.success(`已复制 ${node.name} 的升级命令`, { description: "请通过独立 SSH 登录该节点，以 root 身份手动执行。" })
      } else {
        setManual(result)
      }
    } catch (error) {
      toast.error("无法获取升级命令", { description: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  function selectText() {
    text.current?.focus()
    text.current?.select()
  }

  return <>
    <Button ref={trigger} type="button" size="sm" variant="outline" className="text-foreground" disabled={busy} onClick={copyCommand}
      title={`复制 ${node.name} 的离线升级命令，在独立 SSH 中执行`}>
      <Copy aria-hidden="true" />{busy ? "正在获取…" : "复制升级命令"}
    </Button>
    {manual && <Dialog open onOpenChange={open => { if (!open) setManual(null) }}>
      <DialogContent className="sm:max-w-xl" onOpenAutoFocus={event => { event.preventDefault(); selectText() }}
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}>
        <DialogHeader>
          <DialogTitle className="break-words">{node.name} · 手动复制升级命令</DialogTitle>
          <DialogDescription>
            浏览器无法写入剪贴板。复制下方完整命令，通过独立 SSH 登录此节点，以 root 身份执行。
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-2 text-sm font-medium">
          <span>Agent v{manual.version.replace(/^v/, "")} 升级命令</span>
          <textarea ref={text} readOnly spellCheck={false} value={manual.command}
            className="block h-32 w-full resize-y rounded-md border bg-muted/40 p-3 font-mono text-xs font-normal leading-relaxed focus-visible:outline-2 focus-visible:outline-ring" />
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setManual(null)}>关闭</Button>
          <Button type="button" onClick={selectText}>全选命令</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </>
}
