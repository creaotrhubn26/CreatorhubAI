import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type { TaskContract } from "@glimmer/shared";

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
const MAX_TURNS_RANGE = { min: 1, max: 64 };
const TIMEOUT_RANGE = { min: 60, max: 3600 };
// Task 1.4 (V7 §6): TaskContract.budgets.maxChangedFiles closed range.
const MAX_CHANGED_FILES_RANGE = { min: 1, max: 500 };

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
  const advanced = contract.advanced;
  if (!advanced) return null;
  if (advanced.timeoutSeconds !== undefined && !isInRange(advanced.timeoutSeconds, TIMEOUT_RANGE)) {
    return `timeoutSeconds must be an integer between ${TIMEOUT_RANGE.min} and ${TIMEOUT_RANGE.max}`;
  }
  if (advanced.toolchainMode !== undefined && !TOOLCHAIN_MODES.has(advanced.toolchainMode)) {
    return `toolchainMode must be one of ${[...TOOLCHAIN_MODES].join(", ")}`;
  }
  if (advanced.modelReadinessUrl !== undefined && !isValidModelReadinessUrl(advanced.modelReadinessUrl)) {
    return "modelReadinessUrl must be a valid http(s) URL";
  }
  if (advanced.architectFirst !== undefined && typeof advanced.architectFirst !== "boolean") {
    return "architectFirst must be a boolean";
  }
  return null;
}

export function buildArgs(contract: TaskContract, workspace: string): string[] {
  const args = ["--workspace", workspace];
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
  if (advanced?.modelReadinessUrl !== undefined && isValidModelReadinessUrl(advanced.modelReadinessUrl)) {
    args.push("--model-readiness-url", advanced.modelReadinessUrl);
  }
  if (advanced?.architectFirst === true) {
    args.push("--architect-first");
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

export function runGlimmer(
  sessionDir: string,
  engineerScriptPath: string,
  args: string[],
  onExit: (code: number | null) => void
) {
  const logPath = path.join(sessionDir, "engineer-00.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const isNodeFixture = engineerScriptPath.endsWith(".mjs");
  const child = isNodeFixture
    ? spawn(process.execPath, [engineerScriptPath, ...args])
    : spawn("python3", [engineerScriptPath, ...args]);

  child.stdout.on("data", (chunk) => log.write(chunk));
  child.stderr.on("data", (chunk) => log.write(chunk));
  child.on("exit", (code) => {
    log.end();
    onExit(code);
  });
  // A failed spawn (e.g. python3 missing) never fires "exit"; without this the
  // caller's cancel handle would stay registered forever and every retry 409s.
  child.on("error", (err) => {
    log.write(String(err) + "\n");
    log.end();
    onExit(null);
  });

  return {
    pid: child.pid ?? -1,
    cancel: () => child.kill("SIGTERM"),
  };
}
