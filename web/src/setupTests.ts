import "@testing-library/jest-dom/vitest";

// jsdom has no EventSource. The IDE shell (AppShell) mounts useSessionEvents
// on every route now (not just the session screen), so any test rendering
// AppShell needs a harmless stand-in — it never actually connects.
if (typeof (globalThis as any).EventSource === "undefined") {
  class NoopEventSource {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    constructor(_url: string) {}
    close() {}
  }
  (globalThis as any).EventSource = NoopEventSource;
}
