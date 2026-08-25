import { createContext, useContext, useEffect, useState } from "react";
import type { GlimmerEvent } from "@glimmer/shared";
import { isGlimmerEvent } from "@glimmer/shared";
import { API_BASE } from "./client";

// AppShell is the single mount point for this hook (one EventSource per
// active session). Routed screens read the same stream via this context
// instead of calling useSessionEvents again, which would open a second
// connection to the same /api/sessions/:id/events endpoint.
//
// lastEventAt is the max of the events' own `timestamp` fields (epoch ms),
// computed in AppShell — deterministic and immune to SSE backlog replay on
// reconnect, never a receipt-time guess. null until the first event lands.
export interface SessionEventsState {
  events: GlimmerEvent[];
  lastEventAt: number | null;
}

export const SessionEventsContext = createContext<SessionEventsState>({
  events: [],
  lastEventAt: null,
});
export function useSharedSessionEvents(): GlimmerEvent[] {
  return useContext(SessionEventsContext).events;
}
export function useSharedLastEventAt(): number | null {
  return useContext(SessionEventsContext).lastEventAt;
}

export function useSessionEvents(sessionId: string): GlimmerEvent[] {
  const [events, setEvents] = useState<GlimmerEvent[]>([]);

  useEffect(() => {
    setEvents([]);
    // No session selected (e.g. the IDE shell mounts this hook on every
    // route, not just a session view) — nothing to stream, and an empty id
    // would 404 against `/api/sessions//events` and auto-reconnect forever.
    if (!sessionId) return;
    const source = new EventSource(`${API_BASE}/api/sessions/${sessionId}/events?stream=1`);
    source.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        if (isGlimmerEvent(parsed)) setEvents((prev) => [...prev, parsed]);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => source.close();
  }, [sessionId]);

  return events;
}
