import { useState } from "react";

type PermissionState = "granted" | "denied" | "not asked";

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

  async function enableNotifications() {
    if (!supported) return;
    await Notification.requestPermission();
    setPermission(currentPermission());
  }

  return (
    <div>
      <h1>Permissions</h1>
      <p>Enforced by the Glimmer backend, not this UI (spec §21). This screen mirrors the default policy.</p>
      <ul>
        <li>Green — repository reads, file search, git status/diff, typecheck, tests</li>
        <li>Yellow — dependency modifications, migrations, external network, broad scope expansion</li>
        <li>Red — git push, deploy, force reset, repository deletion, credential extraction (blocked by default)</li>
      </ul>

      <h2 style={{ fontSize: "var(--fs-h1)", fontWeight: 600, textTransform: "none", letterSpacing: "-0.01em", color: "inherit" }}>
        Notifications
      </h2>
      <p>
        Completion notifications: {permission}
        {!supported && " (unsupported in this environment)"}
      </p>
      <button onClick={enableNotifications} disabled={!supported || permission === "granted"}>
        Enable completion notifications
      </button>
    </div>
  );
}
