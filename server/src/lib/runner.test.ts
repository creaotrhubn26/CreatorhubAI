import { describe, it, expect, afterEach } from "vitest";
import { buildArgs, runGlimmer, validateAdvanced } from "./runner.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINEER = path.join(__dirname, "__fixtures__", "fake-glimmer-v2.mjs");

const CONTRACT = {
  objective: "Fix dialog state restoration",
  scope: { package: "frontend" as const, area: "role-room" },
  mode: "implement" as const,
  constraints: { minimalChange: true, noCommit: true as const, noPush: true as const, noDeploy: true as const, noDependencyInstall: true as const },
  verification: ["frontend-typecheck"],
  repairBudget: 2,
};

describe("buildArgs", () => {
  it("never includes a commit/push/deploy/install flag", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    const joined = args.join(" ");
    expect(joined).not.toMatch(/commit|push|deploy|install/i);
  });

  it("passes objective, workspace, and repair budget", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    expect(args).toContain(CONTRACT.objective);
    expect(args).toContain("--workspace");
    expect(args).toContain("/tmp/ws");
    expect(args).toContain("--max-repairs");
    expect(args).toContain("2");
  });

  it("puts the objective last, after a literal -- separator, so argparse can never read it as a flag", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe(CONTRACT.objective);
  });

  it("always passes --auto-approve before the terminator (gateway has no stdin for approve())", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    const sepIndex = args.indexOf("--");
    expect(args.slice(0, sepIndex)).toContain("--auto-approve");
    expect(args.slice(0, sepIndex).filter((a) => a === "--auto-approve")).toHaveLength(1);
  });

  it("cannot be flag-injected via a malicious objective", () => {
    const malicious = { ...CONTRACT, objective: "--engineer=/tmp/evil.py" };
    const args = buildArgs(malicious, "/tmp/ws");
    const sepIndex = args.indexOf("--");
    expect(sepIndex).toBeGreaterThanOrEqual(0);
    // The malicious objective lands only as the positional element after "--",
    // never as a parsed flag before it.
    expect(args[sepIndex + 1]).toBe("--engineer=/tmp/evil.py");
    expect(args.slice(0, sepIndex)).not.toContain("--engineer=/tmp/evil.py");
  });

  it("maps symbolic verification names to the real allowlisted commands", () => {
    const args = buildArgs({ ...CONTRACT, verification: ["frontend-typecheck", "targeted-test"] }, "/tmp/ws");
    expect(args).toContain("--verify");
    expect(args).toContain("npm --prefix frontend run typecheck");
    expect(args).toContain("npm --prefix frontend run test:unit");
    expect(args.filter((a) => a === "--verify")).toHaveLength(2);
  });

  it("drops unrecognized verification values instead of forwarding them to shlex.split", () => {
    const evil = "git push origin main";
    const args = buildArgs({ ...CONTRACT, verification: [evil, "rm -rf /", "frontend-typecheck"] }, "/tmp/ws");
    // glimmer-v2.py executes every --verify value verbatim: nothing outside the
    // allowlist may appear anywhere in argv.
    expect(args.some((a) => a.includes(evil))).toBe(false);
    expect(args.some((a) => a.includes("rm -rf"))).toBe(false);
    expect(args.filter((a) => a === "--verify")).toHaveLength(1);
    expect(args).toContain("npm --prefix frontend run typecheck");
  });

  // §7 Advanced controls: typed-only fields mapped to their real flags.
  describe("advanced controls", () => {
    it("maps advanced.timeoutSeconds to --timeout", () => {
      const args = buildArgs({ ...CONTRACT, advanced: { timeoutSeconds: 300 } }, "/tmp/ws");
      expect(args).toContain("--timeout");
      expect(args[args.indexOf("--timeout") + 1]).toBe("300");
    });

    it("maps advanced.toolchainMode to --toolchain-mode", () => {
      const args = buildArgs({ ...CONTRACT, advanced: { toolchainMode: "linked" } }, "/tmp/ws");
      expect(args).toContain("--toolchain-mode");
      expect(args[args.indexOf("--toolchain-mode") + 1]).toBe("linked");
    });

    it("maps advanced.modelReadinessUrl to --model-readiness-url as a single argv element", () => {
      const args = buildArgs({ ...CONTRACT, advanced: { modelReadinessUrl: "http://127.0.0.1:8080/health" } }, "/tmp/ws");
      const flagIndex = args.indexOf("--model-readiness-url");
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(args[flagIndex + 1]).toBe("http://127.0.0.1:8080/health");
    });

    it("maps advanced.architectFirst: true to a bare --architect-first flag", () => {
      const args = buildArgs({ ...CONTRACT, advanced: { architectFirst: true } }, "/tmp/ws");
      expect(args).toContain("--architect-first");
    });

    it("omits --architect-first when false or absent", () => {
      expect(buildArgs({ ...CONTRACT, advanced: { architectFirst: false } }, "/tmp/ws")).not.toContain("--architect-first");
      expect(buildArgs(CONTRACT, "/tmp/ws")).not.toContain("--architect-first");
    });

    it("emits none of the advanced flags when advanced is omitted entirely (zero behavior change when untouched)", () => {
      const args = buildArgs(CONTRACT, "/tmp/ws");
      for (const flag of ["--timeout", "--toolchain-mode", "--model-readiness-url", "--architect-first"]) {
        expect(args).not.toContain(flag);
      }
    });

    it("silently drops an unparseable modelReadinessUrl instead of forwarding it (defense in depth beyond route validation)", () => {
      const args = buildArgs({ ...CONTRACT, advanced: { modelReadinessUrl: "http://x; rm -rf /" } }, "/tmp/ws");
      expect(args).not.toContain("--model-readiness-url");
      expect(args.some((a) => a.includes("rm -rf"))).toBe(false);
    });

    it("silently drops a non-http(s) modelReadinessUrl scheme", () => {
      const args = buildArgs({ ...CONTRACT, advanced: { modelReadinessUrl: "javascript:alert(1)" } }, "/tmp/ws");
      expect(args).not.toContain("--model-readiness-url");
    });

    it("silently drops a toolchainMode value outside the closed enum", () => {
      const args = buildArgs({ ...CONTRACT, advanced: { toolchainMode: "rm -rf /" as any } }, "/tmp/ws");
      expect(args).not.toContain("--toolchain-mode");
      expect(args.some((a) => a.includes("rm -rf"))).toBe(false);
    });

    it("keeps '--' as the second-to-last element and the objective last, even with every advanced field set", () => {
      const args = buildArgs(
        {
          ...CONTRACT,
          maxTurns: 10,
          advanced: { timeoutSeconds: 120, toolchainMode: "none", modelReadinessUrl: "https://model.local/ready", architectFirst: true },
        },
        "/tmp/ws"
      );
      expect(args[args.length - 2]).toBe("--");
      expect(args[args.length - 1]).toBe(CONTRACT.objective);
    });
  });
});

// Task 1.4 (V7 §6): budgets.maxChangedFiles.
describe("budgets.maxChangedFiles", () => {
  it("maps budgets.maxChangedFiles to --max-changed-files", () => {
    const args = buildArgs({ ...CONTRACT, budgets: { maxChangedFiles: 25 } }, "/tmp/ws");
    expect(args).toContain("--max-changed-files");
    expect(args[args.indexOf("--max-changed-files") + 1]).toBe("25");
  });

  it("omits --max-changed-files when budgets is absent (zero behavior change when untouched)", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    expect(args).not.toContain("--max-changed-files");
  });

  it("silently drops an out-of-range maxChangedFiles instead of forwarding it (defense in depth beyond route validation)", () => {
    const tooLow = buildArgs({ ...CONTRACT, budgets: { maxChangedFiles: 0 } }, "/tmp/ws");
    expect(tooLow).not.toContain("--max-changed-files");
    const tooHigh = buildArgs({ ...CONTRACT, budgets: { maxChangedFiles: 501 } }, "/tmp/ws");
    expect(tooHigh).not.toContain("--max-changed-files");
  });

  it("cannot be flag-injected via a non-numeric value", () => {
    const args = buildArgs({ ...CONTRACT, budgets: { maxChangedFiles: "10; rm -rf /" as any } }, "/tmp/ws");
    expect(args).not.toContain("--max-changed-files");
    expect(args.some((a) => a.includes("rm -rf"))).toBe(false);
  });

  it("accepts the boundary values 1 and 500", () => {
    expect(validateAdvanced({ ...CONTRACT, budgets: { maxChangedFiles: 1 } })).toBeNull();
    expect(validateAdvanced({ ...CONTRACT, budgets: { maxChangedFiles: 500 } })).toBeNull();
  });

  it("rejects values outside 1..500", () => {
    expect(validateAdvanced({ ...CONTRACT, budgets: { maxChangedFiles: 0 } })).not.toBeNull();
    expect(validateAdvanced({ ...CONTRACT, budgets: { maxChangedFiles: 501 } })).not.toBeNull();
    expect(validateAdvanced({ ...CONTRACT, budgets: { maxChangedFiles: 1.5 } })).not.toBeNull();
  });

  it("accepts a contract with no budgets at all", () => {
    expect(validateAdvanced(CONTRACT)).toBeNull();
  });
});

describe("validateAdvanced", () => {
  it("accepts a contract with no advanced fields at all", () => {
    expect(validateAdvanced(CONTRACT)).toBeNull();
  });

  it("accepts maxTurns within 1..64", () => {
    expect(validateAdvanced({ ...CONTRACT, maxTurns: 1 })).toBeNull();
    expect(validateAdvanced({ ...CONTRACT, maxTurns: 64 })).toBeNull();
  });

  it("rejects maxTurns outside 1..64", () => {
    expect(validateAdvanced({ ...CONTRACT, maxTurns: 0 })).not.toBeNull();
    expect(validateAdvanced({ ...CONTRACT, maxTurns: 65 })).not.toBeNull();
    expect(validateAdvanced({ ...CONTRACT, maxTurns: 1.5 })).not.toBeNull();
  });

  it("accepts timeoutSeconds within 60..3600", () => {
    expect(validateAdvanced({ ...CONTRACT, advanced: { timeoutSeconds: 60 } })).toBeNull();
    expect(validateAdvanced({ ...CONTRACT, advanced: { timeoutSeconds: 3600 } })).toBeNull();
  });

  it("rejects timeoutSeconds outside 60..3600", () => {
    expect(validateAdvanced({ ...CONTRACT, advanced: { timeoutSeconds: 59 } })).not.toBeNull();
    expect(validateAdvanced({ ...CONTRACT, advanced: { timeoutSeconds: 3601 } })).not.toBeNull();
  });

  it("rejects a toolchainMode outside the closed enum", () => {
    expect(validateAdvanced({ ...CONTRACT, advanced: { toolchainMode: "rm -rf /" as any } })).not.toBeNull();
  });

  it("accepts each closed-enum toolchainMode value", () => {
    for (const mode of ["path", "linked", "none"] as const) {
      expect(validateAdvanced({ ...CONTRACT, advanced: { toolchainMode: mode } })).toBeNull();
    }
  });

  it("rejects an unparseable modelReadinessUrl", () => {
    expect(validateAdvanced({ ...CONTRACT, advanced: { modelReadinessUrl: "http://x; rm -rf /" } })).not.toBeNull();
  });

  it("rejects a non-http(s) modelReadinessUrl scheme", () => {
    expect(validateAdvanced({ ...CONTRACT, advanced: { modelReadinessUrl: "javascript:alert(1)" } })).not.toBeNull();
    expect(validateAdvanced({ ...CONTRACT, advanced: { modelReadinessUrl: "ftp://x.com" } })).not.toBeNull();
  });

  it("accepts a well-formed http/https modelReadinessUrl", () => {
    expect(validateAdvanced({ ...CONTRACT, advanced: { modelReadinessUrl: "http://127.0.0.1:8080/health" } })).toBeNull();
    expect(validateAdvanced({ ...CONTRACT, advanced: { modelReadinessUrl: "https://model.local/ready" } })).toBeNull();
  });
});

describe("runGlimmer", () => {
  let cancelHandle: { cancel(): void } | undefined;
  afterEach(() => cancelHandle?.cancel());

  it("spawns the given engineer script and streams stdout into the session log", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-run-test-"));
    const done = new Promise<number | null>((resolve) => {
      cancelHandle = runGlimmer(dir, FAKE_ENGINEER, ["task", "--workspace", "/tmp/ws"], resolve);
    });
    const code = await done;
    expect(code).toBe(0);
    const log = await fs.readFile(path.join(dir, "engineer-00.log"), "utf-8");
    expect(log).toContain("FAKE ENGINEER RUNNING");
  });
});
