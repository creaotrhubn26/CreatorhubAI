import { describe, it, expect, beforeEach } from "vitest";
import { getTheme, setTheme, resolveTheme } from "./themePreference";

// jsdom in this project's test environment has no real localStorage (see
// setupTests.ts / the `window.localStorage?.` guards used app-wide), so
// getTheme/setTheme's persistence has nothing to round-trip against without
// a fake. Installed fresh before each test to isolate state between them.
class FakeStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return [...this.store.keys()][index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}

describe("resolveTheme", () => {
  it("resolves dark straight through regardless of system preference", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("resolves light straight through regardless of system preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("resolves system to whatever the OS currently prefers", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("getTheme / setTheme", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { value: new FakeStorage(), configurable: true });
  });

  it("defaults to dark when nothing is persisted", () => {
    expect(getTheme()).toBe("dark");
  });

  it("round-trips a stored preference", () => {
    setTheme("light");
    expect(getTheme()).toBe("light");
    setTheme("system");
    expect(getTheme()).toBe("system");
  });

  it("falls back to dark for a corrupt/unknown stored value", () => {
    window.localStorage.setItem("glimmer.theme", "not-a-theme");
    expect(getTheme()).toBe("dark");
  });

  it("survives localStorage being entirely unavailable (private mode, no window)", () => {
    Object.defineProperty(window, "localStorage", { value: undefined, configurable: true });
    expect(() => setTheme("light")).not.toThrow();
    expect(getTheme()).toBe("dark");
  });

  it("applies the resolved theme to document.documentElement.dataset.theme", () => {
    setTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    setTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
