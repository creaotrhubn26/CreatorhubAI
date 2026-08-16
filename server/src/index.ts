import { createApp } from "./app";
import { CONFIG } from "./config";

const app = createApp();
app.listen(CONFIG.port, () => {
  console.log(`Glimmer Local API listening on http://127.0.0.1:${CONFIG.port}`);
});
