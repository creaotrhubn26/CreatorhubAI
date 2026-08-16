// Stands in for glimmer-v2.py: creates its OWN session directory (a name the
// gateway never chose) shortly after start, then writes a manifest there.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
console.log("FAKE ENGINEER RUNNING");
setTimeout(() => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ task: "adopted task", status: "initialized", workspace: "/ws", branch: "glimmer/x", attempts: [] })
  );
}, 200);
