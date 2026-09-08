// Glimmer Browser Bridge — service worker.
// Long-polls the local gateway for verification commands, executes them
// read-only in this browser, and posts results back. Configure the gateway
// URL and capability token on the options page before first use.

const DEFAULT_GATEWAY = "http://127.0.0.1:4317";

async function settings() {
  const stored = await chrome.storage.local.get(["gatewayUrl", "capabilityToken"]);
  return {
    gatewayUrl: (stored.gatewayUrl || DEFAULT_GATEWAY).replace(/\/$/, ""),
    capabilityToken: stored.capabilityToken || "",
  };
}

function isLoopback(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

async function readyTab(url) {
  const existing = await chrome.tabs.query({ url: url.split("#")[0] + "*" });
  let tab = existing[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: true });
  } else {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === "complete") return current;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return chrome.tabs.get(tab.id);
}

async function execute(command) {
  if (!isLoopback(command.url)) throw new Error("bridge commands are loopback-only");
  const tab = await readyTab(command.url);
  if (command.kind === "screenshot") {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { pngBase64: dataUrl.split(",")[1] };
  }
  if (command.kind === "console") {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => window.__glimmerConsole || [],
    });
    return { entries: result };
  }
  if (command.kind === "domText") {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [command.selector || "body"],
      func: (selector) => {
        const node = document.querySelector(selector);
        return node ? node.innerText.slice(0, 200000) : null;
      },
    });
    return { text: result };
  }
  throw new Error("unknown bridge command: " + command.kind);
}

let polling = false;

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const { gatewayUrl, capabilityToken } = await settings();
      const response = await fetch(gatewayUrl + "/api/browser/poll", {
        headers: capabilityToken ? { "X-Glimmer-Capability": capabilityToken } : {},
      });
      if (!response.ok) break;
      const { commands } = await response.json();
      for (const command of commands || []) {
        let body;
        try {
          body = { id: command.id, ok: true, data: await execute(command) };
        } catch (error) {
          body = { id: command.id, ok: false, error: String(error && error.message) };
        }
        await fetch(gatewayUrl + "/api/browser/result", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(capabilityToken ? { "X-Glimmer-Capability": capabilityToken } : {}),
          },
          body: JSON.stringify(body),
        });
      }
    }
  } catch {
    // Gateway down or unreachable; the alarm below restarts the loop.
  } finally {
    polling = false;
  }
}

chrome.runtime.onStartup.addListener(pollLoop);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("glimmer-bridge-keepalive", { periodInMinutes: 0.5 });
  pollLoop();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "glimmer-bridge-keepalive") pollLoop();
});
pollLoop();
