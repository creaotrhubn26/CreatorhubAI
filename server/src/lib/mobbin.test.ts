import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mobbinStatus, readMobbinImage, saveMobbinApiKey, searchMobbin } from "./mobbin.js";

let root: string;
let keyPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-mobbin-"));
  keyPath = path.join(root, "mobbin-api-key.txt");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Mobbin integration", () => {
  it("stores the key owner-readable and reports only configured state", async () => {
    await saveMobbinApiKey({ apiKey: "secret-mobbin-key" }, keyPath);
    const stat = await fs.stat(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const status = await mobbinStatus(keyPath);
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret-mobbin-key");
  });

  it("calls only the fixed official endpoint and sanitizes the response", async () => {
    await saveMobbinApiKey({ apiKey: "secret-mobbin-key" }, keyPath);
    let calledUrl = "";
    let authorization = "";
    const result = await searchMobbin(
      { query: "checkout with Apple Pay", platform: "web", limit: 3 },
      {
        keyPath,
        fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
          calledUrl = String(input);
          authorization = new Headers(init?.headers).get("Authorization") ?? "";
          return new Response(
            JSON.stringify({
              screens: [
                {
                  id: "screen-1",
                  image_url: "https://images.example-cdn.com/screen.jpg",
                  mobbin_url: "https://mobbin.com/screens/screen-1",
                  app_name: "Example",
                  platform: "web",
                },
                {
                  id: "unsafe",
                  image_url: "http://127.0.0.1/private",
                  mobbin_url: "https://example.com/fake",
                  app_name: "Unsafe",
                  platform: "web",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as typeof fetch,
      },
    );
    expect(calledUrl).toBe("https://api.mobbin.com/v1/screens/search");
    expect(authorization).toBe("Bearer secret-mobbin-key");
    expect(result.screens).toHaveLength(1);
    expect(result.screens[0]).toMatchObject({ id: "screen-1", appName: "Example" });
    expect(result.screens[0].imageToken).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
    );
    expect(JSON.stringify(result)).not.toContain("images.example-cdn.com");

    let imageUrl = "";
    const image = await readMobbinImage(result.screens[0].imageToken, (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      imageUrl = String(input);
      expect(init?.redirect).toBe("error");
      return new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      });
    }) as typeof fetch);
    expect(imageUrl).toBe("https://images.example-cdn.com/screen.jpg");
    expect(image.contentType).toBe("image/png");
    expect([...image.bytes]).toEqual([137, 80, 78, 71]);
  });

  it("rejects unknown image tokens and non-image upstream responses", async () => {
    await expect(
      readMobbinImage("not-a-token", vi.fn() as unknown as typeof fetch),
    ).rejects.toMatchObject({ status: 404 });

    await saveMobbinApiKey({ apiKey: "secret-mobbin-key" }, keyPath);
    const result = await searchMobbin(
      { query: "checkout", platform: "web" },
      {
        keyPath,
        fetcher: (async () =>
          new Response(
            JSON.stringify({
              screens: [
                {
                  id: "screen-invalid-preview",
                  image_url: "https://images.example-cdn.com/not-an-image",
                  mobbin_url: "https://mobbin.com/screens/screen-invalid-preview",
                  app_name: "Example",
                  platform: "web",
                },
              ],
            }),
            { headers: { "Content-Type": "application/json" } },
          )) as typeof fetch,
      },
    );
    await expect(
      readMobbinImage(
        result.screens[0].imageToken,
        (async () =>
          new Response("not an image", {
            headers: { "Content-Type": "text/plain" },
          })) as typeof fetch,
      ),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("rejects unconfigured searches and unsupported request fields", async () => {
    await expect(searchMobbin({ query: "login", platform: "ios" }, { keyPath })).rejects.toThrow(
      /connect/i,
    );
    await saveMobbinApiKey({ apiKey: "secret-mobbin-key" }, keyPath);
    await expect(
      searchMobbin({ query: "login", platform: "ios", url: "https://evil" } as any, { keyPath }),
    ).rejects.toThrow(/unsupported/i);
  });
});
