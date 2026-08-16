import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { probeModel } from "./modelStatus.js";

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
