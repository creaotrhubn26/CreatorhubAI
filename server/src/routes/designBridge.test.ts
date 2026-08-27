import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import type {
  LiveDesignElement,
  LiveDesignSourceCandidate,
  LiveDesignStructureTarget,
} from "@glimmer/shared";

const exec = promisify(execFile);
const UI_ORIGIN = "http://127.0.0.1:5183";
const sessionId = "live-design-test";
let app: Express;
let stateRoot: string;
let workspace: string;

const element: LiveDesignElement = {
  selector: ".title",
  tagName: "h1",
  text: "Settings",
  attributes: { class: "title" },
  styles: {
    color: "rgb(17, 34, 51)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    fontFamily: "Inter",
    fontSize: "32px",
    fontWeight: "700",
    lineHeight: "40px",
    padding: "8px",
    margin: "0px",
    gap: "normal",
    borderColor: "rgb(0, 0, 0)",
    borderWidth: "0px",
    borderRadius: "4px",
    opacity: "1",
    display: "block",
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "normal",
    alignContent: "normal",
    justifyContent: "normal",
    width: "300px",
    height: "50px",
    minWidth: "0px",
    maxWidth: "none",
    minHeight: "0px",
    maxHeight: "none",
    position: "static",
    top: "auto",
    right: "auto",
    bottom: "auto",
    left: "auto",
    zIndex: "auto",
    gridTemplateColumns: "none",
    gridTemplateRows: "none",
    gridAutoFlow: "row",
    gridColumn: "auto",
    gridRow: "auto",
    order: "0",
    flex: "0 1 auto",
    boxSizing: "content-box",
  },
  rect: { x: 20, y: 30, width: 300, height: 50, viewportWidth: 1280, viewportHeight: 720 },
  sourcePathHint: "src/App.tsx:3:10",
  tokens: [{ name: "--color-accent", value: "#112233", property: "color" }],
  styleSources: [
    {
      selector: ".title",
      source: "src/theme.css",
      specificity: "0,1,0",
      inherited: false,
      declarations: [{ property: "color", value: "var(--color-accent)", important: true }],
    },
  ],
};

const headingTarget: LiveDesignStructureTarget = {
  selector: "main > h1.title",
  tagName: "h1",
  text: "Settings",
  attributes: { class: "title" },
  sourcePathHint: "src/App.tsx",
  framework: "react",
};

const descriptionTarget: LiveDesignStructureTarget = {
  selector: 'main > p[data-testid="description"]',
  tagName: "p",
  text: "Manage your workspace",
  attributes: { "data-testid": "description" },
  sourcePathHint: "src/App.tsx",
  framework: "react",
};

const panelTarget: LiveDesignStructureTarget = {
  selector: "main > #settings-panel",
  tagName: "section",
  text: "Save",
  attributes: { id: "settings-panel" },
  sourcePathHint: "src/App.tsx",
  framework: "react",
};

const shellTarget: LiveDesignStructureTarget = {
  selector: 'main[data-testid="settings-shell"]',
  tagName: "main",
  text: "Settings Manage your workspace Save",
  attributes: { "data-testid": "settings-shell" },
  sourcePathHint: "src/App.tsx",
  framework: "react",
};

function manifest(status = "inspect-completed") {
  return {
    task: "live design route test",
    status,
    workspace,
    branch: "glimmer/live-design-test",
    baseline: null,
    attempts: [],
    contract: {
      design: {
        designTokens: {
          strategy: "existing",
          sourcePaths: ["src/theme.css"],
          requirements: [],
          allowNewTokens: false,
        },
        cms: {
          strategy: "existing",
          schemaPaths: ["content/settings.json"],
          requirements: [],
          localizationRequired: false,
        },
      },
    },
  };
}

async function writeManifest(status?: string) {
  const directory = path.join(stateRoot, "sessions", sessionId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest(status)));
}

async function resolveCandidates() {
  return request(app)
    .post(`/api/sessions/${sessionId}/design-bridge/resolve`)
    .set("Origin", UI_ORIGIN)
    .send({ element });
}

beforeAll(async () => {
  stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-live-design-state-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-live-design-workspace-"));
  process.env.GLIMMER_STATE_ROOT = stateRoot;
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "content"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, "index.html"),
    '<!doctype html>\n<html><head><title>Test</title></head><body><div id="root"></div></body></html>\n',
  );
  await fs.writeFile(
    path.join(workspace, "src", "App.tsx"),
    'import "./theme.css";\nexport function App() {\n  return (\n    <main data-testid="settings-shell">\n      <h1 className="title">Settings</h1>\n      <p data-testid="description">Manage your workspace</p>\n      <section id="settings-panel"><button type="button">Save</button></section>\n    </main>\n  );\n}\n',
  );
  await fs.writeFile(
    path.join(workspace, "src", "theme.css"),
    ":root { --color-accent: #112233; --color-brand: var(--color-accent); }\n.title { color: var(--color-accent); background-color: #ffffff; font-size: 32px; padding: 8px; border-radius: 4px; }\n.titleish { opacity: 0.2; }\n",
  );
  await fs.writeFile(
    path.join(workspace, "content", "settings.json"),
    JSON.stringify({ page: { heading: "Settings" } }, null, 2),
  );
  await exec("git", ["init", "-q"], { cwd: workspace });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await exec("git", ["config", "user.name", "Test"], { cwd: workspace });
  await exec("git", ["add", "src", "content", "index.html"], { cwd: workspace });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: workspace });
  await exec("git", ["switch", "-q", "-c", "glimmer/live-design-test"], { cwd: workspace });
  await writeManifest();
  const { createApp } = await import("../app.js");
  app = createApp();
});

beforeEach(async () => {
  await exec("git", ["switch", "-q", "glimmer/live-design-test"], { cwd: workspace });
  await exec(
    "git",
    [
      "checkout",
      "HEAD",
      "--",
      "src/App.tsx",
      "src/theme.css",
      "content/settings.json",
      "index.html",
    ],
    { cwd: workspace },
  );
  await writeManifest();
  await fs.rm(path.join(stateRoot, "sessions", sessionId, "design-workflow.json"), {
    force: true,
  });
  await fs.rm(path.join(stateRoot, "sessions", sessionId, "design-feedback.json"), {
    force: true,
  });
  await fs.rm(path.join(stateRoot, "sessions", sessionId, "visual"), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(stateRoot, "sessions", sessionId, "live-design-draft.json"), {
    force: true,
  });
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await fs.rm(stateRoot, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("live design bridge routes", () => {
  it("serves a no-store, cross-origin-loadable development bridge", async () => {
    const response = await request(app).get("/api/design-bridge/client.js");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/javascript");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(response.text).toContain("glimmer-live-design");
    expect(response.text).toContain("describe-selector");
    expect(response.text).toContain("describe-many");
    expect(response.text).toContain("componentMetadataFor");
    expect(response.text).toContain("request-structure");
    expect(response.text).toContain("preview-structure");
    expect(response.text).toContain("preview-responsive");
    expect(response.text).toContain("data-glimmer-resize-handle");
    expect(response.text).toContain('"move"');
    expect(response.text).toContain("move-change");
    expect(response.text).toContain("highlight-many");
    expect(response.text).toContain("set-preview-visibility");
    expect(response.text).toContain("styleSourcesFor");
    expect(response.text).toContain("preview-style-rule");
    expect(response.text).toContain("location.hostname");
    expect(() => new Function(response.text)).not.toThrow();
  });

  it("resolves exact text and CSS-token source bindings", async () => {
    const response = await resolveCandidates();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      branch: "glimmer/live-design-test",
      directApplyAllowed: true,
      truncated: false,
    });
    expect(response.body.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text-node", path: "src/App.tsx", expected: "Settings" }),
        expect.objectContaining({
          kind: "css-token",
          path: "src/theme.css",
          tokenName: "--color-accent",
          expected: "#112233",
        }),
        expect.objectContaining({
          kind: "css-declaration",
          path: "src/theme.css",
          property: "font-size",
          expected: "32px",
          confidence: "exact",
        }),
      ]),
    );
    expect(response.body.tokenGraph).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "--color-accent", path: "src/theme.css" }),
        expect.objectContaining({ name: "--color-brand", path: "src/theme.css" }),
      ]),
    );
    expect(response.body.cmsReferences).toEqual([
      expect.objectContaining({ path: "content/settings.json", field: "page.heading" }),
    ]);
    expect(response.body.auditFindings).toEqual(expect.any(Array));
    expect(response.body.auditFindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "important-cascade" })]),
    );
    expect(
      response.body.candidates.some(
        (item: LiveDesignSourceCandidate) =>
          item.kind === "css-declaration" && item.property === "opacity",
      ),
    ).toBe(false);
  });

  it("returns a bounded model proposal and never writes source before acceptance", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Improve heading hierarchy.",
                  changes: [
                    {
                      field: "fontSizePx",
                      after: "36",
                      reason: "Strengthens the selected heading.",
                    },
                    {
                      field: "width",
                      after: "100%; } body { display: none",
                      reason: "Unsafe value must be ignored.",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const before = await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8");
    const response = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/proposal`)
      .set("Origin", UI_ORIGIN)
      .send({ element, prompt: "Give this heading stronger hierarchy" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      prompt: "Give this heading stronger hierarchy",
      summary: "Improve heading hierarchy.",
      provenance: "model-output",
      changes: [expect.objectContaining({ field: "fontSizePx", before: "32", after: "36" })],
    });
    expect(response.body.changes).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).toBe(before);
  });

  it("atomically journals, restores, ignores stale autosaves, and clears Live Design progress", async () => {
    const update = {
      route: "http://localhost:4173/settings",
      sequence: 2,
      selectedSelector: headingTarget.selector,
      selectedSelectors: [headingTarget.selector],
      lockedSelectors: [headingTarget.selector],
      hiddenSelectors: [],
      activeTab: "structure",
      viewportId: "mobile",
      zoom: 90,
      inspectorWidth: 380,
      elementPrompt: "Improve hierarchy",
      annotationComment: "Align this heading",
      annotationTool: "comment",
      annotationPoints: [{ x: 0.25, y: 0.4 }],
      annotating: true,
      assetPrompt: "Generate a quiet abstract background",
      assetPath: "public/generated/background.png",
      previewMode: false,
      resizeMode: true,
      responsiveBreakpoint: "mobile",
      responsiveProperty: "font-size",
      responsiveValue: "24px",
      responsiveOverrides: { "mobile:font-size": "24px" },
      responsivePreviewed: true,
      styleScope: "component",
      selectedClass: "title",
      textCandidateId: "a".repeat(64),
      tokenCandidateId: "b".repeat(64),
      tokenReplacement: "#445566",
      tokenBindingProperty: "background-color",
      pendingStructure: {
        kind: "insert",
        target: headingTarget,
        placement: "after",
        preset: "paragraph",
        text: "Invite your team",
      },
    };
    const saved = await request(app)
      .put(`/api/sessions/${sessionId}/design-bridge/draft`)
      .set("Origin", UI_ORIGIN)
      .send(update);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ version: 1, sessionId, sequence: 2, ...update });

    const journalFile = path.join(stateRoot, "sessions", sessionId, "live-design-draft.json");
    expect((await fs.stat(journalFile)).mode & 0o777).toBe(0o600);
    const stale = await request(app)
      .put(`/api/sessions/${sessionId}/design-bridge/draft`)
      .set("Origin", UI_ORIGIN)
      .send({ ...update, sequence: 1, elementPrompt: "stale" });
    expect(stale.body).toMatchObject({ sequence: 2, elementPrompt: "Improve hierarchy" });

    const restored = await request(app)
      .get(`/api/sessions/${sessionId}/design-bridge/draft`)
      .set("Origin", UI_ORIGIN);
    expect(restored.status).toBe(200);
    expect(restored.body.pendingStructure).toMatchObject({ kind: "insert" });

    const cleared = await request(app)
      .delete(`/api/sessions/${sessionId}/design-bridge/draft`)
      .set("Origin", UI_ORIGIN);
    expect(cleared.body).toEqual({ cleared: true });
    const empty = await request(app)
      .get(`/api/sessions/${sessionId}/design-bridge/draft`)
      .set("Origin", UI_ORIGIN);
    expect(empty.body).toBeNull();
  });

  it("applies multiple validated CSS declarations atomically and exposes durable history", async () => {
    const resolved = await resolveCandidates();
    const fontSize = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) =>
        item.kind === "css-declaration" && item.property === "font-size",
    );
    const padding = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) =>
        item.kind === "css-declaration" && item.property === "padding",
    );
    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/transaction`)
      .set("Origin", UI_ORIGIN)
      .send({
        edits: [
          { candidate: fontSize, replacement: "36px" },
          { candidate: padding, replacement: "12px" },
        ],
      });
    expect(applied.status).toBe(200);
    expect(applied.body.revision).toMatchObject({ kind: "transaction", changeCount: 2 });
    const source = await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8");
    expect(source).toContain("font-size: 36px");
    expect(source).toContain("padding: 12px");

    const history = await request(app)
      .get(`/api/sessions/${sessionId}/design-bridge/history`)
      .set("Origin", UI_ORIGIN);
    expect(history.status).toBe(200);
    expect(history.body.revisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: applied.body.revision.id })]),
    );

    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${applied.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
    const restored = await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8");
    expect(restored).toContain("font-size: 32px");
    expect(restored).toContain("padding: 8px");
  });

  it("inserts a semantic element through a snapshot revision and rolls it back", async () => {
    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/structure`)
      .set("Origin", UI_ORIGIN)
      .send({
        kind: "insert",
        target: headingTarget,
        placement: "after",
        preset: "paragraph",
        text: "Invite your team",
      });
    expect(applied.status).toBe(200);
    expect(applied.body.revision).toMatchObject({
      kind: "structure-insert",
      path: "src/App.tsx",
    });
    expect(await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8")).toContain(
      "<p>Invite your team</p>",
    );

    const history = await request(app)
      .get(`/api/sessions/${sessionId}/design-bridge/history`)
      .set("Origin", UI_ORIGIN);
    expect(history.body.revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: applied.body.revision.id, kind: "structure-insert" }),
      ]),
    );
    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${applied.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8")).not.toContain(
      "Invite your team",
    );
  });

  it("reorders adjacent siblings and reparents a bound element without losing rollback safety", async () => {
    const reordered = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/structure`)
      .set("Origin", UI_ORIGIN)
      .send({
        kind: "reorder",
        moving: headingTarget,
        anchor: descriptionTarget,
        placement: "after",
      });
    expect(reordered.status).toBe(200);
    expect(reordered.body.revision.kind).toBe("structure-reorder");
    let source = await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8");
    expect(source.indexOf("Manage your workspace")).toBeLessThan(source.indexOf("Settings</h1>"));

    const reorderRollback = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${reordered.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(reorderRollback.status).toBe(200);

    const reparented = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/structure`)
      .set("Origin", UI_ORIGIN)
      .send({
        kind: "reparent",
        moving: descriptionTarget,
        target: panelTarget,
        placement: "inside-start",
      });
    expect(reparented.status).toBe(200);
    expect(reparented.body.revision.kind).toBe("structure-reparent");
    source = await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8");
    const panelStart = source.indexOf('<section id="settings-panel">');
    const panelEnd = source.indexOf("</section>", panelStart);
    const description = source.indexOf("Manage your workspace");
    expect(description).toBeGreaterThan(panelStart);
    expect(description).toBeLessThan(panelEnd);

    const reparentRollback = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${reparented.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(reparentRollback.status).toBe(200);
    source = await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8");
    expect(source.indexOf("Manage your workspace")).toBeLessThan(
      source.indexOf('<section id="settings-panel">'),
    );
  });

  it("writes a scoped responsive override and restores the stylesheet snapshot", async () => {
    const resolved = await resolveCandidates();
    const source = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) =>
        item.kind === "css-declaration" && item.property === "font-size",
    );
    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/responsive`)
      .set("Origin", UI_ORIGIN)
      .send({
        element,
        source,
        breakpoint: "mobile",
        property: "font-size",
        value: "24px",
      });
    expect(applied.status).toBe(200);
    expect(applied.body.revision.kind).toBe("responsive-override");
    const changed = await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8");
    expect(changed).toContain("glimmer-responsive:");
    expect(changed).toContain("@media (max-width: 479px)");
    expect(changed).toContain(".title {");
    expect(changed).toContain("font-size: 24px");

    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${applied.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).not.toContain(
      "glimmer-responsive:",
    );
  });

  it("persists component-scoped Flex/Grid layout rules and rolls back the stylesheet snapshot", async () => {
    const resolved = await resolveCandidates();
    const source = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) =>
        item.kind === "css-declaration" && item.property === "font-size",
    );
    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/style-override`)
      .set("Origin", UI_ORIGIN)
      .send({
        element,
        source,
        scope: "component",
        className: "title",
        declarations: {
          display: "grid",
          "grid-template-columns": "repeat(2, minmax(0, 1fr))",
          gap: "12px",
          width: "360px",
          "box-sizing": "border-box",
        },
      });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      selector: ".title",
      revision: { kind: "style-override", changeCount: 5 },
    });
    const changed = await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8");
    expect(changed).toContain("glimmer-style:");
    expect(changed).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(changed).toContain("width: 360px");

    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${applied.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).not.toContain(
      "glimmer-style:",
    );
  });

  it("requires stable scope selectors and rejects CSS injection in visual layout overrides", async () => {
    const resolved = await resolveCandidates();
    const source = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) =>
        item.kind === "css-declaration" && item.property === "font-size",
    );
    const missingInstanceIdentity = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/style-override`)
      .set("Origin", UI_ORIGIN)
      .send({ element, source, scope: "instance", declarations: { width: "320px" } });
    expect(missingInstanceIdentity.status).toBe(409);

    const injected = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/style-override`)
      .set("Origin", UI_ORIGIN)
      .send({
        element,
        source,
        scope: "component",
        declarations: { width: "320px; } body { display: none" },
      });
    expect(injected.status).toBe(400);

    const unrelatedClass = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/style-override`)
      .set("Origin", UI_ORIGIN)
      .send({
        element,
        source,
        scope: "component",
        className: "attacker-class",
        declarations: { width: "320px" },
      });
    expect(unrelatedClass.status).toBe(409);

    const stableInstance = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/style-override`)
      .set("Origin", UI_ORIGIN)
      .send({
        element: {
          ...element,
          selector: "#settings-title",
          attributes: { ...element.attributes, id: "settings-title" },
        },
        source,
        scope: "instance",
        declarations: { position: "relative", top: "8px" },
      });
    expect(stableInstance.status).toBe(200);
    expect(stableInstance.body.selector).toBe("#settings-title");
  });

  it("fails closed for ambiguous targets, structure cycles, and unsupported request fields", async () => {
    await fs.appendFile(
      path.join(workspace, "src", "App.tsx"),
      '\nexport const Duplicate = () => <h1 className="title">Settings</h1>;\n',
    );
    const ambiguous = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/structure`)
      .set("Origin", UI_ORIGIN)
      .send({
        kind: "insert",
        target: headingTarget,
        placement: "after",
        preset: "paragraph",
        text: "Unsafe",
      });
    expect(ambiguous.status).toBe(409);
    await exec("git", ["checkout", "HEAD", "--", "src/App.tsx"], { cwd: workspace });

    const cycle = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/structure`)
      .set("Origin", UI_ORIGIN)
      .send({
        kind: "reparent",
        moving: shellTarget,
        target: panelTarget,
        placement: "inside-end",
      });
    expect(cycle.status).toBe(409);

    const unsupported = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/structure`)
      .set("Origin", UI_ORIGIN)
      .send({
        kind: "insert",
        target: headingTarget,
        placement: "after",
        preset: "paragraph",
        text: "Unsafe",
        sourcePath: "/tmp/attacker.tsx",
      });
    expect(unsupported.status).toBe(400);
  });

  it("installs the localhost-only bridge automatically and can undo the installation", async () => {
    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/install`)
      .set("Origin", UI_ORIGIN)
      .send({
        scriptUrl: "http://127.0.0.1:4317/api/design-bridge/client.js",
        parentOrigin: UI_ORIGIN,
      });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ installed: true, path: "index.html" });
    const installedSource = await fs.readFile(path.join(workspace, "index.html"), "utf8");
    expect(installedSource).toContain("data-glimmer-dev-only");
    expect(installedSource).toContain("includes(location.hostname)");
    expect(installedSource).not.toContain(
      '<script src="http://127.0.0.1:4317/api/design-bridge/client.js"',
    );

    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${applied.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "index.html"), "utf8")).not.toContain(
      "/api/design-bridge/client.js",
    );

    const unsafe = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/install`)
      .set("Origin", UI_ORIGIN)
      .send({
        scriptUrl: "https://attacker.example/bridge.js",
        parentOrigin: UI_ORIGIN,
      });
    expect(unsafe.status).toBe(400);
  });

  it("writes a hash-bound text edit and rolls it back from its durable revision", async () => {
    const resolved = await resolveCandidates();
    const candidate = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) => item.kind === "text-node",
    );
    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/apply`)
      .set("Origin", UI_ORIGIN)
      .send({ candidate, replacement: "Workspace settings" });
    expect(applied.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8")).toContain(
      ">Workspace settings<",
    );
    const revisionFile = path.join(
      stateRoot,
      "sessions",
      sessionId,
      "design-bridge",
      "revisions",
      `${applied.body.revision.id}.json`,
    );
    expect(JSON.parse(await fs.readFile(revisionFile, "utf8"))).toMatchObject({
      status: "applied",
    });

    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${applied.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8")).toContain(
      ">Settings<",
    );
  });

  it("writes and rolls back an exact semantic CSS token declaration", async () => {
    const resolved = await resolveCandidates();
    const candidate = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) => item.kind === "css-token",
    );
    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/apply`)
      .set("Origin", UI_ORIGIN)
      .send({ candidate, replacement: "#445566" });
    expect(applied.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).toContain(
      "--color-accent: #445566",
    );

    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${applied.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).toContain(
      "--color-accent: #112233",
    );
  });

  it("binds an exact CSS declaration to an existing design token and rolls it back", async () => {
    const resolved = await resolveCandidates();
    const candidate = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) =>
        item.kind === "css-declaration" && item.property === "background-color",
    );
    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/apply`)
      .set("Origin", UI_ORIGIN)
      .send({ candidate, replacement: "var(--color-brand)" });
    expect(applied.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).toContain(
      "background-color: var(--color-brand)",
    );

    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${applied.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
    expect(await fs.readFile(path.join(workspace, "src", "theme.css"), "utf8")).toContain(
      "background-color: #ffffff",
    );
  });

  it("serializes concurrent edits so only one hash-bound write can win", async () => {
    const resolved = await resolveCandidates();
    const candidate = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) => item.kind === "text-node",
    );
    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/sessions/${sessionId}/design-bridge/apply`)
        .set("Origin", UI_ORIGIN)
        .send({ candidate, replacement: "First edit" }),
      request(app)
        .post(`/api/sessions/${sessionId}/design-bridge/apply`)
        .set("Origin", UI_ORIGIN)
        .send({ candidate, replacement: "Second edit" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = first.status === 200 ? first : second;
    const source = await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8");
    expect(source).toContain(`>${winner.body.revision.after}<`);

    const rolledBack = await request(app)
      .post(
        `/api/sessions/${sessionId}/design-bridge/revisions/${winner.body.revision.id}/rollback`,
      )
      .set("Origin", UI_ORIGIN);
    expect(rolledBack.status).toBe(200);
  });

  it("refuses stale, symlinked, foreign-origin, active-run, and non-glimmer writes", async () => {
    const resolved = await resolveCandidates();
    const candidate = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) => item.kind === "text-node",
    );
    await fs.appendFile(path.join(workspace, "src", "App.tsx"), "// newer work\n");
    const stale = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/apply`)
      .set("Origin", UI_ORIGIN)
      .send({ candidate, replacement: "Stale" });
    expect(stale.status).toBe(409);

    await exec("git", ["checkout", "HEAD", "--", "src/App.tsx"], { cwd: workspace });
    const linkPath = path.join(workspace, "src", "linked.tsx");
    await fs.symlink(path.join(workspace, "src", "App.tsx"), linkPath);
    const symlinked = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/apply`)
      .set("Origin", UI_ORIGIN)
      .send({ candidate: { ...candidate, path: "src/linked.tsx" }, replacement: "Linked" });
    expect(symlinked.status).toBe(403);

    const foreign = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/apply`)
      .set("Origin", "https://attacker.example")
      .send({ candidate, replacement: "Foreign" });
    expect(foreign.status).toBe(403);

    await writeManifest("initialized");
    const active = await resolveCandidates();
    expect(active.body).toMatchObject({ directApplyAllowed: false });

    await writeManifest();
    await exec("git", ["switch", "-q", "main"], { cwd: workspace });
    const main = await resolveCandidates();
    expect(main.body).toMatchObject({ directApplyAllowed: false, branch: "main" });
  });

  it("runs an approved design change set through source apply, viewport verification, delivery, and combined rollback", async () => {
    const created = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets`)
      .set("Origin", UI_ORIGIN)
      .send({
        expectedRevision: 0,
        title: "Improve settings heading",
        goal: "Make the settings heading clearer without changing the design system.",
        route: "http://127.0.0.1:5183/settings",
        componentName: "App",
        selector: ".title",
        sourcePath: "src/App.tsx",
        viewport: "1280x720",
      });
    expect(created.status).toBe(201);
    const changeSetId = created.body.activeChangeSetId;
    expect(created.body.changeSets[0]).toMatchObject({ status: "draft" });

    const resolved = await resolveCandidates();
    const candidate = resolved.body.candidates.find(
      (item: LiveDesignSourceCandidate) => item.kind === "text-node",
    );
    const blocked = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/apply`)
      .set("Origin", UI_ORIGIN)
      .send({ candidate, replacement: "Workspace settings", changeSetId });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("approve");

    const reviewed = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/transition`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: created.body.revision, action: "submit_review" });
    expect(reviewed.status).toBe(200);
    const approved = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/transition`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: reviewed.body.revision, action: "approve", note: "Ready" });
    expect(approved.body.changeSets[0]).toMatchObject({ status: "approved" });

    const applied = await request(app)
      .post(`/api/sessions/${sessionId}/design-bridge/apply`)
      .set("Origin", UI_ORIGIN)
      .send({ candidate, replacement: "Workspace settings", changeSetId });
    expect(applied.status).toBe(200);
    expect(applied.body.revision).toMatchObject({ changeSetId });

    const afterApply = await request(app)
      .get(`/api/sessions/${sessionId}/design-workflow`)
      .set("Origin", UI_ORIGIN);
    expect(afterApply.body.changeSets[0]).toMatchObject({
      status: "implementing",
      revisionIds: [applied.body.revision.id],
    });

    const visualDir = path.join(stateRoot, "sessions", sessionId, "visual");
    await fs.mkdir(visualDir, { recursive: true });
    await fs.writeFile(
      path.join(visualDir, "visual-manifest.json"),
      JSON.stringify({
        route: "http://127.0.0.1:5183/settings",
        viewports: ["390x844", "1280x720"],
        states: ["initial"],
        status: "pass",
        captures: [
          {
            viewport: "390x844",
            state: "initial",
            screenshot: "mobile.png",
            status: "captured",
            error: null,
          },
          {
            viewport: "1280x720",
            state: "initial",
            screenshot: "desktop.png",
            status: "captured",
            error: null,
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(visualDir, "findings.json"),
      JSON.stringify({
        status: "PASS",
        viewport: "multi",
        viewports: ["390x844", "1280x720"],
        findings: [],
      }),
    );
    const verified = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/verify`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: afterApply.body.revision });
    expect(verified.status).toBe(200);
    expect(verified.body.changeSets[0]).toMatchObject({
      status: "verified",
      verification: { status: "passed" },
    });
    expect(verified.body.changeSets[0].verification.viewports).toHaveLength(2);

    const delivered = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/transition`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: verified.body.revision, action: "deliver" });
    expect(delivered.body.changeSets[0].status).toBe("delivered");

    const rolledBack = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/rollback`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: delivered.body.revision });
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body.rolledBackRevisionIds).toEqual([applied.body.revision.id]);
    expect(rolledBack.body.workflow.changeSets[0]).toMatchObject({ status: "draft" });
    expect(await fs.readFile(path.join(workspace, "src", "App.tsx"), "utf8")).toContain(
      ">Settings<",
    );
  });

  it("rejects stale concurrent workflow writes and validates linked feedback against the session document", async () => {
    const input = {
      expectedRevision: 0,
      title: "Accessible settings",
      goal: "Improve clarity and accessibility.",
      route: "http://localhost:5183/settings",
    };
    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/sessions/${sessionId}/design-workflow/change-sets`)
        .set("Origin", UI_ORIGIN)
        .send(input),
      request(app)
        .post(`/api/sessions/${sessionId}/design-workflow/change-sets`)
        .set("Origin", UI_ORIGIN)
        .send(input),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const winner = first.status === 201 ? first : second;
    const changeSetId = winner.body.activeChangeSetId;
    const annotationId = "annotation-one";
    await fs.writeFile(
      path.join(stateRoot, "sessions", sessionId, "design-feedback.json"),
      JSON.stringify({
        version: 1,
        sessionId,
        updatedAt: new Date().toISOString(),
        annotations: [{ id: annotationId }],
        variants: [],
        inspirations: [],
        elementEdits: [],
        assetRequests: [],
      }),
    );
    const linked = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/link-feedback`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: winner.body.revision, refs: { annotationIds: [annotationId] } });
    expect(linked.status).toBe(200);
    expect(linked.body.changeSets[0].feedbackRefs.annotationIds).toEqual([annotationId]);

    const missing = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/link-feedback`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: linked.body.revision, refs: { annotationIds: ["unknown"] } });
    expect(missing.status).toBe(409);

    const reviewed = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/transition`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: linked.body.revision, action: "submit_review" });
    const approved = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/transition`)
      .set("Origin", UI_ORIGIN)
      .send({ expectedRevision: reviewed.body.revision, action: "approve" });
    const secondAnnotationId = "annotation-two";
    await fs.writeFile(
      path.join(stateRoot, "sessions", sessionId, "design-feedback.json"),
      JSON.stringify({
        version: 1,
        sessionId,
        updatedAt: new Date().toISOString(),
        annotations: [{ id: annotationId }, { id: secondAnnotationId }],
        variants: [],
        inspirations: [],
        elementEdits: [],
        assetRequests: [],
      }),
    );
    const scopeChanged = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets/${changeSetId}/link-feedback`)
      .set("Origin", UI_ORIGIN)
      .send({
        expectedRevision: approved.body.revision,
        refs: { annotationIds: [secondAnnotationId] },
      });
    expect(scopeChanged.status).toBe(200);
    expect(scopeChanged.body.changeSets[0]).toMatchObject({ status: "draft" });

    const externalRoute = await request(app)
      .post(`/api/sessions/${sessionId}/design-workflow/change-sets`)
      .set("Origin", UI_ORIGIN)
      .send({
        ...input,
        expectedRevision: scopeChanged.body.revision,
        route: "https://example.com",
      });
    expect(externalRoute.status).toBe(400);
  });
});
