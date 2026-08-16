import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import type { TaskContract } from "@glimmer/shared";

export function buildArgs(contract: TaskContract, workspace: string): string[] {
  const args = ["--workspace", workspace];
  args.push("--max-repairs", String(contract.repairBudget));
  if (contract.verification.length === 0) {
    args.push("--verification-level", "minimal");
  } else {
    args.push("--verification-level", "standard");
    for (const v of contract.verification) args.push("--verify", v);
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

  return {
    pid: child.pid ?? -1,
    cancel: () => child.kill("SIGTERM"),
  };
}
