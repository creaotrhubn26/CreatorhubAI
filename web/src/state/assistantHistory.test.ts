import { describe, it, expect } from "vitest";
import { loadTurns, saveTurns, type Turn } from "./assistantHistory";

function fakeStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
    ...overrides,
  } as Storage;
}

function stub(storage: Storage) {
  Object.defineProperty(window, "sessionStorage", { value: storage, configurable: true });
}

describe("assistantHistory", () => {
  it("loadTurns returns [] when nothing stored for this session", () => {
    stub(fakeStorage());
    expect(loadTurns("s1")).toEqual([]);
  });

  it("round-trips turns through saveTurns/loadTurns under a per-session key", () => {
    stub(fakeStorage());
    const turns: Turn[] = [{ id: 1, question: "why?", askedAt: "t", answer: "because" }];
    saveTurns("s1", turns);
    expect(loadTurns("s1")).toEqual(turns);
    expect(loadTurns("s2")).toEqual([]); // different session id, different key — no cross-talk
  });

  it("persists a pending/unanswered turn as-is, never fabricating an answer", () => {
    stub(fakeStorage());
    const turns: Turn[] = [{ id: 1, question: "why?", askedAt: "t" }];
    saveTurns("s1", turns);
    expect(loadTurns("s1")).toEqual(turns);
  });

  it("persists an errored turn's error state", () => {
    stub(fakeStorage());
    const turns: Turn[] = [{ id: 1, question: "why?", askedAt: "t", error: "Unavailable — the assistant could not answer that." }];
    saveTurns("s1", turns);
    expect(loadTurns("s1")).toEqual(turns);
  });

  it("loadTurns returns [] when storage.getItem throws", () => {
    stub(fakeStorage({ getItem: () => { throw new Error("blocked"); } }));
    expect(loadTurns("s1")).toEqual([]);
  });

  it("saveTurns swallows a storage.setItem throw instead of crashing", () => {
    stub(fakeStorage({ setItem: () => { throw new Error("quota exceeded"); } }));
    expect(() => saveTurns("s1", [])).not.toThrow();
  });

  it("loadTurns returns [] for malformed JSON instead of throwing", () => {
    const storage = fakeStorage();
    storage.setItem("glimmer.assistant.s1", "not json {{{");
    stub(storage);
    expect(loadTurns("s1")).toEqual([]);
  });

  it("loadTurns returns [] when the stored value isn't an array", () => {
    const storage = fakeStorage();
    storage.setItem("glimmer.assistant.s1", JSON.stringify({ not: "an array" }));
    stub(storage);
    expect(loadTurns("s1")).toEqual([]);
  });
});
