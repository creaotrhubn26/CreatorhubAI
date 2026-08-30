import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_ORCHESTRATOR_SHA256, probeRuntimeReadiness, sanitizeText } from "./diagnostics.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-diagnostics-"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 503, ok: false }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeBundledOrchestrator() {
  const files: Record<string, string> = {};
  for (const name of [
    "glimmer-v2.py",
    "glimmer-engineer.py",
    "glimmer_events.py",
    "glimmer_journal.py",
    "glimmer_models.py",
    "glimmer-visual.py",
    "run-github-mcp.sh",
  ]) {
    const content = `# ${name}\n`;
    await fs.writeFile(path.join(root, name), content);
    files[name] = createHash("sha256").update(content).digest("hex");
  }
  await fs.writeFile(
    path.join(root, "ORIGIN.json"),
    JSON.stringify({ commit: "0123456789abcdef", overlay: { id: "durable-test" }, files }),
  );
  return files;
}

async function writeBundledPython() {
  const pythonHome = path.join(root, "python-home");
  const pythonPath = path.join(root, "python3");
  await fs.mkdir(pythonHome, { recursive: true });
  await fs.writeFile(pythonPath, "fake interpreter\n");
  const files: Record<string, string> = {};
  for (const name of [
    "lib/python3.13/os.py",
    "lib/python3.13/ssl.py",
    "lib/python3.13/json/__init__.py",
    "lib/python3.13/sqlite3/__init__.py",
  ]) {
    const target = path.join(pythonHome, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const content = `# ${name}\n`;
    await fs.writeFile(target, content);
    files[name] = createHash("sha256").update(content).digest("hex");
  }
  const treeSitterNativeFiles: Record<string, string> = {};
  for (const name of [
    "tree_sitter/_binding.so",
    "tree_sitter_python/_binding.so",
    "tree_sitter_javascript/_binding.so",
    "tree_sitter_typescript/_binding.so",
    "tree_sitter_rust/_binding.so",
  ]) {
    const relative = path.join("lib/python3.13/site-packages", name);
    const target = path.join(pythonHome, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const content = `native fixture: ${name}\n`;
    await fs.writeFile(target, content);
    treeSitterNativeFiles[relative] = createHash("sha256").update(content).digest("hex");
  }
  await fs.writeFile(
    path.join(pythonHome, "ORIGIN.json"),
    JSON.stringify({
      executableSha256: createHash("sha256").update("fake interpreter\n").digest("hex"),
      files,
      treeSitterNativeFiles,
    }),
  );
  return { pythonHome, pythonPath, files };
}

describe("runtime diagnostics", () => {
  it("pins diagnostics to the race-safe RunPod worker artifact", () => {
    expect(BUNDLED_ORCHESTRATOR_SHA256["runpod_worker.py"]).toBe(
      "b06de735ab48659456f59e188ea173cc839513d918235be4000f9651f6b5e979",
    );
  });

  it("keeps core ready while reporting an offline optional model as degraded", async () => {
    const orchestratorFiles = await writeBundledOrchestrator();
    const python = await writeBundledPython();
    const readiness = await probeRuntimeReadiness({
      orchestratorRoot: root,
      orchestratorBundled: true,
      pythonBundled: true,
      pythonHome: python.pythonHome,
      pythonPath: python.pythonPath,
      expectedPythonFiles: python.files,
      expectedOrchestratorFiles: orchestratorFiles,
      runner: async () => ({ code: 0, stdout: "3.13.15\n", stderr: "" }),
      modelBaseUrl: "http://127.0.0.1:1",
    });

    expect(readiness.coreReady).toBe(true);
    expect(readiness.status).toBe("degraded");
    expect(readiness.components.find((item) => item.id === "python")?.version).toBe("3.13.15");
    expect(readiness.components.find((item) => item.id === "orchestrator")?.version).toBe(
      "0123456789ab+durable-test",
    );
    expect(readiness.components.find((item) => item.id === "model")?.required).toBe(false);
  });

  it("detects a corrupted file from the bundled integrity manifest", async () => {
    const orchestratorFiles = await writeBundledOrchestrator();
    await fs.appendFile(path.join(root, "glimmer-v2.py"), "corrupt\n");
    const readiness = await probeRuntimeReadiness({
      orchestratorRoot: root,
      orchestratorBundled: true,
      expectedOrchestratorFiles: orchestratorFiles,
      runner: async () => ({ code: 0, stdout: "3.13.15\n", stderr: "" }),
      modelBaseUrl: "http://127.0.0.1:1",
    });

    expect(readiness.coreReady).toBe(false);
    expect(readiness.status).toBe("unavailable");
    expect(readiness.components.find((item) => item.id === "orchestrator")?.detail).toContain(
      "glimmer-v2.py",
    );
  });

  it("detects corruption in the bundled Python runtime", async () => {
    const orchestratorFiles = await writeBundledOrchestrator();
    const python = await writeBundledPython();
    await fs.appendFile(path.join(python.pythonHome, "lib/python3.13/os.py"), "corrupt\n");
    const readiness = await probeRuntimeReadiness({
      orchestratorRoot: root,
      orchestratorBundled: true,
      pythonBundled: true,
      pythonHome: python.pythonHome,
      pythonPath: python.pythonPath,
      expectedPythonFiles: python.files,
      expectedOrchestratorFiles: orchestratorFiles,
      runner: async () => ({ code: 0, stdout: "3.13.15\n", stderr: "" }),
      modelBaseUrl: "http://127.0.0.1:1",
    });

    expect(readiness.coreReady).toBe(false);
    expect(readiness.components.find((item) => item.id === "python")?.detail).toContain(
      "os.py checksum mismatch",
    );
  });

  it("redacts home paths and common credential formats from support logs", () => {
    const input = `${os.homedir()}/repo Authorization: Bearer top.secret "apiKey": "abc123" ghp_abcdefghijklmnopqrstuvwxyz sk-ant-abcdefghijklmnopqrstuvwxyz`;
    const output = sanitizeText(input);
    expect(output).toContain("$HOME/repo");
    expect(output).not.toContain("top.secret");
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
  });
});
