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

// Node 26 ships an experimental localStorage that is DISABLED without
// --localstorage-file, and jsdom defers to it — so the composer-draft tests
// lost their storage on the Node upgrade (the long-standing "sporadic"
// web-test flake). A deterministic in-memory shim restores the contract.
const storageBroken = (() => {
  try {
    globalThis.localStorage.setItem("__probe__", "1");
    globalThis.localStorage.removeItem("__probe__");
    return false;
  } catch {
    return true;
  }
})();
if (storageBroken) {
  const backing = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (key) => (backing.has(key) ? backing.get(key)! : null),
    key: (index) => [...backing.keys()][index] ?? null,
    removeItem: (key) => void backing.delete(key),
    setItem: (key, value) => void backing.set(key, String(value)),
  };
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true });
  Object.defineProperty(window, "localStorage", { value: shim, configurable: true });
}
