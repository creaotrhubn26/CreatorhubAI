import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// jsdom has no EventSource. The IDE shell (AppShell) mounts useSessionEvents
// on every route now (not just the session screen), so any test rendering
// AppShell needs a harmless stand-in — it never actually connects.
if (typeof globalThis.EventSource === "undefined") {
  class NoopEventSource {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor(_url: string) {}
    close() {}
  }
  globalThis.EventSource = NoopEventSource as unknown as typeof EventSource;
}
