import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { probeModel, probeModelProps } from "./modelStatus.js";

let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function listen(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("probeModel", () => {
  it("reports ONLINE when /health returns 2xx", async () => {
    const url = await listen((_req, res) => res.writeHead(200).end("ok"));
    const status = await probeModel(url);
    expect(status.status).toBe("ONLINE");
    expect(status.provenance).toBe("deterministic-backend");
  });

  it("reports REACHABLE_AUTH on 401", async () => {
    const url = await listen((_req, res) => res.writeHead(401).end());
    const status = await probeModel(url);
    expect(status.status).toBe("REACHABLE_AUTH");
    expect(status.httpStatus).toBe(401);
  });

  it("reports OFFLINE when nothing is listening", async () => {
    const status = await probeModel("http://127.0.0.1:1");
    expect(status.status).toBe("OFFLINE");
  });
});

describe("probeModelProps", () => {
  it("extracts contextSize, modelPath, and speculativeDecoding from a real /props shape", async () => {
    const url = await listen((req, res) => {
      if (req.url !== "/props") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        default_generation_settings: { n_ctx: 65536, speculative: true },
        model_path: "/models/muse-glimmer-30b.gguf",
        total_slots: 1,
      }));
    });
    const props = await probeModelProps(url);
    expect(props).toEqual({ contextSize: 65536, modelPath: "/models/muse-glimmer-30b.gguf", speculativeDecoding: true });
  });

  it("returns null when /props doesn't respond, never fabricating fields", async () => {
    const props = await probeModelProps("http://127.0.0.1:1");
    expect(props).toBeNull();
  });

  it("returns null when /props responds but omits every recognized field", async () => {
    const url = await listen((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ chat_template: "x" })));
    const props = await probeModelProps(url);
    expect(props).toBeNull();
  });
});
