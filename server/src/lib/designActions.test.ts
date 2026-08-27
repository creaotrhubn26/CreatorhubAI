import { describe, expect, it } from "vitest";
import { normalizeAssetRequests, normalizeElementEdits } from "./designActions.js";

const screenshot = "1440x900-initial.png";
const options = { screenshots: new Set([screenshot]) };
const timestamp = "2026-08-27T10:00:00.000Z";

const VALID_EDIT = {
  id: "edit-1",
  target: "Pricing card title",
  screenshot,
  viewport: "1440x900",
  state: "initial",
  region: { x: 0.2, y: 0.25, width: 0.3, height: 0.1 },
  selectorHint: "[data-testid='pricing-title']",
  sourcePathHint: "web/src/PricingCard.tsx",
  expectedText: "Starter",
  text: "Creator",
  style: { backgroundColor: "#112233", paddingPx: 24, opacity: 0.9 },
  createdAt: timestamp,
};

const VALID_IMAGE = {
  id: "asset-1",
  kind: "image",
  prompt: "A soft editorial product background using the project palette",
  outputPath: "public/generated/pricing-hero.webp",
  aspectRatio: "16:9",
  size: "2K",
  referenceImages: [{ path: "design/reference.png", label: "palette and lighting" }],
  referenceUploadPolicy: "local-only",
  screenshot,
  createdAt: timestamp,
};

describe("normalizeElementEdits", () => {
  it("normalizes a bounded element edit tied to an actual capture", () => {
    expect(normalizeElementEdits([VALID_EDIT], options)).toEqual([
      expect.objectContaining({
        id: "edit-1",
        text: "Creator",
        style: { backgroundColor: "#112233", paddingPx: 24, opacity: 0.9 },
      }),
    ]);
  });

  it("rejects unknown captures, traversal, arbitrary style, and no-op edits", () => {
    expect(normalizeElementEdits([VALID_EDIT], { screenshots: new Set(["other.png"]) })).toBeNull();
    expect(
      normalizeElementEdits([{ ...VALID_EDIT, sourcePathHint: "../secrets.env" }], options),
    ).toBeNull();
    expect(
      normalizeElementEdits([{ ...VALID_EDIT, style: { css: "display:none" } }], options),
    ).toBeNull();
    expect(
      normalizeElementEdits(
        [{ ...VALID_EDIT, text: undefined, imageSource: undefined, style: {} }],
        options,
      ),
    ).toBeNull();
  });
});

describe("normalizeAssetRequests", () => {
  it("normalizes image and video jobs with explicit reference policy", () => {
    const video = {
      ...VALID_IMAGE,
      id: "asset-2",
      kind: "video",
      outputPath: "public/generated/loop.mp4",
      size: undefined,
      resolution: "1080p",
      durationSeconds: 4,
      audio: false,
    };
    expect(normalizeAssetRequests([VALID_IMAGE, video], options)).toMatchObject([
      { kind: "image", size: "2K", referenceUploadPolicy: "local-only" },
      { kind: "video", resolution: "1080p", durationSeconds: 4, audio: false },
    ]);
  });

  it("rejects traversal, mismatched extensions, unsupported fields, and bad references", () => {
    expect(
      normalizeAssetRequests([{ ...VALID_IMAGE, outputPath: "../hero.webp" }], options),
    ).toBeNull();
    expect(
      normalizeAssetRequests([{ ...VALID_IMAGE, outputPath: "public/hero.mp4" }], options),
    ).toBeNull();
    expect(
      normalizeAssetRequests([{ ...VALID_IMAGE, command: "curl example.com" }], options),
    ).toBeNull();
    expect(
      normalizeAssetRequests(
        [{ ...VALID_IMAGE, referenceImages: [{ path: "design/reference.svg" }] }],
        options,
      ),
    ).toBeNull();
  });
});
