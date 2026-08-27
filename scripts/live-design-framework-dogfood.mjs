import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(`invalid argument: ${key ?? ""}`);
  args.set(key.slice(2), value);
}

const requestedWorkspaces = {
  vue: args.get("vue-workspace"),
  svelte: args.get("svelte-workspace"),
};
if (!requestedWorkspaces.vue || !requestedWorkspaces.svelte) {
  throw new Error(
    "usage: npm run live-design:framework-dogfood -- --vue-workspace <path> --svelte-workspace <path>",
  );
}

const tempRoot = await fs.realpath(os.tmpdir());
const allowedTempRoots = [...new Set([tempRoot, await fs.realpath("/tmp")])];
const workspaces = Object.fromEntries(
  await Promise.all(
    Object.entries(requestedWorkspaces).map(async ([framework, requested]) => {
      const workspace = await fs.realpath(requested);
      const isolated = allowedTempRoots.some((candidateRoot) => {
        const relative = path.relative(candidateRoot, workspace);
        return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!isolated) {
        throw new Error(`${framework} dogfood workspace must be an isolated temporary checkout`);
      }
      return [framework, workspace];
    }),
  ),
);

const targets = [
  {
    framework: "vue",
    workspace: workspaces.vue,
    sessionId: "framework-dogfood-vue",
    entryPath: "index.html",
    sourcePath: "src/App.vue",
    previewPath: "/",
    selector: "h1.title",
    originalText: "Design with confidence",
    replacementText: "Design Vue with confidence",
    structureSelector: 'main[data-testid="vue-shell"]',
    structureTag: "main",
    structureText: "Vue dogfood helper",
  },
  {
    framework: "svelte",
    workspace: workspaces.svelte,
    sessionId: "framework-dogfood-svelte",
    entryPath: "src/app.html",
    sourcePath: "src/routes/+error.svelte",
    previewPath: "/#/missing-live-design-route",
    selector: "button.rounded-md.bg-primary",
    originalText: "Go Home",
    replacementText: "Return Home",
    structureSelector: "button.rounded-md",
    structureTag: "button",
    structureText: "Svelte dogfood helper",
  },
];

const stateRoot = await fs.mkdtemp(path.join(tempRoot, "glimmer-framework-dogfood-state-"));
const children = [];
let parentServer;
let gatewayServer;
let browser;
let gatewayOrigin;
const pendingRevisions = new Map(targets.map((target) => [target.framework, []]));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError ?? "unavailable"}`);
}

async function waitForCondition(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function api(gatewayOrigin, pathname, init = {}) {
  const response = await fetch(`${gatewayOrigin}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: uiOrigin,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${pathname} failed (${response.status}): ${body.error}`,
    );
  }
  return body;
}

async function rollback(gatewayOrigin, target, revisionId) {
  await api(
    gatewayOrigin,
    `/api/sessions/${target.sessionId}/design-bridge/revisions/${revisionId}/rollback`,
    { method: "POST", body: "{}" },
  );
  const pending = pendingRevisions.get(target.framework);
  const index = pending.lastIndexOf(revisionId);
  if (index >= 0) pending.splice(index, 1);
}

async function writeSession(target) {
  const sessionDir = path.join(stateRoot, "sessions", target.sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "manifest.json"),
    JSON.stringify({
      task: `${target.framework} Live Design dogfood`,
      status: "inspect-completed",
      workspace: target.workspace,
      branch: `glimmer/${target.framework}-dogfood`,
      baseline: null,
      attempts: [],
      updatedAt: new Date().toISOString(),
      contract: {
        version: 1,
        mode: "implement",
        objective: `Verify Live Design in ${target.framework}`,
        constraints: [],
        verification: { required: [], recommended: [] },
      },
    }),
  );
}

const appOrigins = {};
const originalSources = new Map();
const originalEntrypoints = new Map();
let uiOrigin;

try {
  for (const target of targets) {
    const branch = (
      await new Promise((resolve, reject) => {
        const child = spawn("git", ["branch", "--show-current"], {
          cwd: target.workspace,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve(output.trim()) : reject(new Error("git branch lookup failed")),
        );
      })
    ).trim();
    assert.equal(branch, `glimmer/${target.framework}-dogfood`);
    originalSources.set(
      target.framework,
      await fs.readFile(path.join(target.workspace, target.sourcePath), "utf8"),
    );
    originalEntrypoints.set(
      target.framework,
      await fs.readFile(path.join(target.workspace, target.entryPath), "utf8"),
    );
    await writeSession(target);
  }

  parentServer = createServer((request, response) => {
    const framework = request.url?.slice(1);
    const appOrigin = appOrigins[framework];
    const target = targets.find((candidate) => candidate.framework === framework);
    if (!appOrigin || !target) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`<!doctype html><html><body style="margin:0"><iframe id="preview" src="${appOrigin}${target.previewPath}" style="width:100vw;height:100vh;border:0"></iframe><script>
      window.bridgeEvents = [];
      const frame = document.getElementById("preview");
      const channel = "framework-dogfood-${framework}";
      const message = (type, payload = {}) => frame.contentWindow.postMessage({ namespace: "glimmer-live-design", channel, type, ...payload }, ${JSON.stringify(appOrigin)});
      window.sendBridge = message;
      window.addEventListener("message", (event) => {
        if (event.origin !== ${JSON.stringify(appOrigin)} || event.source !== frame.contentWindow || event.data?.namespace !== "glimmer-live-design") return;
        window.bridgeEvents.push(event.data);
      });
      setInterval(() => {
        if (!window.bridgeEvents.some((event) => event.type === "ready")) message("init");
      }, 100);
    </script></body></html>`);
  });
  const parentPort = await listen(parentServer);
  uiOrigin = `http://127.0.0.1:${parentPort}`;

  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_UI_ORIGIN = uiOrigin;
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1";
  const { createApp } = await import("../server/dist/app.js");
  gatewayServer = createServer(createApp());
  const gatewayPort = await listen(gatewayServer);
  gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;

  for (const target of targets) {
    const port = await freePort();
    const command =
      target.framework === "vue"
        ? "npm"
        : path.join(target.workspace, "node_modules", ".bin", "vite");
    const commandArgs =
      target.framework === "vue"
        ? ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]
        : ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
    const child = spawn(command, commandArgs, {
      cwd: target.workspace,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output = `${output}${chunk}`.slice(-8_000)));
    child.stderr.on("data", (chunk) => (output = `${output}${chunk}`.slice(-8_000)));
    appOrigins[target.framework] = `http://127.0.0.1:${port}`;
    try {
      await waitFor(appOrigins[target.framework]);
    } catch (error) {
      throw new Error(`${target.framework} dev server failed: ${error}\n${output}`, {
        cause: error,
      });
    }
    target.install = await api(
      gatewayOrigin,
      `/api/sessions/${target.sessionId}/design-bridge/install`,
      {
        method: "POST",
        body: JSON.stringify({
          scriptUrl: `${gatewayOrigin}/api/design-bridge/client.js`,
          parentOrigin: uiOrigin,
        }),
      },
    );
    pendingRevisions.get(target.framework).push(target.install.revision.id);
    assert.equal(target.install.path, target.entryPath);
  }

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const results = [];

  for (const target of targets) {
    await page.goto(`${uiOrigin}/${target.framework}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.bridgeEvents?.some((event) => event.type === "ready"));
    const frame = page.frameLocator("#preview");
    await frame.locator(target.selector).waitFor({ timeout: 30_000 });
    await page.evaluate(() => window.sendBridge("select"));
    await frame.locator(target.selector).click();
    await page.waitForFunction(() =>
      window.bridgeEvents?.some((event) => event.type === "selected"),
    );
    let element = await page.evaluate(
      () => window.bridgeEvents.filter((event) => event.type === "selected").at(-1).element,
    );
    assert.equal(element.framework, target.framework);
    const runtimeSourceMetadata = await frame.locator(target.selector).evaluate((node) => ({
      svelte: node.__svelte_meta,
      frameworkKeys: Object.keys(node).filter(
        (key) => key.includes("svelte") || key.includes("vue") || key.includes("react"),
      ),
    }));
    assert.match(
      element.sourcePathHint ?? "",
      new RegExp(target.sourcePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `${target.framework} source metadata: ${JSON.stringify(runtimeSourceMetadata)}`,
    );

    let resolution = await api(
      gatewayOrigin,
      `/api/sessions/${target.sessionId}/design-bridge/resolve`,
      { method: "POST", body: JSON.stringify({ element }) },
    );
    const textCandidate = resolution.candidates.find(
      (candidate) =>
        candidate.kind === "text-node" &&
        candidate.path === target.sourcePath &&
        candidate.expected === target.originalText,
    );
    assert(textCandidate, `${target.framework} did not resolve its exact source text`);
    assert.equal(textCandidate.confidence, "exact");

    const textApply = await api(
      gatewayOrigin,
      `/api/sessions/${target.sessionId}/design-bridge/apply`,
      {
        method: "POST",
        body: JSON.stringify({ candidate: textCandidate, replacement: target.replacementText }),
      },
    );
    pendingRevisions.get(target.framework).push(textApply.revision.id);
    await frame.getByText(target.replacementText, { exact: true }).waitFor({ timeout: 30_000 });

    const structureApply = await api(
      gatewayOrigin,
      `/api/sessions/${target.sessionId}/design-bridge/structure`,
      {
        method: "POST",
        body: JSON.stringify({
          kind: "insert",
          target: {
            selector: target.structureSelector,
            tagName: target.structureTag,
            text: target.replacementText,
            attributes: {},
            sourcePathHint: target.sourcePath,
            framework: target.framework,
          },
          placement: "after",
          preset: "paragraph",
          text: target.structureText,
        }),
      },
    );
    pendingRevisions.get(target.framework).push(structureApply.revision.id);
    await frame.getByText(target.structureText, { exact: true }).waitFor({ timeout: 30_000 });

    let styleApply = null;
    if (target.framework === "vue") {
      await page.evaluate(() => window.sendBridge("describe-selector", { selector: "h1.title" }));
      await page.waitForFunction(
        (text) =>
          window.bridgeEvents?.filter((event) => event.type === "selected").at(-1)?.element
            ?.text === text,
        target.replacementText,
      );
      element = await page.evaluate(
        () => window.bridgeEvents.filter((event) => event.type === "selected").at(-1).element,
      );
      resolution = await api(
        gatewayOrigin,
        `/api/sessions/${target.sessionId}/design-bridge/resolve`,
        { method: "POST", body: JSON.stringify({ element }) },
      );
      const styleCandidate = resolution.candidates.find(
        (candidate) =>
          candidate.kind === "css-declaration" &&
          candidate.path === target.sourcePath &&
          candidate.property === "font-size",
      );
      assert(styleCandidate, "Vue did not resolve its co-located style block");
      styleApply = await api(
        gatewayOrigin,
        `/api/sessions/${target.sessionId}/design-bridge/style-override`,
        {
          method: "POST",
          body: JSON.stringify({
            element,
            source: styleCandidate,
            scope: "component",
            className: "title",
            declarations: { display: "grid", gap: "12px" },
          }),
        },
      );
      pendingRevisions.get(target.framework).push(styleApply.revision.id);
      const heading = frame.locator("h1.title");
      await heading.waitFor();
      await waitForCondition(async () => {
        const computed = await heading.evaluate((node) => ({
          display: getComputedStyle(node).display,
          gap: getComputedStyle(node).gap,
        }));
        return computed.display === "grid" && computed.gap === "12px";
      }, "the Vue co-located style override to reach the rendered app");
    }

    const revisions = [
      styleApply?.revision.id,
      structureApply.revision.id,
      textApply.revision.id,
    ].filter(Boolean);
    for (const revisionId of revisions) {
      await rollback(gatewayOrigin, target, revisionId);
    }
    await rollback(gatewayOrigin, target, target.install.revision.id);
    assert.equal(
      await fs.readFile(path.join(target.workspace, target.sourcePath), "utf8"),
      originalSources.get(target.framework),
    );
    assert.equal(
      await fs.readFile(path.join(target.workspace, target.entryPath), "utf8"),
      originalEntrypoints.get(target.framework),
    );
    results.push({
      framework: target.framework,
      sourcePathHint: element.sourcePathHint,
      exactSourceResolution: true,
      hmrPersistedText: true,
      hmrPersistedStructure: true,
      coLocatedStylePersisted: target.framework === "vue",
      rollbackRestoredSource: true,
      bridgeInstallRollbackRestoredEntrypoint: true,
    });
  }

  if (browserErrors.length) throw new Error(`browser errors: ${browserErrors.join("; ")}`);
  console.log(JSON.stringify({ ok: true, results }));
} finally {
  if (gatewayOrigin) {
    for (const target of [...targets].reverse()) {
      const revisions = [...pendingRevisions.get(target.framework)].reverse();
      for (const revisionId of revisions) {
        await rollback(gatewayOrigin, target, revisionId).catch(() => undefined);
      }
    }
  }
  await browser?.close().catch(() => undefined);
  await Promise.all(children.map(stopChild));
  await close(gatewayServer);
  await close(parentServer);
  await fs.rm(stateRoot, { recursive: true, force: true });
}
