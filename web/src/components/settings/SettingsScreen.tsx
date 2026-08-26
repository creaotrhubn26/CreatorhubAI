import { useState } from "react";
import { getTheme, setTheme, type ThemePreference } from "../../state/themePreference";
import { tauriGlobal } from "../../state/desktopNotify";
import { ModelRegistrySettings } from "./ModelRegistrySettings";
import { CliIntegrationsSettings } from "./CliIntegrationsSettings";
import { DeveloperClientsSettings } from "./DeveloperClientsSettings";
import { McpIntegrationsSettings } from "./McpIntegrationsSettings";

type PermissionState = "granted" | "denied" | "not asked";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

// Deterministic fact only — never inferred, never auto-requested.
// Notification is absent in some webviews/tests, so "not asked" also
// covers "unsupported here" rather than throwing.
function currentPermission(): PermissionState {
  if (!("Notification" in window)) return "not asked";
  return Notification.permission === "granted" || Notification.permission === "denied"
    ? Notification.permission
    : "not asked";
}

export function SettingsScreen() {
  const [permission, setPermission] = useState<PermissionState>(currentPermission);
  const supported = "Notification" in window;
  const [theme, setThemeState] = useState<ThemePreference>(getTheme);

  function chooseTheme(t: ThemePreference) {
    setTheme(t);
    setThemeState(t);
  }

  async function enableNotifications() {
    if (!supported) return;
    await Notification.requestPermission();
    setPermission(currentPermission());
  }

  return (
    <div>
      <h1>Permissions</h1>
      <p>
        Enforced by the Glimmer backend, not this UI (spec §21). This screen mirrors the default
        policy.
      </p>
      <ul>
        <li>Green — repository reads, file search, git status/diff, typecheck, tests</li>
        <li>
          Yellow — dependency modifications, migrations, external network, broad scope expansion
        </li>
        <li>
          Red — git push, deploy, force reset, repository deletion, credential extraction (blocked
          by default)
        </li>
      </ul>

      <h2
        style={{
          fontSize: "var(--fs-h1)",
          fontWeight: 600,
          textTransform: "none",
          letterSpacing: "-0.01em",
          color: "inherit",
        }}
      >
        Appearance
      </h2>
      <div role="tablist" aria-label="Theme">
        {THEME_OPTIONS.map(({ value, label }) => (
          <button key={value} aria-pressed={theme === value} onClick={() => chooseTheme(value)}>
            {label}
          </button>
        ))}
      </div>

      <ModelRegistrySettings />

      <CliIntegrationsSettings />

      <DeveloperClientsSettings />

      <McpIntegrationsSettings />

      <h2
        style={{
          fontSize: "var(--fs-h1)",
          fontWeight: 600,
          textTransform: "none",
          letterSpacing: "-0.01em",
          color: "inherit",
        }}
      >
        Notifications
      </h2>
      {tauriGlobal() ? (
        // Desktop app: notifications go through the OS via the Tauri shell;
        // macOS shows its own per-app permission prompt on first delivery.
        <p>
          Completion notifications: handled by the desktop app (macOS asks on first notification)
        </p>
      ) : (
        <>
          <p>
            Completion notifications: {permission}
            {!supported && " (unsupported in this environment)"}
          </p>
          <button onClick={enableNotifications} disabled={!supported || permission === "granted"}>
            Enable completion notifications
          </button>
        </>
      )}
    </div>
  );
}
