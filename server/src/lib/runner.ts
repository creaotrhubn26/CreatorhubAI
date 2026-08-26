import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type { TaskContract } from "@glimmer/shared";
import { CONFIG } from "../config.js";

// Closed allowlist: `--verify` values are executed verbatim by glimmer-v2.py
// (`shlex.split` -> subprocess) with no allowlist on that side, so a free-form
// pass-through would be an arbitrary-command channel for any network client.
// Symbolic names come from the composer; only these map to a real command.
const VERIFICATION_COMMANDS: Record<string, string> = {
  "frontend-typecheck": "npm --prefix frontend run typecheck",
  "targeted-test": "npm --prefix frontend run test:unit",
};

// §7 Advanced controls. Closed enum for toolchainMode — same discipline as
// VERIFICATION_COMMANDS above: a value outside this set is dropped, never
// forwarded. Ranges match the route-level 400 boundary in validateAdvanced.
const TOOLCHAIN_MODES = new Set(["path", "linked", "none"] as const);
// Review round 1 fix: TaskContract.mode was never forwarded to glimmer-v2.py
// at all (buildArgs had no --mode push), so every gateway-launched run got
// v2.1's own "implement" default regardless of what the composer/client
// contract said. Closed set, same defense-in-depth posture as
// TOOLCHAIN_MODES -- an out-of-range string from a raw API client is
// dropped, never forwarded.
const MODES = new Set([
  "inspect",
  "plan",
  "implement",
  "debug",
  "test",
  "review",
  "refactor",
] as const);
// Review MJ4: TaskContract.scope was never forwarded either -- buildArgs
// emitted no --scope-* flag at all, so glimmer-v2.py's argparse default
// (scope-package=repository, no area, no paths) applied to EVERY
// gateway-launched run. Consequences on that side: _expected_prefixes returns
// [] -> compute_scope_guard has no boundary; GLIMMER_CONTRACT_SCOPE is never
// set -> the engineer's §15 scope-expansion approval pause is dead code;
// _contract_scope_text tells the engineer "package=repository" so the files
// the user picked are never named in its prompt. Same closed-set posture as
// MODES/TOOLCHAIN_MODES -- mirrors glimmer-v2.py's own --scope-package
// choices, and a value outside it is dropped rather than forwarded.
const SCOPE_PACKAGES = new Set([
  "repository",
  "frontend",
  "backend",
  "directory",
  "files",
] as const);
const MAX_TURNS_RANGE = { min: 1, max: 64 };
const TIMEOUT_RANGE = { min: 60, max: 3600 };
// Task 1.4 (V7 §6): TaskContract.budgets.maxChangedFiles closed range.
const MAX_CHANGED_FILES_RANGE = { min: 1, max: 500 };
// Task 8.1 (V7 §23.10): closed set for qualityGates.minimumCustomerReadiness,
// mirroring @glimmer/shared's DeliveryReviewCustomerReadiness union and
// glimmer-v2.py's CUSTOMER_READINESS_ORDER -- a membership check only, the
// ORDER itself lives in glimmer-v2.py's own compare_customer_readiness.
const CUSTOMER_READINESS_VALUES = new Set([
  "ready_to_ship",
  "ready_with_known_limitations",
  "needs_polish",
  "needs_rework",
  "not_customer_ready",
]);

function isValidModelReadinessUrl(value: string): boolean {
  // modelReadinessUrl becomes a single argv element after its flag — it is
  // never shell-interpolated — but we still validate it parses as an
  // http/https URL so nothing free-form reaches glimmer-v2.py's argv.
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isInRange(n: unknown, range: { min: number; max: number }): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= range.min && n <= range.max;
}

// Server-side boundary for the §7 advanced composer fields: the UI is not
// the boundary, so a client posting straight to the API must be rejected the
// same as an out-of-range composer submission would be. Returns an error
// message, or null when the contract's advanced fields are all valid.
export function validateAdvanced(contract: TaskContract): string | null {
  if (contract.maxTurns !== undefined && !isInRange(contract.maxTurns, MAX_TURNS_RANGE)) {
    return `maxTurns must be an integer between ${MAX_TURNS_RANGE.min} and ${MAX_TURNS_RANGE.max}`;
  }
  const maxChangedFiles = contract.budgets?.maxChangedFiles;
  if (maxChangedFiles !== undefined && !isInRange(maxChangedFiles, MAX_CHANGED_FILES_RANGE)) {
    return `budgets.maxChangedFiles must be an integer between ${MAX_CHANGED_FILES_RANGE.min} and ${MAX_CHANGED_FILES_RANGE.max}`;
  }
  // Task 8.1 (V7 §23.10): checked here, BEFORE the `advanced` early return
  // below -- qualityGates is its own top-level contract field (like budgets
  // above), not nested under `advanced`, so it must never be skipped when a
  // request carries qualityGates but no advanced controls at all.
  const qualityGates = contract.qualityGates;
  if (
    qualityGates?.customerReadinessRequired !== undefined &&
    typeof qualityGates.customerReadinessRequired !== "boolean"
  ) {
    return "qualityGates.customerReadinessRequired must be a boolean";
  }
  if (
    qualityGates?.minimumCustomerReadiness !== undefined &&
    !CUSTOMER_READINESS_VALUES.has(qualityGates.minimumCustomerReadiness)
  ) {
    return `qualityGates.minimumCustomerReadiness must be one of ${[...CUSTOMER_READINESS_VALUES].join(", ")}`;
  }
  const advanced = contract.advanced;
  if (!advanced) return null;
  if (advanced.timeoutSeconds !== undefined && !isInRange(advanced.timeoutSeconds, TIMEOUT_RANGE)) {
    return `timeoutSeconds must be an integer between ${TIMEOUT_RANGE.min} and ${TIMEOUT_RANGE.max}`;
  }
  if (advanced.toolchainMode !== undefined && !TOOLCHAIN_MODES.has(advanced.toolchainMode)) {
    return `toolchainMode must be one of ${[...TOOLCHAIN_MODES].join(", ")}`;
  }
  if (
    advanced.modelReadinessUrl !== undefined &&
    !isValidModelReadinessUrl(advanced.modelReadinessUrl)
  ) {
    return "modelReadinessUrl must be a valid http(s) URL";
  }
  if (advanced.architectFirst !== undefined && typeof advanced.architectFirst !== "boolean") {
    return "architectFirst must be a boolean";
  }
  return null;
}

export function buildArgs(contract: TaskContract, workspace: string, sessionId?: string): string[] {
  const args = ["--workspace", workspace];
  if (sessionId && /^[A-Za-z0-9._-]+$/.test(sessionId)) {
    args.push("--session-id", sessionId);
  }
  args.push("--max-repairs", String(contract.repairBudget));
  if (contract.verification.length === 0) {
    args.push("--verification-level", "minimal");
  } else {
    args.push("--verification-level", "standard");
    for (const v of contract.verification) {
      const cmd = VERIFICATION_COMMANDS[v];
      if (cmd) args.push("--verify", cmd); // unrecognized names are dropped, never forwarded
    }
  }
  if (contract.maxTurns) args.push("--max-turns", String(contract.maxTurns));
  // Task 1.4 (V7 §6): budgets.maxChangedFiles -- same defense-in-depth
  // posture as the advanced fields below (duplicates validateAdvanced's
  // boundary; an out-of-range value is dropped, never forwarded).
  const maxChangedFiles = contract.budgets?.maxChangedFiles;
  if (maxChangedFiles !== undefined && isInRange(maxChangedFiles, MAX_CHANGED_FILES_RANGE)) {
    args.push("--max-changed-files", String(maxChangedFiles));
  }
  // Review round 1 fix: was silently missing -- see MODES comment above.
  if (MODES.has(contract.mode)) {
    args.push("--mode", contract.mode);
  }
  if (contract.intent?.kind === "improvement-assessment" || contract.intent?.kind === "direct") {
    args.push("--intent", contract.intent.kind);
    if (
      contract.intent.source === "explicit" ||
      contract.intent.source === "deterministic-inference"
    ) {
      args.push("--intent-source", contract.intent.source);
    }
  }

  // Review MJ4: forward the contract's scope -- see SCOPE_PACKAGES above.
  // Flag names/shapes are glimmer-v2.py's own (`--scope-package` choices,
  // `--scope-area`, and `--scope-paths` as action="append", hence one flag per
  // path). Empty/blank values are dropped: an empty --scope-area would make
  // the orchestrator's _expected_prefixes guard against "" and report every
  // file out of scope.
  const scope = contract.scope;
  if (SCOPE_PACKAGES.has(scope.package)) {
    args.push("--scope-package", scope.package);
  }
  // A value starting with "-" is dropped rather than forwarded: argparse
  // would read it as the next flag and abort the whole run ("expected one
  // argument"). Not an injection (argparse fails closed), but it is the only
  // free-form value here, so it gets the same drop-invalid posture as every
  // other field below.
  if (scope.area?.trim() && !scope.area.trim().startsWith("-")) {
    args.push("--scope-area", scope.area.trim());
  }
  for (const scopePath of scope.paths ?? []) {
    if (typeof scopePath === "string" && scopePath.trim() && !scopePath.trim().startsWith("-")) {
      args.push("--scope-paths", scopePath.trim());
    }
  }

  // §7 Advanced controls: typed-only, closed-enum mapping. Every check here
  // duplicates validateAdvanced's boundary (defense in depth) — an invalid
  // value is dropped silently rather than forwarded, the same posture as
  // VERIFICATION_COMMANDS above.
  const advanced = contract.advanced;
  if (advanced?.timeoutSeconds !== undefined && isInRange(advanced.timeoutSeconds, TIMEOUT_RANGE)) {
    args.push("--timeout", String(advanced.timeoutSeconds));
  }
  if (advanced?.toolchainMode !== undefined && TOOLCHAIN_MODES.has(advanced.toolchainMode)) {
    args.push("--toolchain-mode", advanced.toolchainMode);
  }
  if (
    advanced?.modelReadinessUrl !== undefined &&
    isValidModelReadinessUrl(advanced.modelReadinessUrl)
  ) {
    args.push("--model-readiness-url", advanced.modelReadinessUrl);
  }
  if (advanced?.architectFirst === true) {
    args.push("--architect-first");
  }

  // Task 8.1 (V7 §23.10): qualityGates -- same duplicated-boundary posture
  // as the advanced fields above (defense in depth); an invalid/unrecognized
  // value is dropped silently rather than forwarded.
  const qualityGates = contract.qualityGates;
  if (qualityGates?.customerReadinessRequired === true) {
    args.push("--customer-readiness-required");
  }
  if (
    qualityGates?.minimumCustomerReadiness !== undefined &&
    CUSTOMER_READINESS_VALUES.has(qualityGates.minimumCustomerReadiness)
  ) {
    args.push("--minimum-customer-readiness", qualityGates.minimumCustomerReadiness);
  }

  // --auto-approve is required for gateway-launched runs: glimmer-engineer.py's
  // approve() is an interactive per-tool stdin prompt, and the gateway has no
  // stdin channel — without this flag every run deadlocks on its first write
  // (found live in the first real UI-driven dogfood run; the engineer blocked
  // forever in readline()). Human approval in the gateway flow happens at the
  // boundaries instead: frozen commit/push/deploy/install permissions, the
  // scope guard, and the explicit human accept-for-review step in Diff Review.
  args.push("--auto-approve");

  // Deliberately closed set otherwise: no flag path can request commit/push/deploy/install.
  // "--" forces argparse to treat the objective as the positional `task`, never as a flag,
  // even if a client submits an objective like "--engineer=...".
  args.push("--", contract.objective);
  return args;
}

export function runtimeCommand(
  orchestratorPath: string,
  pythonPath = CONFIG.pythonPath,
): { command: string; prefixArgs: string[] } {
  return orchestratorPath.endsWith(".mjs")
    ? { command: process.execPath, prefixArgs: [orchestratorPath] }
    : { command: pythonPath, prefixArgs: [orchestratorPath] };
}

export function runGlimmer(
  sessionDir: string,
  engineerScriptPath: string,
  args: string[],
  onExit: (code: number | null) => void,
) {
  const logPath = path.join(sessionDir, "engineer-00.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const invocation = runtimeCommand(engineerScriptPath);
  const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      GLIMMER_API_KEY_FILE: CONFIG.modelApiKeyFile,
      GLIMMER_MODEL_CONFIG: CONFIG.modelConfigPath,
    },
  });

  let settled = false;
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    log.end();
    onExit(code);
  };

  child.stdout.on("data", (chunk) => log.write(chunk));
  child.stderr.on("data", (chunk) => log.write(chunk));
  child.on("exit", finish);
  // A failed spawn (e.g. python3 missing) never fires "exit"; without this the
  // caller's cancel handle would stay registered forever and every retry 409s.
  child.on("error", (err) => {
    log.write(String(err) + "\n");
    finish(null);
  });

  return {
    pid: child.pid ?? -1,
    cancel: () => {
      if (settled || !child.pid) return;
      try {
        // Each orchestrator is a process-group leader on Unix. Cancelling the
        // group also terminates an in-flight engineer/model child instead of
        // leaving it orphaned after the top-level process exits.
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
      } catch {
        // The process may have exited between the settled check and signal.
      }
    },
  };
}
