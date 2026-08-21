export interface Turn {
  id: number;
  question: string;
  askedAt: string;
  answer?: string;
  error?: string;
  answeredAt?: string;
}

function storageKey(sessionId: string): string {
  return `glimmer.assistant.${sessionId}`;
}

// sessionStorage can throw (quota, disabled cookies, private-mode Safari) —
// persistence is best-effort, never a hard requirement for the assistant to
// keep working, so both directions swallow failures.
export function loadTurns(sessionId: string): Turn[] {
  try {
    const raw = sessionStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTurns(sessionId: string, turns: Turn[]): void {
  try {
    sessionStorage.setItem(storageKey(sessionId), JSON.stringify(turns));
  } catch {
    // best-effort — see comment above
  }
}
