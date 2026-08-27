import { describe, expect, it } from "vitest";
import { validateDesignFeedbackUpdate } from "./designFeedback.js";

const VALID = {
  annotations: [
    {
      id: "note-1",
      screenshot: "1440x900-initial.png",
      viewport: "1440x900",
      state: "initial",
      tool: "color",
      points: [{ x: 0.25, y: 0.5 }],
      comment: "Use the accent token here",
      value: "#6750a4",
      selectorHint: "#pricing > button",
      sourcePathHint: "src/components/PricingCard.tsx",
      createdAt: "2026-08-27T10:00:00.000Z",
    },
  ],
  variants: [
    {
      id: "variant-1",
      target: "pricing card",
      count: 3,
      directions: ["compact", "editorial"],
      screenshot: "1440x900-initial.png",
      region: { x: 0.25, y: 0.5 },
    },
  ],
  inspirations: [
    {
      source: "mobbin",
      screenId: "screen-1",
      appName: "Example",
      platform: "web",
      mobbinUrl: "https://mobbin.com/screens/screen-1",
      query: "checkout with Apple Pay",
    },
  ],
  elementEdits: [
    {
      id: "edit-1",
      target: "pricing card",
      screenshot: "1440x900-initial.png",
      viewport: "1440x900",
      state: "initial",
      region: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
      text: "Creator plan",
      style: { borderColor: "#6750a4", borderWidthPx: 2 },
      createdAt: "2026-08-27T10:00:00.000Z",
    },
  ],
  assetRequests: [
    {
      id: "asset-1",
      kind: "image",
      prompt: "Editorial creator workspace background",
      outputPath: "public/generated/workspace.webp",
      aspectRatio: "16:9",
      size: "2K",
      referenceImages: [],
      referenceUploadPolicy: "local-only",
      screenshot: "1440x900-initial.png",
      createdAt: "2026-08-27T10:00:00.000Z",
    },
  ],
};

describe("validateDesignFeedbackUpdate", () => {
  it("normalizes bounded feedback for an actual captured screenshot", () => {
    const result = validateDesignFeedbackUpdate(VALID, ["1440x900-initial.png"]);
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      annotations: [
        {
          tool: "color",
          points: [{ x: 0.25, y: 0.5 }],
          selectorHint: "#pricing > button",
          sourcePathHint: "src/components/PricingCard.tsx",
        },
      ],
      variants: [{ count: 3 }],
      inspirations: [{ source: "mobbin" }],
      elementEdits: [{ text: "Creator plan" }],
      assetRequests: [{ kind: "image", size: "2K" }],
    });
  });

  it("rejects unknown screenshots, off-canvas coordinates, and arbitrary fields", () => {
    expect(validateDesignFeedbackUpdate(VALID, ["other.png"]).error).toMatch(/annotations/i);
    expect(
      validateDesignFeedbackUpdate(
        {
          ...VALID,
          annotations: [{ ...VALID.annotations[0], points: [{ x: 2, y: 0 }] }],
        },
        ["1440x900-initial.png"],
      ).error,
    ).toMatch(/annotations/i);
    expect(
      validateDesignFeedbackUpdate({ ...VALID, execute: "alert(1)" }, ["1440x900-initial.png"])
        .error,
    ).toMatch(/unsupported/i);
  });

  it("rejects non-Mobbin inspiration links", () => {
    expect(
      validateDesignFeedbackUpdate(
        {
          ...VALID,
          inspirations: [{ ...VALID.inspirations[0], mobbinUrl: "https://example.com/fake" }],
        },
        ["1440x900-initial.png"],
      ).error,
    ).toMatch(/inspirations/i);
  });

  it("rejects arbitrary annotation fields and unsafe generated output paths", () => {
    expect(
      validateDesignFeedbackUpdate(
        {
          ...VALID,
          annotations: [{ ...VALID.annotations[0], script: "alert(1)" }],
        },
        ["1440x900-initial.png"],
      ).error,
    ).toMatch(/annotations/i);
    expect(
      validateDesignFeedbackUpdate(
        {
          ...VALID,
          assetRequests: [{ ...VALID.assetRequests[0], outputPath: "../outside.webp" }],
        },
        ["1440x900-initial.png"],
      ).error,
    ).toMatch(/asset requests/i);
    expect(
      validateDesignFeedbackUpdate(
        {
          ...VALID,
          annotations: [{ ...VALID.annotations[0], sourcePathHint: "../outside.tsx" }],
        },
        ["1440x900-initial.png"],
      ).error,
    ).toMatch(/annotations/i);
  });
});
