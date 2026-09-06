# Remote-session E2E drivers

Live proofs for the coordinator-supervised GPU execution chain (milestone
R3). Each run starts real paid compute through the installed app's own
APIs (`/api/compute/*`, `/api/sessions/*`), so:

- **Cost**: roughly $0.05–$0.15 per run (A100 at ~$1.59/h for 2–6 minutes).
- **Cleanup**: the driver always requests compute stop in its `finally`
  block and asserts the provider lists zero Pods afterwards.
- **Prerequisites**: the app bundle must carry the current gateway
  (`src-tauri/scripts/prepare-gateway.sh` + rsync into the .app +
  `codesign -f -s -`), and `~/.muse-glimmer/compute.json` must pin the
  intended image digest.

## remote-session-e2e.mjs

```
node scripts/remote-e2e/remote-session-e2e.mjs --worktree <path> \
    [--mode inspect|implement|verify] [--kill-mid-run]
```

- `--worktree`: a CLEAN git worktree on a `glimmer/*` branch. The
  implement/verify modes create `REMOTE_NOTE.md` remotely, assert the
  change lands locally, then restore the worktree.
- `--mode inspect` (default): read-only session, expects `completed`.
- `--mode implement`: remote change lands via the checkpoint patch.
- `--mode verify`: adds `verification: ["frontend-typecheck"]`; the Pod
  installs dependencies (`npm ci`, cache on the network volume) and runs
  the full verification ladder. Expects `verified` when the suite is green.
  The worktree needs `frontend/package-lock.json` with a `typecheck`
  script for the contract check to pass.
- `--kill-mid-run`: SIGKILLs the whole app 45s into the run and relaunches
  it, proving startup reconciliation reattaches and finishes the session.

## watch-coordinator-pod.mjs

Polls the coordinator's active job for its Pod and samples the Pod's
system+container logs every 10s until the Pod disappears. Run it alongside
a driver when debugging Pod-side behavior:

```
node scripts/remote-e2e/watch-coordinator-pod.mjs > /tmp/podwatch.log 2>&1 &
```

It is self-contained (bundled coordinator helper scripts live next to it).
