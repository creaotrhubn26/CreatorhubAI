import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import type { VisualManifest } from "@glimmer/shared";

const sessionId = "visual.regression-test";
const changeSetId = "change-set-1";
let stateRoot: string;
let visualDir: string;
let regression: typeof import("./visualRegression.js");

function image(
  width: number,
  height: number,
  color: [number, number, number, number],
  changed: Array<{ x: number; y: number; color: [number, number, number, number] }> = [],
): Buffer {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = color[3];
  }
  for (const pixel of changed) {
    const offset = (pixel.y * width + pixel.x) * 4;
    png.data[offset] = pixel.color[0];
    png.data[offset + 1] = pixel.color[1];
    png.data[offset + 2] = pixel.color[2];
    png.data[offset + 3] = pixel.color[3];
  }
  return PNG.sync.write(png);
}

function manifest(screenshot = "1280x720-initial.png"): VisualManifest {
  return {
    route: "http://127.0.0.1:5196/settings",
    viewports: ["1280x720"],
    states: ["initial"],
    status: "pass",
    captures: [
      {
        viewport: "1280x720",
        state: "initial",
        screenshot,
        status: "captured",
        error: null,
      },
    ],
  };
}

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-visual-regression-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  visualDir = path.join(stateRoot, "sessions", sessionId, "visual");
  await fs.mkdir(visualDir, { recursive: true });
  regression = await import("./visualRegression.js");
});

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
});

describe("visual regression evidence", () => {
  it("captures an immutable PNG baseline and passes an identical comparison", async () => {
    const screenshot = path.join(visualDir, "1280x720-initial.png");
    await fs.writeFile(screenshot, image(10, 10, [18, 24, 31, 255]));

    const baseline = await regression.captureVisualRegressionBaseline(
      sessionId,
      changeSetId,
      manifest(),
    );
    expect(baseline.captures[0]).toMatchObject({
      viewport: "1280x720",
      state: "initial",
      width: 10,
      height: 10,
    });

    const report = await regression.compareVisualRegression(sessionId, changeSetId, manifest());
    expect(report).toMatchObject({
      status: "passed",
      comparisons: [
        {
          status: "passed",
          changedPixels: 0,
          totalPixels: 100,
          differenceRatio: 0,
        },
      ],
    });
    const diff = report?.comparisons[0].diffScreenshot;
    expect(diff).toBeTruthy();
    await expect(
      fs.access(regression.visualRegressionImagePath(sessionId, changeSetId, "diff", diff!)!),
    ).resolves.toBeUndefined();
  });

  it("fails closed and persists a reviewable diff above the one-percent threshold", async () => {
    const screenshot = path.join(visualDir, "1280x720-initial.png");
    await fs.writeFile(
      screenshot,
      image(
        10,
        10,
        [18, 24, 31, 255],
        [
          { x: 0, y: 0, color: [255, 255, 255, 255] },
          { x: 1, y: 0, color: [255, 255, 255, 255] },
        ],
      ),
    );

    const report = await regression.compareVisualRegression(sessionId, changeSetId, manifest());
    expect(report).toMatchObject({
      status: "failed",
      comparisons: [
        {
          status: "failed",
          changedPixels: 2,
          totalPixels: 100,
          differenceRatio: 0.02,
          differenceThreshold: 0.01,
        },
      ],
    });
    expect((await regression.readVisualRegressionEvidence(sessionId, changeSetId)).report).toEqual(
      report,
    );
  });

  it("reports missing captures and dimension changes instead of comparing incompatible pixels", async () => {
    const missing = await regression.compareVisualRegression(sessionId, changeSetId, {
      ...manifest(),
      captures: [
        {
          viewport: "1280x720",
          state: "initial",
          screenshot: null,
          status: "failed",
          error: "capture failed",
        },
      ],
    });
    expect(missing?.comparisons[0].status).toBe("missing-current");

    await fs.writeFile(
      path.join(visualDir, "1280x720-initial.png"),
      image(12, 10, [18, 24, 31, 255]),
    );
    const resized = await regression.compareVisualRegression(sessionId, changeSetId, manifest());
    expect(resized?.comparisons[0]).toMatchObject({
      status: "dimension-mismatch",
      differenceRatio: 1,
    });
  });

  it("rejects unsafe image names and incomplete baseline manifests", async () => {
    expect(
      regression.visualRegressionImagePath(sessionId, changeSetId, "diff", "../escape.png"),
    ).toBeNull();
    await expect(
      regression.captureVisualRegressionBaseline(sessionId, "change-set-2", {
        ...manifest(),
        status: "partial",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      regression.captureVisualRegressionBaseline(sessionId, "change-set-2", {
        ...manifest(),
        route: `http://127.0.0.1/${"x".repeat(2_048)}`,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      regression.captureVisualRegressionBaseline(sessionId, "change-set-2", {
        ...manifest(),
        captures: [{ ...manifest().captures[0], viewport: "x".repeat(101) }],
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects oversized PNG headers before decode and invalidates reports from an older baseline", async () => {
    const oversized = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(oversized, 0);
    oversized.writeUInt32BE(13, 8);
    oversized.write("IHDR", 12, "ascii");
    oversized.writeUInt32BE(50_000, 16);
    oversized.writeUInt32BE(50_000, 20);
    await fs.writeFile(path.join(visualDir, "oversized.png"), oversized);
    await expect(
      regression.captureVisualRegressionBaseline(
        sessionId,
        "change-set-3",
        manifest("oversized.png"),
      ),
    ).rejects.toMatchObject({ status: 409 });

    await fs.writeFile(
      path.join(visualDir, "1280x720-initial.png"),
      image(10, 10, [20, 26, 33, 255]),
    );
    const replacement = await regression.captureVisualRegressionBaseline(
      sessionId,
      changeSetId,
      manifest(),
    );
    const evidence = await regression.readVisualRegressionEvidence(sessionId, changeSetId);
    expect(evidence.baseline?.createdAt).toBe(replacement.createdAt);
    expect(evidence.report).toBeNull();

    const baselineImage = regression.visualRegressionImagePath(
      sessionId,
      changeSetId,
      "baseline",
      replacement.captures[0].baselineScreenshot,
    );
    await fs.writeFile(baselineImage!, image(10, 10, [255, 0, 0, 255]));
    await expect(
      regression.compareVisualRegression(sessionId, changeSetId, manifest()),
    ).rejects.toMatchObject({ status: 409, message: "visual baseline integrity check failed" });
  });
});
