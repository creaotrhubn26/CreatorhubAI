// Theme preference: persisted user choice + the system-media-query wiring
// that only matters when they picked "system". Dark is the product's
// default identity — "system" is offered, never defaulted to.
const STORAGE_KEY = "glimmer.theme";

export type ThemePreference = "dark" | "light" | "system";

function isThemePreference(v: unknown): v is ThemePreference {
  return v === "dark" || v === "light" || v === "system";
}

export function getTheme(): ThemePreference {
  try {
    const v = window.localStorage?.getItem(STORAGE_KEY);
    if (isThemePreference(v)) return v;
  } catch {
    /* storage unavailable (private mode, disabled, or no window) */
  }
  return "dark";
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): "dark" | "light" {
  return pref === "system" ? (systemPrefersDark ? "dark" : "light") : pref;
}

function systemPrefersDark(): boolean {
  // jsdom (tests) may not implement matchMedia at all — feature-detect
  // rather than assume it exists.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

let mediaQuery: MediaQueryList | null = null;
let mediaListener: (() => void) | null = null;

function teardownSystemListener(): void {
  if (mediaQuery && mediaListener) mediaQuery.removeEventListener("change", mediaListener);
  mediaQuery = null;
  mediaListener = null;
}

function applyToDocument(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(pref, systemPrefersDark());
}

// Only listens to prefers-color-scheme while pref === "system" — any other
// preference tears the listener down so it can't relitigate a fixed choice.
function setupSystemListener(pref: ThemePreference): void {
  teardownSystemListener();
  if (pref !== "system") return;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaListener = () => applyToDocument("system");
  mediaQuery.addEventListener("change", mediaListener);
}

export function setTheme(pref: ThemePreference): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, pref);
  } catch {
    /* storage unavailable — preference just won't persist across reloads */
  }
  applyToDocument(pref);
  setupSystemListener(pref);
}

// Call once at startup (main.tsx) to apply the persisted/default preference
// and arm the system-preference listener if applicable.
export function initTheme(): void {
  const pref = getTheme();
  applyToDocument(pref);
  setupSystemListener(pref);
}
