import { useEffect, useState } from "react";
import type { GlimmerEvent } from "@glimmer/shared";
import { isGlimmerEvent } from "@glimmer/shared";
import { API_BASE } from "./client";

export function useSessionEvents(sessionId: string): GlimmerEvent[] {
  const [events, setEvents] = useState<GlimmerEvent[]>([]);

  useEffect(() => {
    setEvents([]);
    const source = new EventSource(`${API_BASE}/api/sessions/${sessionId}/events?stream=1`);
    source.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        if (isGlimmerEvent(parsed)) setEvents((prev) => [...prev, parsed]);
      } catch { /* ignore malformed frame */ }
    };
    return () => source.close();
  }, [sessionId]);

  return events;
}
