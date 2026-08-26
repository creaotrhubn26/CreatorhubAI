#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);
const appUrl = options.app ?? "http://127.0.0.1:5183";
const gatewayUrl = options.gateway ?? "http://127.0.0.1:4317";
const workspace = options.workspace;
if (!workspace) throw new Error("--workspace=<isolated glimmer/* git worktree> is required");

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  ({ chromium } = require(path.join(globalModules, "playwright")));
}

function assert(condition, message) {
  if (!condition) throw new Error(`packaged UI E2E assertion failed: ${message}`);
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
const healthResponse = await fetch(`${gatewayUrl}/api/health`);
assert(healthResponse.ok, `gateway health failed with ${healthResponse.status}`);
const health = await healthResponse.json();

async function composeAndRun(objective) {
  await page.goto(`${appUrl}/tasks/new`);
  await page.getByPlaceholder("What should Glimmer work on?").fill(objective);
  await page.getByLabel("Workspace path").fill(workspace);
  await page.getByRole("group", { name: "Mode" }).getByRole("combobox").selectOption("inspect");
  await page.getByRole("button", { name: "RUN GLIMMER" }).click();
  await page.waitForURL(/\/sessions\/[^/]+$/);
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
          cancelled: { id: cancelId, status: "cancelled" },
          restarted: { id: restartedId, status: "completed" },
        },
        diagnostics: { repair: "healthy", supportExport: download.suggestedFilename() },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}
