import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESIGN_FORM,
  buildDesignContract,
  designComposerError,
  parseDesignStates,
} from "./designContract";

describe("designContract", () => {
  it("groups a closed click/wait DSL into deterministic states", () => {
    expect(
      parseDesignStates(
        "dialog-open | click | [aria-label='Settings'] | dialog is visible\n" +
          "dialog-open | wait | 250 | content has settled",
      ),
    ).toEqual({
      states: [
        {
          name: "dialog-open",
          actions: [
            { action: "click", selector: "[aria-label='Settings']" },
            { action: "wait", ms: 250 },
          ],
          expectations: ["dialog is visible", "content has settled"],
        },
      ],
      errors: [],
    });
  });

  it("rejects arbitrary actions and external targets before Run", () => {
    expect(
      designComposerError({
        ...DEFAULT_DESIGN_FORM,
        designEnabled: true,
        designStates: "bad | evaluate | alert(1)",
      }),
    ).toMatch(/click or wait/i);
    expect(
      designComposerError({
        ...DEFAULT_DESIGN_FORM,
        designEnabled: true,
        designTargetUrl: "https://example.com",
      }),
    ).toMatch(/localhost/i);
  });

  it("keeps CMS and token strategies in the normalized contract", () => {
    expect(
      buildDesignContract({
        ...DEFAULT_DESIGN_FORM,
        designEnabled: true,
        cmsStrategy: "required",
        cmsRequirements: "Editable hero copy",
        designTokenStrategy: "existing",
        designTokenSourcePaths: "src/theme.css",
      }),
    ).toMatchObject({
      referenceImagePolicy: "local-only",
      cms: { strategy: "required", requirements: ["Editable hero copy"] },
      designTokens: { strategy: "existing", sourcePaths: ["src/theme.css"] },
    });
  });

  it("requires an explicit per-task switch before reference images may reach Vision", () => {
    expect(
      buildDesignContract({
        ...DEFAULT_DESIGN_FORM,
        designEnabled: true,
        designReferenceImages: "Settings | design/settings.png",
      }),
    ).toMatchObject({ referenceImagePolicy: "local-only" });
    expect(
      buildDesignContract({
        ...DEFAULT_DESIGN_FORM,
        designEnabled: true,
        designReferenceImages: "Settings | design/settings.png",
        allowReferenceImageModelUpload: true,
      }),
    ).toMatchObject({ referenceImagePolicy: "vision-model" });
  });

  it("carries selected Mobbin inspiration and bounded variants into the contract", () => {
    const contract = buildDesignContract({
      ...DEFAULT_DESIGN_FORM,
      designEnabled: true,
      designInspirations: [
        {
          source: "mobbin",
          screenId: "screen-1",
          appName: "Example",
          platform: "web",
          mobbinUrl: "https://mobbin.com/screens/screen-1",
          query: "checkout with Apple Pay",
        },
      ],
      designVariants: [
        {
          id: "variant-1",
          target: "checkout summary",
          count: 3,
          directions: ["compact", "editorial"],
        },
      ],
    });
    expect(contract).toMatchObject({
      inspirations: [{ screenId: "screen-1" }],
      variants: [{ target: "checkout summary", count: 3 }],
    });
  });

  it("carries selected catalogue direction without mixing it into screen inspiration", () => {
    const designProfiles = [
      {
        source: "creatorhub-catalog" as const,
        profileId: "editorial",
        profileVersion: "0.1.0",
        designHash: "a".repeat(64),
        title: "Editorial",
        adoptedQualities: ["calm hierarchy"],
        rejectedQualities: ["literal copying"],
      },
    ];
    const contract = buildDesignContract({
      ...DEFAULT_DESIGN_FORM,
      designEnabled: true,
      designProfiles,
    });
    expect(contract).toMatchObject({ inspirations: [], designProfiles });
  });

  it("carries visual element edits and real asset jobs into the contract", () => {
    const contract = buildDesignContract({
      ...DEFAULT_DESIGN_FORM,
      designEnabled: true,
      designElementEdits: [
        {
          id: "edit-1",
          target: "checkout title",
          screenshot: "1440x900-initial.png",
          viewport: "1440x900",
          state: "initial",
          region: { x: 0.2, y: 0.1 },
          text: "Complete purchase",
          style: { fontSizePx: 32 },
          createdAt: "2026-08-27T10:00:00.000Z",
        },
      ],
      designAssetRequests: [
        {
          id: "asset-1",
          kind: "image",
          prompt: "Editorial product background",
          outputPath: "public/generated/checkout.webp",
          aspectRatio: "16:9",
          size: "2K",
          referenceImages: [{ path: "design/brand.png" }],
          referenceUploadPolicy: "local-only",
          createdAt: "2026-08-27T10:00:00.000Z",
        },
      ],
    });
    expect(contract).toMatchObject({
      elementEdits: [{ target: "checkout title", text: "Complete purchase" }],
      assetRequests: [{ kind: "image", outputPath: "public/generated/checkout.webp" }],
    });
  });

  it("rejects traversal in visual-edit and asset paths before Run", () => {
    expect(
      designComposerError({
        ...DEFAULT_DESIGN_FORM,
        designEnabled: true,
        designElementEdits: [
          {
            id: "edit-1",
            target: "title",
            screenshot: "1440x900-initial.png",
            viewport: "1440x900",
            state: "initial",
            region: { x: 0.2, y: 0.1 },
            imageSource: "../outside.png",
            style: {},
            createdAt: "2026-08-27T10:00:00.000Z",
          },
        ],
      }),
    ).toMatch(/visual element/i);
    expect(
      designComposerError({
        ...DEFAULT_DESIGN_FORM,
        designEnabled: true,
        designAssetRequests: [
          {
            id: "asset-1",
            kind: "vector",
            prompt: "icon",
            outputPath: "../icon.svg",
            aspectRatio: "1:1",
            animated: false,
            referenceImages: [],
            referenceUploadPolicy: "local-only",
            createdAt: "2026-08-27T10:00:00.000Z",
          },
        ],
      }),
    ).toMatch(/asset requests/i);
  });
});
