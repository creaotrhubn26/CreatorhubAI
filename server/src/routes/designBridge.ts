import { Router, type Response } from "express";
import type { GlimmerSession, GlimmerSessionStatus } from "@glimmer/shared";
import { readSession, isValidSessionId } from "../lib/sessions.js";
import { gitStatus } from "../lib/git.js";
import {
  applyLiveDesignSource,
  applyLiveDesignResponsiveOverride,
  applyLiveDesignStyleOverride,
  applyLiveDesignStructure,
  applyLiveDesignTransaction,
  installLiveDesignBridge,
  listLiveDesignRevisions,
  LiveDesignBridgeError,
  normalizeLiveDesignElement,
  resolveLiveDesignSources,
  rollbackLiveDesignRevision,
} from "../lib/liveDesignBridge.js";
import { LIVE_DESIGN_BRIDGE_CLIENT } from "../lib/liveDesignBridgeClient.js";
import { proposeLiveDesignChange } from "../lib/liveDesignProposal.js";
import {
  clearLiveDesignDraft,
  readLiveDesignDraft,
  writeLiveDesignDraft,
} from "../lib/liveDesignDraft.js";
import { CONFIG } from "../config.js";
import {
  DesignWorkflowError,
  recordDesignWorkflowRevision,
  requireDesignWorkflowApply,
} from "../lib/designWorkflow.js";

export const designBridgeRouter = Router();

const EDIT_BLOCKING_STATUSES = new Set<GlimmerSessionStatus>([
  "created",
  "preflight",
  "understanding",
  "discovery",
  "candidate_selection",
  "implementing",
  "verifying",
  "repairing",
  "waiting_for_approval",
]);

function sendBridgeError(response: Response, error: unknown) {
  if (error instanceof LiveDesignBridgeError || error instanceof DesignWorkflowError) {
    return response.status(error.status).json({ error: error.message });
  }
  console.error("[design-bridge] operation failed:", error);
  return response.status(500).json({ error: "live design bridge operation failed" });
}

function exactBody(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

async function sessionAndBranch(id: string): Promise<{
  session: GlimmerSession;
  branch: string;
  directApplyAllowed: boolean;
  directApplyReason?: string;
}> {
  if (!isValidSessionId(id)) throw new LiveDesignBridgeError("session not found", 404);
  const session = await readSession(id);
  if (!session) throw new LiveDesignBridgeError("session not found", 404);
  let branch: string;
  try {
    branch = (await gitStatus(session.workspace)).branch;
  } catch {
    throw new LiveDesignBridgeError("session workspace is not an available Git checkout", 409);
  }
  if (EDIT_BLOCKING_STATUSES.has(session.status)) {
    return {
      session,
      branch,
      directApplyAllowed: false,
      directApplyReason: "Wait until the active Glimmer run has stopped before editing source.",
    };
  }
  if (!branch.startsWith("glimmer/")) {
    return {
      session,
      branch,
      directApplyAllowed: false,
      directApplyReason: "Direct visual edits are only allowed on an isolated glimmer/* branch.",
    };
  }
  return { session, branch, directApplyAllowed: true };
}

function requireDirectApply(context: Awaited<ReturnType<typeof sessionAndBranch>>) {
  if (!context.directApplyAllowed) {
    throw new LiveDesignBridgeError(
      context.directApplyReason ?? "direct source editing is disabled",
      409,
    );
  }
}

designBridgeRouter.get("/design-bridge/client.js", (_request, response) => {
  response.set({
    "Cache-Control": "no-store",
    "Content-Type": "application/javascript; charset=utf-8",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
  response.send(LIVE_DESIGN_BRIDGE_CLIENT);
});

designBridgeRouter.post("/sessions/:id/design-bridge/resolve", async (request, response) => {
  try {
    if (!exactBody(request.body, ["element"])) {
      throw new LiveDesignBridgeError("live design resolve request is invalid", 400);
    }
    const element = normalizeLiveDesignElement(request.body.element);
    if (!element) throw new LiveDesignBridgeError("selected element metadata is invalid", 400);
    const context = await sessionAndBranch(request.params.id);
    const preferredTokenPaths =
      context.session.taskContract?.design?.designTokens.sourcePaths ?? [];
    const preferredCmsPaths = context.session.taskContract?.design?.cms?.schemaPaths ?? [];
    const resolved = await resolveLiveDesignSources(
      context.session.workspace,
      element,
      preferredTokenPaths,
      preferredCmsPaths,
    );
    response.json({
      ...resolved,
      branch: context.branch,
      directApplyAllowed: context.directApplyAllowed,
      ...(context.directApplyReason ? { directApplyReason: context.directApplyReason } : {}),
    });
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.post("/sessions/:id/design-bridge/proposal", async (request, response) => {
  try {
    if (!exactBody(request.body, ["element", "prompt"])) {
      throw new LiveDesignBridgeError("live design proposal request is invalid", 400);
    }
    const element = normalizeLiveDesignElement(request.body.element);
    const prompt =
      typeof request.body.prompt === "string" &&
      request.body.prompt.trim() &&
      request.body.prompt.length <= 2_000
        ? request.body.prompt.trim()
        : null;
    if (!element || !prompt) {
      throw new LiveDesignBridgeError("selected element and design request are required", 400);
    }
    await sessionAndBranch(request.params.id);
    response.json(await proposeLiveDesignChange(CONFIG.modelBaseUrl, element, prompt));
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.get("/sessions/:id/design-bridge/draft", async (request, response) => {
  try {
    await sessionAndBranch(request.params.id);
    response.json(await readLiveDesignDraft(request.params.id));
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.put("/sessions/:id/design-bridge/draft", async (request, response) => {
  try {
    await sessionAndBranch(request.params.id);
    response.json(await writeLiveDesignDraft(request.params.id, request.body));
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.delete("/sessions/:id/design-bridge/draft", async (request, response) => {
  try {
    await sessionAndBranch(request.params.id);
    await clearLiveDesignDraft(request.params.id);
    response.json({ cleared: true });
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.get("/sessions/:id/design-bridge/history", async (request, response) => {
  try {
    if (!isValidSessionId(request.params.id) || !(await readSession(request.params.id))) {
      throw new LiveDesignBridgeError("session not found", 404);
    }
    response.json(await listLiveDesignRevisions(request.params.id));
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.post("/sessions/:id/design-bridge/install", async (request, response) => {
  try {
    const context = await sessionAndBranch(request.params.id);
    requireDirectApply(context);
    response.json(
      await installLiveDesignBridge(request.params.id, context.session.workspace, request.body),
    );
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.post("/sessions/:id/design-bridge/apply", async (request, response) => {
  try {
    const context = await sessionAndBranch(request.params.id);
    requireDirectApply(context);
    const changeSetId = await requireDesignWorkflowApply(
      request.params.id,
      request.body?.changeSetId,
    );
    const result = await applyLiveDesignSource(
      request.params.id,
      context.session.workspace,
      request.body,
    );
    if (changeSetId) {
      await recordDesignWorkflowRevision(request.params.id, changeSetId, result.revision.id);
    }
    response.json(result);
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.post("/sessions/:id/design-bridge/transaction", async (request, response) => {
  try {
    const context = await sessionAndBranch(request.params.id);
    requireDirectApply(context);
    const changeSetId = await requireDesignWorkflowApply(
      request.params.id,
      request.body?.changeSetId,
    );
    const result = await applyLiveDesignTransaction(
      request.params.id,
      context.session.workspace,
      request.body,
    );
    if (changeSetId) {
      await recordDesignWorkflowRevision(request.params.id, changeSetId, result.revision.id);
    }
    response.json(result);
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.post("/sessions/:id/design-bridge/structure", async (request, response) => {
  try {
    const context = await sessionAndBranch(request.params.id);
    requireDirectApply(context);
    const changeSetId = await requireDesignWorkflowApply(
      request.params.id,
      request.body?.changeSetId,
    );
    const result = await applyLiveDesignStructure(
      request.params.id,
      context.session.workspace,
      request.body,
    );
    if (changeSetId) {
      await recordDesignWorkflowRevision(request.params.id, changeSetId, result.revision.id);
    }
    response.json(result);
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.post("/sessions/:id/design-bridge/responsive", async (request, response) => {
  try {
    const context = await sessionAndBranch(request.params.id);
    requireDirectApply(context);
    const changeSetId = await requireDesignWorkflowApply(
      request.params.id,
      request.body?.changeSetId,
    );
    const result = await applyLiveDesignResponsiveOverride(
      request.params.id,
      context.session.workspace,
      request.body,
    );
    if (changeSetId) {
      await recordDesignWorkflowRevision(request.params.id, changeSetId, result.revision.id);
    }
    response.json(result);
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.post("/sessions/:id/design-bridge/style-override", async (request, response) => {
  try {
    const context = await sessionAndBranch(request.params.id);
    requireDirectApply(context);
    const changeSetId = await requireDesignWorkflowApply(
      request.params.id,
      request.body?.changeSetId,
    );
    const result = await applyLiveDesignStyleOverride(
      request.params.id,
      context.session.workspace,
      request.body,
    );
    if (changeSetId) {
      await recordDesignWorkflowRevision(request.params.id, changeSetId, result.revision.id);
    }
    response.json(result);
  } catch (error) {
    sendBridgeError(response, error);
  }
});

designBridgeRouter.post(
  "/sessions/:id/design-bridge/revisions/:revisionId/rollback",
  async (request, response) => {
    try {
      const context = await sessionAndBranch(request.params.id);
      requireDirectApply(context);
      response.json(
        await rollbackLiveDesignRevision(
          request.params.id,
          context.session.workspace,
          request.params.revisionId,
        ),
      );
    } catch (error) {
      sendBridgeError(response, error);
    }
  },
);
