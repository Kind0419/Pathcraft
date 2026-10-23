/**
 * Storage is not always available.
 *
 * A `file://` document, an iframe without `allow-same-origin`, private mode and
 * "block all cookies" all make `window.localStorage` *throw* on access rather
 * than return null. Reading it from a `useState` initialiser therefore turns a
 * missing preference into a blank page — the whole render dies before anything
 * is painted.
 *
 * These helpers keep preferences a best-effort nicety: if storage is blocked the
 * app just starts with defaults.
 */
function store(): Storage | null {
  try {
    const s = window.localStorage
    // Touch it: some environments expose the object but throw on first use.
    const probe = '__pc__'
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    return null
  }
}

const available = typeof window === 'undefined' ? null : store()

export function readSetting(key: string): string | null {
  if (!available) return null
  try {
    return available.getItem(key)
  } catch {
    return null
  }
}

export function writeSetting(key: string, value: string): void {
  if (!available) return
  try {
    available.setItem(key, value)
  } catch {
    // Quota or a mid-session block; the in-memory state is still correct.
  }
}
