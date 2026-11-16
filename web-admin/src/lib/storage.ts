/** Preferences must keep working when browser persistence is unavailable. */
export function readPreference(key: string, session = false): string | null {
  try { return (session ? sessionStorage : localStorage).getItem(key) } catch { return null }
}
export function savePreference(key: string, value: string, session = false): void {
  try { (session ? sessionStorage : localStorage).setItem(key, value) } catch { /* React state remains the fallback. */ }
}
