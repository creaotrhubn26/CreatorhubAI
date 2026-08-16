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
  // Deliberately closed set: no --auto-approve, no flag path can request commit/push/deploy/install.
  // "--" forces argparse to treat the objective as the positional `task`, never as a flag,
  // even if a client submits an objective like "--auto-approve" or "--engineer=...".
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
