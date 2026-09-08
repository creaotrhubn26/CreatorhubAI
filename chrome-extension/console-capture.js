// Runs in the page's MAIN world at document_start on loopback pages only.
// Buffers console output and uncaught errors so the bridge can dump them as
// verification evidence. Read-only: nothing on the page is modified beyond
// wrapping the console methods.
(() => {
  if (window.__glimmerConsole) return;
  const buffer = [];
  const MAX_ENTRIES = 500;
  const push = (level, parts) => {
    if (buffer.length >= MAX_ENTRIES) buffer.shift();
    buffer.push({
      level,
      at: new Date().toISOString(),
      text: parts
        .map((part) => {
          if (typeof part === "string") return part;
          try {
            return JSON.stringify(part);
          } catch {
            return String(part);
          }
        })
        .join(" ")
        .slice(0, 2000),
    });
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...parts) => {
      push(level, parts);
      original(...parts);
    };
  }
  window.addEventListener("error", (event) => {
    push("uncaught", [event.message, event.filename + ":" + event.lineno]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    push("unhandledrejection", [String(event.reason)]);
  });
  window.__glimmerConsole = buffer;
})();
