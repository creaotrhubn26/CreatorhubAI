import { describe, expect, it } from "vitest";
import { validateDesignContract } from "./designContract.js";

const VALID = {
  kind: "improve",
  targetUrl: "http://localhost:5173/settings",
  audience: "content editors",
  primaryAction: "publish a page",
  requirements: ["primary action remains visible"],
  referenceImages: [{ label: "settings", path: "design/settings.png" }],
  referenceImagePolicy: "local-only",
  states: [
    {
      name: "dialog-open",
      actions: [{ action: "click", selector: "[aria-label='Open settings']" }],
      expectations: ["dialog is visible"],
    },
  ],
  viewports: ["1440x900", "390x844"],
  inspirations: [],
  variants: [],
  elementEdits: [],
  assetRequests: [],
  cms: {
    strategy: "existing",
    providerHint: "Sanity",
    schemaPaths: ["cms/schema"],
    requirements: ["hero copy stays editor-managed"],
    localizationRequired: true,
  },
  designTokens: {
    strategy: "detect",
    sourcePaths: ["src/theme.css"],
    requirements: ["reuse semantic color tokens"],
    allowNewTokens: false,
  },
};

describe("validateDesignContract", () => {
  it("normalizes the declarative CMS/token/UX contract", () => {
    const result = validateDesignContract(VALID);
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      targetUrl: "http://localhost:5173/settings",
      referenceImagePolicy: "local-only",
      cms: { strategy: "existing", localizationRequired: true },
      designTokens: { strategy: "detect", allowNewTokens: false },
    });
  });

  it("keeps older design contracts compatible by defaulting new visual actions", () => {
    const { elementEdits: _edits, assetRequests: _assets, ...legacy } = VALID;
    expect(validateDesignContract(legacy).value).toMatchObject({
      elementEdits: [],
      assetRequests: [],
    });
  });

  it("rejects missing or open-ended reference upload policies", () => {
    const { referenceImagePolicy: _omitted, ...withoutPolicy } = VALID;
    expect(validateDesignContract(withoutPolicy).error).toMatch(/referenceImagePolicy/i);
    expect(
      validateDesignContract({ ...VALID, referenceImagePolicy: "always-upload" }).error,
    ).toMatch(/referenceImagePolicy/i);
  });

  it("rejects external browser targets and path traversal", () => {
    expect(
      validateDesignContract({ ...VALID, targetUrl: "https://example.com/settings" }).error,
    ).toMatch(/loopback/i);
    expect(
      validateDesignContract({
        ...VALID,
        designTokens: { ...VALID.designTokens, sourcePaths: ["../secrets.css"] },
      }).error,
    ).toMatch(/workspace-relative/i);
  });

  it("rejects arbitrary actions while allowing bounded waits", () => {
    expect(
      validateDesignContract({
        ...VALID,
        states: [{ name: "bad", actions: [{ action: "evaluate", script: "x" }], expectations: [] }],
      }).error,
    ).toMatch(/limited to click and wait/i);
    expect(
      validateDesignContract({
        ...VALID,
        states: [{ name: "bad", actions: [{ action: "wait", ms: 60_000 }], expectations: [] }],
      }).error,
    ).toMatch(/limited to click and wait/i);
  });

  it("accepts official Mobbin inspiration and bounded variants", () => {
    const result = validateDesignContract({
      ...VALID,
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
      variants: [
        {
          id: "variant-1",
          target: "checkout summary",
          count: 3,
          directions: ["compact", "editorial"],
        },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      inspirations: [{ source: "mobbin", screenId: "screen-1" }],
      variants: [{ target: "checkout summary", count: 3 }],
    });
  });

  it("keeps curated profile direction separate and drift-detectable", () => {
    const result = validateDesignContract({
      ...VALID,
      designProfiles: [
        {
          source: "creatorhub-catalog",
          profileId: "editorial",
          profileVersion: "0.1.0",
          designHash: "a".repeat(64),
          title: "Editorial",
          adoptedQualities: ["calm hierarchy"],
          rejectedQualities: ["literal screen composition"],
        },
      ],
    });
    expect(result.value?.designProfiles).toEqual([
      expect.objectContaining({ profileId: "editorial", designHash: "a".repeat(64) }),
    ]);
    expect(
      validateDesignContract({
        ...VALID,
        designProfiles: [
          {
            source: "creatorhub-catalog",
            profileId: "../editorial",
            profileVersion: "0.1.0",
            designHash: "not-a-hash",
            title: "Editorial",
            adoptedQualities: ["calm"],
            rejectedQualities: [],
          },
        ],
      }).error,
    ).toMatch(/designProfiles/i);
  });

  it("accepts structured visual edits and asset generation requests", () => {
    const result = validateDesignContract({
      ...VALID,
      elementEdits: [
        {
          id: "edit-1",
          target: "settings heading",
          screenshot: "1440x900-initial.png",
          viewport: "1440x900",
          state: "initial",
          region: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
          text: "Workspace settings",
          style: { textColor: "#123456", fontSizePx: 32 },
          createdAt: "2026-08-27T10:00:00.000Z",
        },
      ],
      assetRequests: [
        {
          id: "asset-1",
          kind: "vector",
          prompt: "A restrained geometric empty-state illustration",
          outputPath: "web/public/generated/empty-state.svg",
          aspectRatio: "4:3",
          animated: false,
          referenceImages: [{ path: "design/settings.png" }],
          referenceUploadPolicy: "local-only",
          createdAt: "2026-08-27T10:00:00.000Z",
        },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({
      elementEdits: [{ target: "settings heading", style: { textColor: "#123456" } }],
      assetRequests: [{ kind: "vector", animated: false }],
    });
  });

  it("rejects unsafe visual edit and asset paths", () => {
    expect(
      validateDesignContract({
        ...VALID,
        elementEdits: [
          {
            id: "edit-1",
            target: "heading",
            screenshot: "1440x900-initial.png",
            viewport: "1440x900",
            state: "initial",
            region: { x: 0.1, y: 0.2 },
            sourcePathHint: "../outside.tsx",
            text: "Changed",
            style: {},
            createdAt: "2026-08-27T10:00:00.000Z",
          },
        ],
      }).error,
    ).toMatch(/elementEdits/i);
    expect(
      validateDesignContract({
        ...VALID,
        assetRequests: [
          {
            id: "asset-1",
            kind: "image",
            prompt: "hero",
            outputPath: "../hero.png",
            aspectRatio: "16:9",
            size: "2K",
            referenceImages: [],
            referenceUploadPolicy: "local-only",
            createdAt: "2026-08-27T10:00:00.000Z",
          },
        ],
      }).error,
    ).toMatch(/assetRequests/i);
  });

  it("rejects fake Mobbin hosts and unbounded variant counts", () => {
    expect(
      validateDesignContract({
        ...VALID,
        inspirations: [
          {
            source: "mobbin",
            screenId: "screen-1",
            appName: "Fake",
            platform: "web",
            mobbinUrl: "https://example.com/screens/1",
            query: "login",
          },
        ],
      }).error,
    ).toMatch(/Mobbin/i);
    expect(
      validateDesignContract({
        ...VALID,
        variants: [{ id: "v1", target: "header", count: 20, directions: ["one"] }],
      }).error,
    ).toMatch(/variant/i);
  });
});
