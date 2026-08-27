import { describe, it, expect, afterEach } from "vitest";
import {
  buildArgs,
  runGlimmer,
  runtimeCommand,
  validateAdvanced,
  writeDesignContractInput,
} from "./runner.js";
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
  constraints: {
    minimalChange: true,
    noCommit: true as const,
    noPush: true as const,
    noDeploy: true as const,
    noDependencyInstall: true as const,
  },
  verification: ["frontend-typecheck"],
  repairBudget: 2,
};

const DESIGN = {
  kind: "improve" as const,
  targetUrl: "http://localhost:5173/settings",
  requirements: ["primary action remains visible"],
  referenceImages: [{ path: "design/settings.png" }],
  referenceImagePolicy: "local-only" as const,
  states: [],
  viewports: ["1440x900", "390x844"],
  inspirations: [],
  variants: [],
  elementEdits: [],
  assetRequests: [],
  cms: {
    strategy: "detect" as const,
    schemaPaths: ["cms/schema"],
    requirements: ["copy remains editor-managed"],
    localizationRequired: true,
  },
  designTokens: {
    strategy: "existing" as const,
    sourcePaths: ["src/theme.css"],
    requirements: ["reuse semantic tokens"],
    allowNewTokens: false,
  },
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

  it("passes the canonical session id and structured intent without replacing the objective", () => {
    const contract = {
      ...CONTRACT,
      objective: "Hva kan bli bedre?",
      intent: {
        kind: "improvement-assessment" as const,
        source: "deterministic-inference" as const,
      },
    };
    const args = buildArgs(contract, "/tmp/ws", "20260825-173500-abcdef123456");
    expect(args[args.indexOf("--session-id") + 1]).toBe("20260825-173500-abcdef123456");
    expect(args[args.indexOf("--intent") + 1]).toBe("improvement-assessment");
    expect(args[args.indexOf("--intent-source") + 1]).toBe("deterministic-inference");
    expect(args.at(-1)).toBe("Hva kan bli bedre?");
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
    const args = buildArgs(
      { ...CONTRACT, verification: ["frontend-typecheck", "targeted-test"] },
      "/tmp/ws",
    );
    expect(args).toContain("--verify");
    expect(args).toContain("npm --prefix frontend run typecheck");
    expect(args).toContain("npm --prefix frontend run test:unit");
    expect(args.filter((a) => a === "--verify")).toHaveLength(2);
  });

  it("forwards a validated design contract, visual target, and visual verification safely", () => {
    const designPath = "/tmp/glimmer/design-contract.input.json";
    const args = buildArgs(
      { ...CONTRACT, design: DESIGN, verification: ["visual"] },
      "/tmp/ws",
      "design-session",
      designPath,
    );
    expect(args[args.indexOf("--design-contract") + 1]).toBe(designPath);
    expect(args[args.indexOf("--visual-url") + 1]).toBe(DESIGN.targetUrl);
    expect(args).toContain("--architect-first");
    expect(args).toContain("visual");
  });

  it("does not forward an external design target or relative design artifact path", () => {
    const args = buildArgs(
      { ...CONTRACT, design: { ...DESIGN, targetUrl: "https://example.com" } },
      "/tmp/ws",
      "design-session",
      "relative/design.json",
    );
    expect(args).not.toContain("--visual-url");
    expect(args).not.toContain("--design-contract");
  });

  it("drops unrecognized verification values instead of forwarding them to shlex.split", () => {
    const evil = "git push origin main";
    const args = buildArgs(
      { ...CONTRACT, verification: [evil, "rm -rf /", "frontend-typecheck"] },
      "/tmp/ws",
    );
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
      const args = buildArgs(
        { ...CONTRACT, advanced: { modelReadinessUrl: "http://127.0.0.1:8080/health" } },
        "/tmp/ws",
      );
      const flagIndex = args.indexOf("--model-readiness-url");
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(args[flagIndex + 1]).toBe("http://127.0.0.1:8080/health");
    });

    it("maps advanced.architectFirst: true to a bare --architect-first flag", () => {
      const args = buildArgs({ ...CONTRACT, advanced: { architectFirst: true } }, "/tmp/ws");
      expect(args).toContain("--architect-first");
    });

    it("omits --architect-first when false or absent", () => {
      expect(
        buildArgs({ ...CONTRACT, advanced: { architectFirst: false } }, "/tmp/ws"),
      ).not.toContain("--architect-first");
      expect(buildArgs(CONTRACT, "/tmp/ws")).not.toContain("--architect-first");
    });

    it("emits none of the advanced flags when advanced is omitted entirely (zero behavior change when untouched)", () => {
      const args = buildArgs(CONTRACT, "/tmp/ws");
      for (const flag of [
        "--timeout",
        "--toolchain-mode",
        "--model-readiness-url",
        "--architect-first",
      ]) {
        expect(args).not.toContain(flag);
      }
    });

    it("silently drops an unparseable modelReadinessUrl instead of forwarding it (defense in depth beyond route validation)", () => {
      const args = buildArgs(
        { ...CONTRACT, advanced: { modelReadinessUrl: "http://x; rm -rf /" } },
        "/tmp/ws",
      );
      expect(args).not.toContain("--model-readiness-url");
      expect(args.some((a) => a.includes("rm -rf"))).toBe(false);
    });

    it("silently drops a non-http(s) modelReadinessUrl scheme", () => {
      const args = buildArgs(
        { ...CONTRACT, advanced: { modelReadinessUrl: "javascript:alert(1)" } },
        "/tmp/ws",
      );
      expect(args).not.toContain("--model-readiness-url");
    });

    it("silently drops a toolchainMode value outside the closed enum", () => {
      const args = buildArgs(
        { ...CONTRACT, advanced: { toolchainMode: "rm -rf /" as any } },
        "/tmp/ws",
      );
      expect(args).not.toContain("--toolchain-mode");
      expect(args.some((a) => a.includes("rm -rf"))).toBe(false);
    });

    it("keeps '--' as the second-to-last element and the objective last, even with every advanced field set", () => {
      const args = buildArgs(
        {
          ...CONTRACT,
          maxTurns: 10,
          advanced: {
            timeoutSeconds: 120,
            toolchainMode: "none",
            modelReadinessUrl: "https://model.local/ready",
            architectFirst: true,
          },
        },
        "/tmp/ws",
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
    const args = buildArgs(
      { ...CONTRACT, budgets: { maxChangedFiles: "10; rm -rf /" as any } },
      "/tmp/ws",
    );
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

// Review round 1 fix: TaskContract.mode was never forwarded at all.
// Review MJ4: buildArgs emitted no --scope-* flag at all, so every
// gateway-launched run reached glimmer-v2.py with its argparse default
// (scope.package = "repository", no area, no paths) — the composer's picked
// files never bounded the run, and GLIMMER_CONTRACT_SCOPE (the engineer's §15
// expansion pause) was never set.
describe("scope passthrough", () => {
  it("forwards scope.package and scope.area", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    expect(args[args.indexOf("--scope-package") + 1]).toBe("frontend");
    expect(args[args.indexOf("--scope-area") + 1]).toBe("role-room");
  });

  it("repeats --scope-paths once per path (glimmer-v2.py's --scope-paths is action=append)", () => {
    const args = buildArgs(
      { ...CONTRACT, scope: { package: "files" as const, paths: ["src/a.ts", "src/b.ts"] } },
      "/tmp/ws",
    );
    expect(args[args.indexOf("--scope-package") + 1]).toBe("files");
    const pathFlags = args.reduce<string[]>(
      (acc, a, i) => (a === "--scope-paths" ? [...acc, args[i + 1]] : acc),
      [],
    );
    expect(pathFlags).toEqual(["src/a.ts", "src/b.ts"]);
    expect(args).not.toContain("--scope-area");
  });

  it("forwards a repository scope as such, with no area or paths", () => {
    const args = buildArgs({ ...CONTRACT, scope: { package: "repository" as const } }, "/tmp/ws");
    expect(args[args.indexOf("--scope-package") + 1]).toBe("repository");
    expect(args).not.toContain("--scope-area");
    expect(args).not.toContain("--scope-paths");
  });

  it("drops a blank area/path instead of guarding against an empty prefix", () => {
    const args = buildArgs(
      { ...CONTRACT, scope: { package: "directory" as const, area: "   ", paths: ["", "  "] } },
      "/tmp/ws",
    );
    expect(args).not.toContain("--scope-area");
    expect(args).not.toContain("--scope-paths");
  });

  it("drops a scope.package outside the closed set (defense in depth beyond route validation)", () => {
    const args = buildArgs(
      { ...CONTRACT, scope: { package: "--engineer=evil" as any } },
      "/tmp/ws",
    );
    expect(args).not.toContain("--scope-package");
    expect(args.some((a) => a.includes("--engineer"))).toBe(false);
  });

  it("keeps the objective last, after --, with every scope flag set", () => {
    const args = buildArgs(
      { ...CONTRACT, scope: { package: "files" as const, area: "src", paths: ["src/a.ts"] } },
      "/tmp/ws",
    );
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe(CONTRACT.objective);
  });
});

describe("mode passthrough", () => {
  it("forwards contract.mode as --mode", () => {
    const args = buildArgs({ ...CONTRACT, mode: "debug" }, "/tmp/ws");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("debug");
  });

  it("accepts the new refactor mode", () => {
    const args = buildArgs({ ...CONTRACT, mode: "refactor" }, "/tmp/ws");
    expect(args).toContain("--mode");
    expect(args[args.indexOf("--mode") + 1]).toBe("refactor");
  });

  it("drops an unrecognized mode instead of forwarding it (defense in depth beyond route validation)", () => {
    const args = buildArgs({ ...CONTRACT, mode: "rm -rf /" as any }, "/tmp/ws");
    expect(args).not.toContain("--mode");
    expect(args.some((a) => a.includes("rm -rf"))).toBe(false);
  });
});

// Task 8.1 (V7 §23.10): qualityGates.
describe("qualityGates", () => {
  it("maps customerReadinessRequired: true to a bare --customer-readiness-required flag", () => {
    const args = buildArgs(
      { ...CONTRACT, qualityGates: { customerReadinessRequired: true } },
      "/tmp/ws",
    );
    expect(args).toContain("--customer-readiness-required");
  });

  it("omits --customer-readiness-required when false or absent", () => {
    expect(
      buildArgs({ ...CONTRACT, qualityGates: { customerReadinessRequired: false } }, "/tmp/ws"),
    ).not.toContain("--customer-readiness-required");
    expect(buildArgs(CONTRACT, "/tmp/ws")).not.toContain("--customer-readiness-required");
  });

  it("maps minimumCustomerReadiness to --minimum-customer-readiness", () => {
    const args = buildArgs(
      { ...CONTRACT, qualityGates: { minimumCustomerReadiness: "needs_polish" } },
      "/tmp/ws",
    );
    expect(args).toContain("--minimum-customer-readiness");
    expect(args[args.indexOf("--minimum-customer-readiness") + 1]).toBe("needs_polish");
  });

  it("emits neither flag when qualityGates is omitted entirely (zero behavior change when untouched)", () => {
    const args = buildArgs(CONTRACT, "/tmp/ws");
    expect(args).not.toContain("--customer-readiness-required");
    expect(args).not.toContain("--minimum-customer-readiness");
  });

  it("silently drops an unrecognized minimumCustomerReadiness instead of forwarding it (defense in depth beyond route validation)", () => {
    const args = buildArgs(
      { ...CONTRACT, qualityGates: { minimumCustomerReadiness: "extremely_ready" as any } },
      "/tmp/ws",
    );
    expect(args).not.toContain("--minimum-customer-readiness");
  });

  it("keeps '--' as the second-to-last element and the objective last, even with qualityGates set", () => {
    const args = buildArgs(
      {
        ...CONTRACT,
        qualityGates: {
          customerReadinessRequired: true,
          minimumCustomerReadiness: "ready_to_ship",
        },
      },
      "/tmp/ws",
    );
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe(CONTRACT.objective);
  });

  it("accepts a contract with no qualityGates at all", () => {
    expect(validateAdvanced(CONTRACT)).toBeNull();
  });

  it("accepts each closed-enum minimumCustomerReadiness value", () => {
    for (const value of [
      "ready_to_ship",
      "ready_with_known_limitations",
      "needs_polish",
      "needs_rework",
      "not_customer_ready",
    ] as const) {
      expect(
        validateAdvanced({ ...CONTRACT, qualityGates: { minimumCustomerReadiness: value } }),
      ).toBeNull();
    }
  });

  it("rejects a minimumCustomerReadiness outside the closed enum (fail closed, never guessed)", () => {
    expect(
      validateAdvanced({
        ...CONTRACT,
        qualityGates: { minimumCustomerReadiness: "extremely_ready" as any },
      }),
    ).not.toBeNull();
  });

  it("rejects a non-boolean customerReadinessRequired", () => {
    expect(
      validateAdvanced({ ...CONTRACT, qualityGates: { customerReadinessRequired: "yes" as any } }),
    ).not.toBeNull();
  });

  it("accepts customerReadinessRequired: true with no minimum given", () => {
    expect(
      validateAdvanced({ ...CONTRACT, qualityGates: { customerReadinessRequired: true } }),
    ).toBeNull();
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
    expect(
      validateAdvanced({ ...CONTRACT, advanced: { toolchainMode: "rm -rf /" as any } }),
    ).not.toBeNull();
  });

  it("accepts each closed-enum toolchainMode value", () => {
    for (const mode of ["path", "linked", "none"] as const) {
      expect(validateAdvanced({ ...CONTRACT, advanced: { toolchainMode: mode } })).toBeNull();
    }
  });

  it("rejects an unparseable modelReadinessUrl", () => {
    expect(
      validateAdvanced({ ...CONTRACT, advanced: { modelReadinessUrl: "http://x; rm -rf /" } }),
    ).not.toBeNull();
  });

  it("rejects a non-http(s) modelReadinessUrl scheme", () => {
    expect(
      validateAdvanced({ ...CONTRACT, advanced: { modelReadinessUrl: "javascript:alert(1)" } }),
    ).not.toBeNull();
    expect(
      validateAdvanced({ ...CONTRACT, advanced: { modelReadinessUrl: "ftp://x.com" } }),
    ).not.toBeNull();
  });

  it("accepts a well-formed http/https modelReadinessUrl", () => {
    expect(
      validateAdvanced({
        ...CONTRACT,
        advanced: { modelReadinessUrl: "http://127.0.0.1:8080/health" },
      }),
    ).toBeNull();
    expect(
      validateAdvanced({
        ...CONTRACT,
        advanced: { modelReadinessUrl: "https://model.local/ready" },
      }),
    ).toBeNull();
  });
});

describe("runGlimmer", () => {
  let cancelHandle: { cancel(): void } | undefined;
  afterEach(() => cancelHandle?.cancel());

  it("uses an explicit bundled Python path for Python orchestrators", () => {
    expect(
      runtimeCommand("/Applications/Glimmer.app/orchestrator/glimmer-v2.py", "/app/python3"),
    ).toEqual({
      command: "/app/python3",
      prefixArgs: ["/Applications/Glimmer.app/orchestrator/glimmer-v2.py"],
    });
  });

  it("keeps Node fixtures on the current Node executable", () => {
    expect(runtimeCommand(FAKE_ENGINEER, "/app/python3")).toEqual({
      command: process.execPath,
      prefixArgs: [FAKE_ENGINEER],
    });
  });

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

describe("writeDesignContractInput", () => {
  it("persists the normalized design input with private permissions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-design-contract-"));
    const target = await writeDesignContractInput(dir, DESIGN);
    expect(JSON.parse(await fs.readFile(target!, "utf8"))).toEqual(DESIGN);
    expect((await fs.stat(target!)).mode & 0o777).toBe(0o600);
  });
});
