import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api"
import { trackRestore, useRestoreOperation } from "@/lib/restore"

const LABELS: Record<string, string> = {
  validating: "正在校验备份，请勿重复导入。",
  applying: "正在应用备份。即使连接中断，也会继续查询最终结果。",
  complete: "数据库已恢复，恢复前副本已保留。所有登录已撤销，请重新登录。",
  failed: "恢复失败，请检查服务日志与恢复前副本后再操作。",
  interrupted: "服务在恢复期间重启，结果待核实。请检查数据库和恢复前副本。",
  unknown: "恢复结果待确认，请恢复网络后查询。请勿重复导入。",
}
const terminal = (phase: string) => ["complete", "failed", "interrupted"].includes(phase)

// Lives outside the authenticated panel: restoring revokes the session before
// its final status may arrive, and refreshing must not lose the operation ID.
export function RestoreStatus() {
  const operation = useRestoreOperation()
  const [result, setResult] = useState({ id: "", phase: "" })
  const inFlight = useRef(false)
  const phase = result.id === operation ? result.phase : ""
  const check = useCallback(async () => {
    if (!operation || inFlight.current) return
    inFlight.current = true
    try {
      const next = await api<{ phase: string }>(`/db/restore/${operation}`, { signal: AbortSignal.timeout(10_000) })
      setResult({ id: operation, phase: next.phase in LABELS ? next.phase : "unknown" })
      if (next.phase === "complete") dispatchEvent(new Event("cmonitor:restore-complete"))
    } catch { setResult({ id: operation, phase: "unknown" }) }
    finally { inFlight.current = false }
  }, [operation])

  useEffect(() => {
    if (!operation || terminal(phase)) return
    queueMicrotask(check)
    const timer = setInterval(check, 2000)
    return () => clearInterval(timer)
  }, [operation, phase, check])

  if (!operation) return null
  return (
    <div role="status" aria-label="备份恢复结果" className="mx-auto max-w-[1600px] px-4 pt-4">
      <div className="rounded-lg border bg-background p-4 text-sm">
        <p>{LABELS[phase] || "正在查询备份恢复结果…"}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {!terminal(phase) && <Button size="sm" variant="outline" onClick={check}>查询恢复结果</Button>}
          {(terminal(phase) || phase === "unknown") && <Button size="sm" variant="ghost" onClick={() => {
            if (phase !== "unknown" || window.confirm("尚无法确认恢复结果。请先核实数据库与服务日志；关闭提示不会停止或回滚恢复。确认关闭？")) trackRestore("")
          }}>{phase === "complete" ? "关闭恢复提示" : "已核实，关闭提示"}</Button>}
        </div>
      </div>
    </div>
  )
}
