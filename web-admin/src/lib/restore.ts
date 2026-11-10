import { useEffect, useState } from "react"

const KEY = "cmonitor-restore"
const EVENT = "cmonitor:restore"

export function trackRestore(id: string) {
  if (id) sessionStorage.setItem(KEY, id)
  else sessionStorage.removeItem(KEY)
  dispatchEvent(new Event(EVENT))
}

export function useRestoreOperation() {
  const [operation, setOperation] = useState(() => sessionStorage.getItem(KEY) || "")
  useEffect(() => {
    const sync = () => setOperation(sessionStorage.getItem(KEY) || "")
    addEventListener(EVENT, sync)
    return () => removeEventListener(EVENT, sync)
  }, [])
  return operation
}
