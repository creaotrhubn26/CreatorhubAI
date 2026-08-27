import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workflow-e2e-state-"));
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-workflow-e2e-workspace-"));
const sessionId = "design-workflow-e2e";
const gatewayPort = 4329;
const uiPort = 5195;
const previewPort = 5196;
const uiOrigin = `http://127.0.0.1:${uiPort}`;
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
const previewOrigin = `http://127.0.0.1:${previewPort}`;
const sessionDir = path.join(stateRoot, "sessions", sessionId);
const visualDir = path.join(sessionDir, "visual");
const artifact = path.join(root, "artifacts", "glimmer-design-workflow-v1.png");
const structureArtifact = path.join(root, "artifacts", "glimmer-structure-mode-v1.png");
const designerArtifact = path.join(root, "artifacts", "glimmer-designer-v2.png");
const elementPromptArtifact = path.join(root, "artifacts", "glimmer-element-prompt-v1.png");
const children = [];
let gatewayServer;
let previewServer;
let browser;

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function close(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The dev server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function waitForCondition(check, label, timeoutMs = 20_000) {
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

try {
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(visualDir, { recursive: true });
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "src", "App.tsx"),
    'export function App() { return <main data-testid="settings-shell"><h1 className="title">Settings</h1><p data-testid="description">Manage your workspace preferences.</p></main>; }\n',
  );
  await fs.writeFile(
    path.join(workspace, "src", "theme.css"),
    ":root { --color-accent: #72d6cc; }\n.title { color: var(--color-accent); font-size: 32px; padding: 8px; }\n",
  );
  await exec("git", ["init", "-q"], { cwd: workspace });
  await exec("git", ["config", "user.email", "workflow-e2e@example.com"], { cwd: workspace });
  await exec("git", ["config", "user.name", "Workflow E2E"], { cwd: workspace });
  await exec("git", ["add", "src"], { cwd: workspace });
  await exec("git", ["commit", "-q", "-m", "fixture"], { cwd: workspace });
  await exec("git", ["switch", "-q", "-c", "glimmer/design-workflow-e2e"], { cwd: workspace });

  const manifest = {
    task: "Improve the settings heading through the design workflow",
    status: "inspect-completed",
    workspace,
    branch: "glimmer/design-workflow-e2e",
    baseline: null,
    attempts: [],
    updatedAt: new Date().toISOString(),
    contract: {
      version: 1,
      mode: "implement",
      objective: "Improve the settings heading",
      constraints: [],
      verification: { required: [], recommended: [] },
    },
  };
  await fs.writeFile(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest));
  const captures = [
    {
      viewport: "390x844",
      state: "initial",
      screenshot: "mobile.png",
      status: "captured",
      error: null,
    },
    {
      viewport: "1280x720",
      state: "initial",
      screenshot: "desktop.png",
      status: "captured",
      error: null,
    },
  ];
  await fs.writeFile(
    path.join(visualDir, "visual-manifest.json"),
    JSON.stringify({
      route: `${previewOrigin}/settings`,
      viewports: ["390x844", "1280x720"],
      states: ["initial"],
      status: "pass",
      captures,
    }),
  );
  await fs.writeFile(
    path.join(visualDir, "findings.json"),
    JSON.stringify({
      status: "PASS",
      viewport: "multi",
      viewports: ["390x844", "1280x720"],
      findings: [],
    }),
  );
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await Promise.all([
    fs.writeFile(path.join(visualDir, "mobile.png"), pixel),
    fs.writeFile(path.join(visualDir, "desktop.png"), pixel),
  ]);

  process.env.GLIMMER_STATE_ROOT = stateRoot;
  process.env.GLIMMER_UI_ORIGIN = uiOrigin;
  process.env.GLIMMER_MODEL_URL = "http://127.0.0.1:1";
  process.env.PORT = String(gatewayPort);
  const { createApp } = await import("../server/dist/app.js");
  gatewayServer = createServer(createApp());
  await listen(gatewayServer, gatewayPort);

  previewServer = createServer(async (request, response) => {
    if (request.url !== "/settings" && request.url !== "/") {
      response.writeHead(404).end();
      return;
    }
    const source = await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8");
    const theme = await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8");
    const heading = source.match(/className="title">([^<]+)</)?.[1] ?? "Settings";
    const paragraphs = Array.from(source.matchAll(/<p(?:\s[^>]*)?>([^<]+)<\/p>/g), (match) =>
      match[0].includes('data-testid="description"')
        ? `<p data-testid="description">${match[1]}</p>`
        : `<p>${match[1]}</p>`,
    ).join("");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><head><style>
        :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
        body { margin: 0; background: #101315; color: #f5f7f7; }
        main { min-height: 100vh; display: grid; place-content: center; text-align: center; }
        ${theme}
      </style></head><body><main data-testid="settings-shell"><h1 class="title">${heading}</h1>${paragraphs}</main>
      <script src="${gatewayOrigin}/api/design-bridge/client.js" data-glimmer-parent="${uiOrigin}"></script>
      </body></html>`);
  });
  await listen(previewServer, previewPort);

  const vite = spawn(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "dev", "--workspace", "web", "--", "--host", "127.0.0.1", "--port", String(uiPort)],
    {
      cwd: root,
      env: { ...process.env, VITE_API_BASE: gatewayOrigin },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(vite);
  let viteOutput = "";
  vite.stdout.on("data", (chunk) => {
    viteOutput += chunk.toString();
  });
  vite.stderr.on("data", (chunk) => {
    viteOutput += chunk.toString();
  });
  try {
    await waitFor(uiOrigin);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${viteOutput}`, {
      cause: error,
    });
  }

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1540, height: 1100 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${uiOrigin}/sessions/${sessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Visual Verification/ }).click();
  await page.getByRole("button", { name: "Live edit" }).click();
  await page.getByText("Turn visual ideas into verified changes").waitFor();
  await page.getByRole("button", { name: "Keyboard shortcuts" }).click();
  await page.getByRole("dialog", { name: "Live Design keyboard shortcuts" }).waitFor();
  await page.getByRole("button", { name: "Close shortcuts" }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.locator(".live-design-bridge__inspector").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Exit preview" }).click();
  await page.locator(".live-design-bridge__inspector").waitFor({ state: "visible" });

  await page
    .getByLabel("What should become better?")
    .fill(
      "Make the settings heading clearer while preserving the existing token and responsive layout.",
    );
  await page.getByRole("button", { name: "Start workflow" }).click();
  await page.getByText("Continuously saved · revision 1").waitFor();

  await page.getByRole("button", { name: "Select element" }).click();
  const preview = page.frameLocator('iframe[title="Live app preview"]');
  await preview.locator("h1.title").click();
  await page
    .locator(".live-design-bridge__selection-title strong")
    .filter({ hasText: "h1" })
    .waitFor();
  await page.locator(".live-design-bridge__tool-dock").waitFor({ state: "visible" });
  await page
    .getByLabel("Ask Glimmer about this element")
    .fill("Give this heading stronger hierarchy without changing its design tokens.");
  const generateElementRequest = page.getByRole("button", { name: "Generate preview" });
  await waitForCondition(
    async () => !(await generateElementRequest.isDisabled()),
    "the targeted element request to become ready",
  );
  await generateElementRequest.click();
  await page.getByRole("region", { name: "Glimmer design proposal" }).waitFor();
  await page.getByText("Safe fallback", { exact: true }).waitFor();
  await waitForCondition(async () => {
    try {
      const journal = JSON.parse(
        await fs.readFile(path.join(sessionDir, "live-design-draft.json"), "utf8"),
      );
      return journal.proposal?.prompt?.includes("stronger hierarchy") && journal.draft?.fontSizePx;
    } catch {
      return false;
    }
  }, "the proposal preview to reach the recovery journal");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Visual Verification/ }).click();
  await page.getByRole("button", { name: "Live edit" }).click();
  await page.getByRole("region", { name: "Glimmer design proposal" }).waitFor();
  await page.getByText(/Recovered unsaved Live Design progress|Selection restored/).waitFor();
  await page.screenshot({ path: elementPromptArtifact, fullPage: true });
  const acceptElementRequest = page.getByRole("button", { name: "Accept and queue" });
  await waitForCondition(
    async () => !(await acceptElementRequest.isDisabled()),
    "the recovered proposal to become acceptable",
  );
  await acceptElementRequest.click();
  await waitForCondition(async () => {
    try {
      const savedFeedback = JSON.parse(
        await fs.readFile(path.join(sessionDir, "design-feedback.json"), "utf8"),
      );
      return savedFeedback.annotations?.some(
        (annotation) =>
          annotation.comment ===
            "Give this heading stronger hierarchy without changing its design tokens." &&
          annotation.selectorHint?.includes("h1"),
      );
    } catch {
      return false;
    }
  }, "the targeted element request to persist");
  await page.getByText(/Continuously saved · revision 2/).waitFor();

  await page.getByRole("button", { name: "Select element" }).click();
  await preview.locator('p[data-testid="description"]').click({ modifiers: ["Shift"] });
  await page.getByText("2 selected", { exact: true }).waitFor();
  await page.locator(".live-design-multi-selection button").filter({ hasText: "p ×" }).click();
  await page
    .locator(".live-design-bridge__selection-title strong")
    .filter({ hasText: "h1" })
    .waitFor();
  await page.getByLabel("Text").fill("Workspace settings");
  await page.getByRole("button", { name: "Queue remaining changes" }).click();
  await page.getByText(/Continuously saved · revision 3/).waitFor();

  await page.getByRole("button", { name: "Send to review →" }).click();
  await page.getByRole("button", { name: "Approve implementation →" }).click();
  await page.getByText("Approved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save text to source" }).click();
  await waitForCondition(async () => {
    const currentSource = await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8");
    const currentWorkflow = JSON.parse(
      await fs.readFile(path.join(sessionDir, "design-workflow.json"), "utf8"),
    );
    const currentChangeSet = currentWorkflow.changeSets.find(
      (item) => item.id === currentWorkflow.activeChangeSetId,
    );
    return (
      currentSource.includes(">Workspace settings<") && currentChangeSet?.revisionIds?.length === 1
    );
  }, "the text revision to reach source and workflow storage");

  await page.getByRole("button", { name: "Structure mode" }).click();
  await page.getByText(/DOM elements/).waitFor();
  await page.getByRole("searchbox", { name: "Search Navigator" }).fill("settings");
  await page.getByRole("button", { name: "Select h1" }).waitFor();
  await page.getByRole("button", { name: "Lock", exact: true }).click();
  if (!(await page.getByRole("button", { name: "Move selected element down" }).isDisabled())) {
    throw new Error("navigator lock did not prevent structural movement");
  }
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await waitForCondition(
    async () =>
      (await preview.locator("h1.title").evaluate((node) => getComputedStyle(node).visibility)) ===
      "hidden",
    "navigator preview visibility to hide the selected heading",
  );
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search Navigator" }).fill("");
  await page.getByRole("combobox", { name: "Element" }).selectOption("paragraph");
  await page.getByRole("combobox", { name: "Position" }).selectOption("after");
  await page.getByRole("textbox", { name: "Starter text" }).fill("Invite your team");
  await page.getByRole("button", { name: "Preview insert" }).click();
  await preview.getByText("Invite your team").waitFor();
  const saveStructure = page.getByRole("button", { name: "Save structure to source" });
  const frameBeforeStructureSave = await page
    .locator('iframe[title="Live app preview"]')
    .elementHandle();
  await saveStructure.click();
  await saveStructure.waitFor({ state: "detached" });
  await waitForCondition(
    async () =>
      (await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8")).includes(
        "Invite your team",
      ),
    "the inserted element to reach App.tsx",
  );
  await waitForCondition(
    async () => !(await frameBeforeStructureSave?.evaluate((node) => node.isConnected)),
    "the preview reload after structure save",
  );
  await preview.getByText("Invite your team").waitFor();
  await page.screenshot({ path: structureArtifact, fullPage: true });

  await page.getByRole("tab", { name: "Responsive" }).click();
  await page.getByRole("combobox", { name: "Property" }).selectOption("font-size");
  await page.getByRole("textbox", { name: "Value" }).fill("24px");
  await page.getByRole("button", { name: "Preview at mobile" }).click();
  await page.getByText(/Responsive override staged/).waitFor();
  await preview.locator("h1.title").waitFor();
  try {
    await waitForCondition(
      async () =>
        (await preview.locator("h1.title").evaluate((node) => getComputedStyle(node).fontSize)) ===
        "24px",
      "the mobile responsive preview to become active",
    );
  } catch (error) {
    const diagnostics = await preview.locator("h1.title").evaluate((node) => ({
      innerWidth: window.innerWidth,
      computedFontSize: getComputedStyle(node).fontSize,
      previewRule:
        document.querySelector('[data-glimmer-responsive-preview="true"]')?.textContent ?? null,
    }));
    throw new Error(
      `${error instanceof Error ? error.message : error}: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
  const saveResponsive = page.getByRole("button", { name: "Save override to source" });
  const frameBeforeResponsiveSave = await page
    .locator('iframe[title="Live app preview"]')
    .elementHandle();
  await saveResponsive.click();
  await waitForCondition(
    async () =>
      (await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).includes(
        "glimmer-responsive:",
      ),
    "the responsive override to reach theme.css",
  );
  await waitForCondition(() => saveResponsive.isDisabled(), "the responsive save to finish");
  await waitForCondition(
    async () => !(await frameBeforeResponsiveSave?.evaluate((node) => node.isConnected)),
    "the preview reload after responsive save",
  );
  await preview.locator("h1.title").waitFor();
  await waitForCondition(
    async () =>
      (await preview.locator("h1.title").evaluate((node) => getComputedStyle(node).fontSize)) ===
      "24px",
    "the responsive source override to survive preview reload",
  );

  const resizeButton = page.getByRole("button", { name: "Transform handles" });
  await resizeButton.waitFor();
  await resizeButton.click();
  const moveHandle = preview.locator('[data-glimmer-resize-handle="move"]');
  await moveHandle.waitFor({ state: "visible" });
  const positionSection = page.locator("details.live-design-layout__section").filter({
    has: page.locator("summary", { hasText: "Position" }),
  });
  await positionSection.locator("summary").click();
  const leftInput = page.getByLabel("Left", { exact: true });
  const topInput = page.getByLabel("Top", { exact: true });
  const initialLeft = await leftInput.inputValue();
  const initialTop = await topInput.inputValue();
  const movePoint = await moveHandle.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await moveHandle.dispatchEvent("pointerdown", {
    pointerId: 2,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: movePoint.x,
    clientY: movePoint.y,
  });
  await preview.locator("html").dispatchEvent("pointermove", {
    pointerId: 2,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: movePoint.x + 20,
    clientY: movePoint.y + 12,
  });
  await preview.locator("html").dispatchEvent("pointerup", {
    pointerId: 2,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: movePoint.x + 20,
    clientY: movePoint.y + 12,
  });
  await waitForCondition(
    async () =>
      (await leftInput.inputValue()) !== initialLeft &&
      (await topInput.inputValue()) !== initialTop,
    "move drag to update the inspector offsets",
  );
  const cornerHandle = preview.locator('[data-glimmer-resize-handle="corner"]');
  await cornerHandle.waitFor({ state: "visible" });
  const widthInput = page.getByRole("textbox", { name: "Width", exact: true });
  const heightInput = page.getByRole("textbox", { name: "Height", exact: true });
  const initialWidth = await widthInput.inputValue();
  const initialHeight = await heightInput.inputValue();
  const resizePoint = await cornerHandle.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await cornerHandle.dispatchEvent("pointerdown", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: resizePoint.x,
    clientY: resizePoint.y,
  });
  await preview.locator("html").dispatchEvent("pointermove", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: resizePoint.x + 48,
    clientY: resizePoint.y + 24,
  });
  await preview.locator("html").dispatchEvent("pointerup", {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: resizePoint.x + 48,
    clientY: resizePoint.y + 24,
  });
  await waitForCondition(
    async () =>
      (await widthInput.inputValue()) !== initialWidth &&
      (await heightInput.inputValue()) !== initialHeight,
    "resize drag to update the inspector dimensions",
  );
  const resizedWidth = await widthInput.inputValue();
  const resizedHeight = await heightInput.inputValue();
  if (!/^\d+px$/.test(resizedWidth) || !/^\d+px$/.test(resizedHeight)) {
    throw new Error(
      `resize handles did not update inspector dimensions: ${resizedWidth} × ${resizedHeight}`,
    );
  }
  await page.getByRole("button", { name: "Flex", exact: true }).click();
  await page.getByRole("button", { name: "Align center center" }).click();
  await page.getByRole("button", { name: "Increase Padding" }).click();
  await page.getByRole("tab", { name: "Component" }).click();
  await page.getByRole("button", { name: /All matching instances/ }).click();
  await page.getByText(/Active scope: reusable component/).waitFor();
  await page.getByRole("button", { name: "Continue to layout" }).click();
  await page.getByText(/staged layout rules/).waitFor();
  const saveLayout = page.getByRole("button", { name: "Save layout to source" });
  await saveLayout.waitFor();
  try {
    await waitForCondition(
      async () => !(await saveLayout.isDisabled()),
      "layout save to become ready",
      5_000,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}: ${await saveLayout.getAttribute("title")}`,
      { cause: error },
    );
  }
  const frameBeforeLayoutSave = await page
    .locator('iframe[title="Live app preview"]')
    .elementHandle();
  await saveLayout.click();
  await waitForCondition(
    async () =>
      (await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).includes(
        "glimmer-style:",
      ),
    "the visual layout override to reach theme.css",
  );
  await waitForCondition(
    async () => !(await frameBeforeLayoutSave?.evaluate((node) => node.isConnected)),
    "the preview reload after layout save",
  );
  await preview.locator("h1.title").waitFor();
  const persistedLayout = await preview.locator("h1.title").evaluate((node) => ({
    width: getComputedStyle(node).width,
    height: getComputedStyle(node).height,
    boxSizing: getComputedStyle(node).boxSizing,
  }));
  if (persistedLayout.boxSizing !== "border-box") {
    throw new Error(`layout override did not survive reload: ${JSON.stringify(persistedLayout)}`);
  }
  await page.getByRole("button", { name: "Save layout to source" }).waitFor();
  await page.screenshot({ path: designerArtifact, fullPage: true });

  await page.getByRole("button", { name: "Verify across viewports →" }).click();
  await page.getByText("390x844 · initial").waitFor();
  await page.getByText("1280x720 · initial").waitFor();
  await page.getByRole("button", { name: "Mark delivered →" }).click();
  await page.getByText("Delivered", { exact: true }).waitFor();
  await page.screenshot({ path: artifact, fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Visual Verification/ }).click();
  await page.getByRole("button", { name: "Live edit" }).click();
  await page.getByText("Delivered", { exact: true }).waitFor();
  await page.getByText(/Continuously saved · revision/).waitFor();
  const persistedWorkflow = JSON.parse(
    await fs.readFile(path.join(sessionDir, "design-workflow.json"), "utf8"),
  );
  const persistedChangeSet = persistedWorkflow.changeSets.find(
    (item) => item.id === persistedWorkflow.activeChangeSetId,
  );
  if (persistedChangeSet?.revisionIds?.length !== 4) {
    throw new Error(
      `workflow persisted ${persistedChangeSet?.revisionIds?.length ?? 0} source revisions instead of 4`,
    );
  }
  await page.getByRole("button", { name: "Reopen workflow" }).click();
  await page.getByRole("button", { name: "Roll back change set" }).click();
  await page.getByRole("button", { name: "Confirm rollback" }).click();
  await waitForCondition(async () => {
    const currentSource = await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8");
    const currentTheme = await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8");
    return (
      currentSource.includes(">Settings<") &&
      !currentSource.includes("Invite your team") &&
      !currentTheme.includes("glimmer-responsive:") &&
      !currentTheme.includes("glimmer-style:")
    );
  }, "all four source revisions to roll back");
  const revisionDirectory = path.join(sessionDir, "design-bridge", "revisions");
  let rolledBackRevisions = [];
  await waitForCondition(async () => {
    rolledBackRevisions = await Promise.all(
      persistedChangeSet.revisionIds.map(async (revisionId) =>
        JSON.parse(await fs.readFile(path.join(revisionDirectory, `${revisionId}.json`), "utf8")),
      ),
    );
    return rolledBackRevisions.every((item) => item.status === "rolled-back");
  }, "every durable revision to persist its rolled-back status");
  const restored = await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8");
  if (!restored.includes(">Settings<")) throw new Error("combined rollback did not restore source");
  if (restored.includes("Invite your team"))
    throw new Error("combined rollback kept inserted source");
  const restoredTheme = await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8");
  if (restoredTheme.includes("glimmer-responsive:")) {
    throw new Error("combined rollback kept the responsive override");
  }
  if (restoredTheme.includes("glimmer-style:")) {
    throw new Error("combined rollback kept the visual layout override");
  }
  if (pageErrors.length) throw new Error(`browser page errors: ${pageErrors.join("; ")}`);

  console.log(
    JSON.stringify({
      ok: true,
      sessionId,
      workflowPersistedAcrossReload: true,
      combinedRollbackRestoredSource: true,
      screenshot: artifact,
      structureScreenshot: structureArtifact,
      designerScreenshot: designerArtifact,
      elementPromptScreenshot: elementPromptArtifact,
    }),
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await Promise.all(children.map(stopChild));
  await close(previewServer);
  await close(gatewayServer);
  await fs.rm(stateRoot, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
}
