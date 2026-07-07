/**
 * Per-session record of manual title edits. Keyed by stored session id (not
 * runtime session id) because June's session list and persistence use the
 * durable id, while live Hermes processes may resume under a different
 * runtime id. Absence means auto-titling is allowed, so sessions from before
 * this record existed fall back to the safe default.
 *
 * localStorage (not the backend) because the runtime's session store is
 * machine-local too, and the map must be readable synchronously before the
 * title suggester decides whether a loaded title is replaceable.
 */

const STORAGE_KEY = "june.agent.manuallyTitledSessions";

function readStore(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, true>;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, true>) {
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore; worst case a manually titled session can be auto-titled again.
  }
}

/** Whether this session has an explicit user-authored title. */
export function sessionManuallyTitled(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return readStore()[sessionId] === true;
}

export function rememberSessionManuallyTitled(sessionId: string) {
  const store = readStore();
  store[sessionId] = true;
  writeStore(store);
}
