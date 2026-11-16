import { useEffect, useState } from "react"

let memoryOperation = ""
const KEY = "cmonitor-restore"
const EVENT = "cmonitor:restore"

export function trackRestore(id: string) {
  memoryOperation = id
  try {
    if (id) sessionStorage.setItem(KEY, id)
    else sessionStorage.removeItem(KEY)
  } catch { /* Current-page tracking works without persistence. */ }
  dispatchEvent(new Event(EVENT))
}

export function useRestoreOperation() {
  const [operation, setOperation] = useState(() => readOperation())
  useEffect(() => {
    const sync = () => setOperation(readOperation())
    addEventListener(EVENT, sync)
    return () => removeEventListener(EVENT, sync)
  }, [])
  return operation
}

function readOperation() {
  try { return sessionStorage.getItem(KEY) || memoryOperation } catch { return memoryOperation }
}
