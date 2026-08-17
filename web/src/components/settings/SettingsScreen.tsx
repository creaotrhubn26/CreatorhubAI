export function SettingsScreen() {
  return (
    <div>
      <h1>Permissions</h1>
      <p>Enforced by the Glimmer backend, not this UI (spec §21). This screen mirrors the default policy.</p>
      <ul>
        <li>Green — repository reads, file search, git status/diff, typecheck, tests</li>
        <li>Yellow — dependency modifications, migrations, external network, broad scope expansion</li>
        <li>Red — git push, deploy, force reset, repository deletion, credential extraction (blocked by default)</li>
      </ul>
    </div>
  );
}
