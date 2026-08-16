import { createApp } from "./app.js";
import { CONFIG } from "./config.js";

const app = createApp();
// Loopback only: this API can spawn processes, so it must never be reachable
// from other hosts on the network.
app.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`Glimmer Local API listening on http://127.0.0.1:${CONFIG.port}`);
});
