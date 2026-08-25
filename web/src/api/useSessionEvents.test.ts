import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionEvents } from "./useSessionEvents";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {}
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

afterEach(() => {
  FakeEventSource.instances.length = 0;
});

describe("useSessionEvents", () => {
  it("appends parsed events as they arrive over SSE", () => {
    (globalThis as any).EventSource = FakeEventSource;
    const { result } = renderHook(() => useSessionEvents("s1"));
    expect(result.current).toEqual([]);
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain("/api/sessions/s1/events?stream=1");
    act(() =>
      es.emit({
        id: "e1",
        sessionId: "s1",
        timestamp: "t",
        type: "tool_started",
        tool: "read_file",
        args: {},
      }),
    );
    expect(result.current).toHaveLength(1);
    expect(result.current[0].type).toBe("tool_started");
  });
});
