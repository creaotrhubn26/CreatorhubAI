# ADR-0002: Verification ownership — one state-driven write freeze, not CreatorHub-specific typecheck governance

**Status:** Accepted
**Date:** 2026-08-17
**Related:** Task 6 / R3 (canonical `GlimmerSessionStatus` vocabulary, `glimmer-v2.py`), Task 7 / R5 (this task)

## Context

`glimmer-engineer.py` is the untrusted-model-facing agent loop. `glimmer-v2.py`
is the trusted wrapper that invokes it as a subprocess, then runs its own
authoritative post-edit verification (typecheck/lint/test/build, chosen from
the real repo map) once the subprocess returns, and records the result as
`manifest["state"]` using the canonical 14-value `GlimmerSessionStatus`
vocabulary (`preflight`, `verified`, `blocked`, `failed`, ...).

Before this task, `glimmer-engineer.py` *also* carried its own,
CreatorHub-frontend-specific verification governance, independent of v2:

- `is_full_frontend_typecheck_command` — recognized the exact command
  `npm --prefix frontend run typecheck` (and equivalent `--prefix` forms)
  by resolving the `--prefix` value against `workspace/frontend`.
- `frontend_typecheck_guard_decision` — allowed that one command once
  before the first edit ("diagnostic") and once after ("verification"),
  blocking repeats within either phase.
- `repository_write_guard_decision` — froze `edit_file`/`write_file` once
  the post-edit ("verification") typecheck had been attempted.

**Why this became dead code:** v2's own system prompt explicitly forbids
the engineer from running "broad/full typecheck, lint, full test suite, or
full build" — v2 owns authoritative verification and runs it itself, after
the engineer subprocess exits. In every real v2-orchestrated session
(confirmed by replaying archived session transcripts — see Task 7's
report), the engineer never once invokes the full frontend typecheck. The
mechanism was armed but unreachable.

**Why it was still live, not just legacy:** `new-glimmer-task.sh` documents
and prints a direct, standalone `glimmer-engineer.py --workspace ... "task"`
invocation as a real workflow, bypassing v2 (and its prompt-level
prohibition) entirely. In that mode the mechanism *could* still fire, and
it was CreatorHub-specific (hardcoded `workspace/frontend` prefix
resolution, `typecheck`-named script only) — useless for any other repo.

Cross-process reuse of v2's own `manifest["state"]` was considered and
rejected: `invoke_engineer()` in `glimmer-v2.py` is a blocking subprocess
call, and v2 only computes and writes `manifest["state"] = "verified"`
*after* that call returns. There is no point in the engineer's own process
lifetime where reading `manifest["state"]` could ever observe `"verified"`
— doing so would just be a second unreachable mechanism.

## Decision

Replace both CreatorHub-specific functions and the typecheck-keyed branch
of `repository_write_guard_decision` with **one repo-agnostic, in-process
rule**, using Task 6's own vocabulary applied locally instead of
cross-process:

- `engineer_state` starts at `"preflight"` for every session.
- It becomes `"verified"` — and stays there for the rest of the process,
  monotonically — the first time a post-write validation command (any
  command starting with `npm ` — not just `npm run <script>` — plus
  `cargo check`/`test`, or `python -m py_compile`) is *attempted* after a
  successful `edit_file`/`write_file` call. Pass, fail, or timeout all
  count as terminal evidence, exactly as before.
- `repository_write_guard_decision(tool_name, engineer_state)` blocks
  `edit_file`/`write_file` once `engineer_state == "verified"`.

This drops the diagnostic/verification two-phase split (CreatorHub-specific
governance, not a safety property) and the exact-command matching — any
repo, any validation script name that reaches `exec_shell_command` through
`shell_policy`'s existing allowlist now drives the same freeze.

The npm validation allowlist inside `shell_policy` was also changed to
derive from the real script names in the session's `repo-map.json`
(written by `glimmer-v2.py` next to `GLIMMER_EVENTS_PATH`) when available,
falling back to the pre-existing hardcoded `typecheck`/`test:unit`/
`test:e2e` shape-only patterns only when no repo map exists (standalone
invocation). The derived allowlist is always a subset of the shape-only
match, so this narrows, never widens, what commands are runnable.

`DEFAULT_WORKSPACE` (hardcoded to the CreatorHub monorepo path) was
removed; `--workspace` is now a required argument with no default —
every real caller (`glimmer-v2.py`, `new-glimmer-task.sh`) already passes
it explicitly.

## Consequences

- `glimmer-engineer.py` no longer contains any CreatorHub-specific
  identifiers, path assumptions, or script-name assumptions. It works
  against any git repository with a `package.json`, `Cargo.toml`, or
  Python files.
- The write freeze fires identically whether invoked via v2 or standalone
  — one rule, one place, instead of two mechanisms that could disagree.
- If someone is tempted to reintroduce frontend-typecheck-specific
  governance in `glimmer-engineer.py`: don't. v2 owns authoritative
  verification; the engineer only needs to know "a validation command ran
  after my edit," not which one, or what repo it's in. Re-adding
  repo-specific detection here would just recreate the dead-code risk
  this task removed.
