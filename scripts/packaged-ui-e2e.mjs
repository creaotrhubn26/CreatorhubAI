#!/usr/bin/env node

import { chromium } from "playwright";

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);
const appUrl = options.app ?? "http://127.0.0.1:5183";
const gatewayUrl = options.gateway ?? "http://127.0.0.1:4317";
const expectedInstance = options.instance;
const workspace = options.workspace;
if (!workspace) throw new Error("--workspace=<isolated glimmer/* git worktree> is required");

function assert(condition, message) {
  if (!condition) throw new Error(`packaged UI E2E assertion failed: ${message}`);
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Preview server or gateway is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not become ready`);
}

async function readSession(id) {
  const response = await fetch(`${gatewayUrl}/api/sessions/${id}`);
  if (!response.ok) throw new Error(`GET session ${id}: ${response.status}`);
  return response.json();
}

async function waitForStatus(id, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let session;
  while (Date.now() < deadline) {
    session = await readSession(id);
    if (session.status === expected) return session;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`session ${id} did not reach ${expected}; last status ${session?.status}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await waitForHttp(appUrl);
const healthResponse = await waitForHttp(`${gatewayUrl}/api/health`);
assert(healthResponse.ok, `gateway health failed with ${healthResponse.status}`);
const health = await healthResponse.json();
if (expectedInstance) {
  assert(health.instanceId === expectedInstance, `wrong gateway instance ${health.instanceId}`);
}

// A reload exercises the same persistent webview storage boundary that a
// Force Quit crosses before the user has clicked Run.
await page.goto(`${appUrl}/tasks/new`);
await page
  .getByPlaceholder("What should Glimmer work on?")
  .fill("[ui-e2e] restore unsubmitted draft");
await page.getByLabel("Workspace path").fill(workspace);
await page.reload();
assert(
  (await page.getByPlaceholder("What should Glimmer work on?").inputValue()) ===
    "[ui-e2e] restore unsubmitted draft",
  "unsubmitted task draft was not restored after reload",
);
assert(
  (await page.getByLabel("Workspace path").inputValue()) === workspace,
  "unsubmitted workspace draft was not restored after reload",
);

async function composeAndRun(objective, mode = "inspect") {
  await page.goto(`${appUrl}/tasks/new`);
  await page.getByPlaceholder("What should Glimmer work on?").fill(objective);
  await page.getByLabel("Workspace path").fill(workspace);
  await page.getByRole("group", { name: "Mode" }).getByRole("combobox").selectOption(mode);
  await page.getByRole("button", { name: "RUN GLIMMER" }).click();
  await Promise.race([
    page.waitForURL(/\/sessions\/[^/]+$/),
    page
      .getByRole("alert")
      .waitFor()
      .then(async () => {
        throw new Error(`task creation failed in UI: ${await page.getByRole("alert").innerText()}`);
      }),
  ]);
  const id = new URL(page.url()).pathname.split("/").pop();
  assert(id, "session navigation did not contain an id");
  await page.getByRole("heading", { name: objective }).waitFor();
  return id;
}

try {
  const firstId = await composeAndRun("[ui-e2e] create and complete");
  await waitForStatus(firstId, "completed");
  await page.reload();
  await page
    .locator(".ide-session-row.is-active .ide-session-row__meta")
    .getByText(/completed/i)
    .waitFor();
  await page
    .getByText("Packaged-app E2E fixture completed without modifying the repository.")
    .waitFor();

  await page.getByRole("banner").getByRole("button", { name: "New Task" }).click();
  const v2Id = await composeAndRun("[v2-report] verify evidence and code graph");
  await waitForStatus(v2Id, "completed");
  await page.getByText("Only supported claims are presented as facts.").waitFor();
  await page.getByText(/presence · verified/i).waitFor();
  await page.getByText(/graph coverage 75%/i).waitFor();
  await page.getByText(/1 rejected claim/i).waitFor();

  await page.getByRole("banner").getByRole("button", { name: "New Task" }).click();
  const clarificationId = await composeAndRun(
    "[clarification] choose storage before implementation",
    "implement",
  );
  await waitForStatus(clarificationId, "waiting_for_clarification");
  await page.getByRole("region", { name: "Clarification required" }).waitFor();
  await page.getByLabel("SQLite").click();
  await page.getByLabel("Additional context").fill("Reuse the existing schema");
  await page.getByRole("button", { name: "Continue with this answer" }).click();
  await waitForStatus(clarificationId, "verified");

  await page.getByRole("banner").getByRole("button", { name: "New Task" }).click();
  const timeoutId = await composeAndRun(
    "[clarification-timeout] leave the decision unresolved",
    "implement",
  );
  await waitForStatus(timeoutId, "waiting_for_clarification");
  const timedOut = await waitForStatus(timeoutId, "needs_review");
  assert(
    timedOut.failure?.class === "AMBIGUOUS_TASK",
    `clarification timeout did not preserve AMBIGUOUS_TASK (${timedOut.failure?.class})`,
  );

  await page.getByRole("banner").getByRole("button", { name: "New Task" }).click();
  const cancelId = await composeAndRun("[cancel] cancel from the visible UI");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await waitForStatus(cancelId, "cancelled");
  await page.reload();
  await page
    .locator(".ide-session-row.is-active .ide-session-row__meta")
    .getByText(/cancelled/i)
    .waitFor();

  await page.getByRole("banner").getByRole("button", { name: "New Task" }).click();
  const restartedId = await composeAndRun("[ui-e2e] start again after cancel");
  await waitForStatus(restartedId, "completed");
  await page.reload();
  await page
    .locator(".ide-session-row.is-active .ide-session-row__meta")
    .getByText(/completed/i)
    .waitFor();

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Local quality metrics" }).waitFor();
  await page.getByText("Average code-graph coverage").waitFor();
  await page.getByText("75%", { exact: true }).waitFor();
  await page.getByLabel(/Use configured high-risk overrides/i).click();
  await page.getByLabel("Engineer high-risk model").selectOption("local");
  await page.getByLabel("Critic model").selectOption("local");
  await page.getByLabel(/Require a different provider\/model identity/i).click();
  await page.getByRole("button", { name: "Save model registry" }).click();
  await page.getByText(/Model registry saved/i).waitFor();
  await page.getByRole("heading", { name: "System diagnostics" }).waitFor();
  await page.getByText(`Glimmer ${health.version}`).waitFor();
  await page.getByRole("button", { name: "Repair installation" }).click();
  await page.getByText(/Installation is healthy|Writable state repaired/).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export support package" }).click();
  const download = await downloadPromise;
  assert(
    /^glimmer-support-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()),
    `unexpected support filename ${download.suggestedFilename()}`,
  );

  if (options.screenshot) await page.screenshot({ path: options.screenshot, fullPage: true });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        browser: "Google Chrome",
        appVersion: health.version,
        workflow: {
          first: { id: firstId, status: "completed" },
          v2: { id: v2Id, status: "completed" },
          clarification: { id: clarificationId, status: "verified" },
          clarificationTimeout: { id: timeoutId, status: "needs_review" },
          cancelled: { id: cancelId, status: "cancelled" },
          restarted: { id: restartedId, status: "completed" },
        },
        diagnostics: { repair: "healthy", supportExport: download.suggestedFilename() },
        draftRecovery: "restored",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}
