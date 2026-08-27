import { Router, type Response } from "express";
import type {
  DesignChangeSetCreateRequest,
  DesignChangeSetFeedbackRefs,
  DesignChangeSetUpdateRequest,
  DesignChangeSetVerification,
  DesignWorkflowTransitionAction,
  GlimmerSessionStatus,
  VisualFinding,
} from "@glimmer/shared";
import { promises as fs } from "node:fs";
import { gitStatus } from "../lib/git.js";
import {
  activateDesignChangeSet,
  createDesignChangeSet,
  DesignWorkflowError,
  linkDesignFeedback,
  reconcileDesignWorkflowRevisions,
  recordDesignWorkflowRollback,
  recordDesignWorkflowRollbackBlocked,
  recordDesignWorkflowVerification,
  transitionDesignChangeSet,
  unlinkDesignFeedback,
  updateDesignChangeSet,
} from "../lib/designWorkflow.js";
import {
  LiveDesignBridgeError,
  listLiveDesignRevisions,
  rollbackLiveDesignRevision,
} from "../lib/liveDesignBridge.js";
import {
  isValidSessionId,
  readDesignFeedback,
  readSession,
  readVisualFindings,
  readVisualManifest,
} from "../lib/sessions.js";
import {
  captureVisualRegressionBaseline,
  compareVisualRegression,
  readVisualRegressionEvidence,
  visualRegressionImagePath,
  VisualRegressionError,
} from "../lib/visualRegression.js";

export const designWorkflowRouter = Router();

const WORKFLOW_ACTIONS = new Set<DesignWorkflowTransitionAction>([
  "submit_review",
  "approve",
  "reject",
  "return_to_draft",
  "deliver",
  "reopen",
]);
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
const REF_KEYS = [
  "annotationIds",
  "variantIds",
  "inspirationIds",
  "elementEditIds",
  "assetRequestIds",
] as const;

function exactBody(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function sendWorkflowError(response: Response, error: unknown) {
  if (
    error instanceof DesignWorkflowError ||
    error instanceof LiveDesignBridgeError ||
    error instanceof VisualRegressionError
  ) {
    return response.status(error.status).json({ error: error.message });
  }
  console.error("[design-workflow] operation failed:", error);
  return response.status(500).json({ error: "design workflow operation failed" });
}

async function requireSession(id: string) {
  if (!isValidSessionId(id)) throw new DesignWorkflowError("session not found", 404);
  const session = await readSession(id);
  if (!session) throw new DesignWorkflowError("session not found", 404);
  return session;
}

function expectedRevision(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new DesignWorkflowError("expectedRevision must be a non-negative integer", 400);
  }
  return Number(value);
}

async function workflowWithRevisions(id: string) {
  const history = await listLiveDesignRevisions(id);
  return reconcileDesignWorkflowRevisions(id, history.revisions);
}

async function requireChangeSet(id: string, changeSetId: string) {
  const document = await workflowWithRevisions(id);
  const changeSet = document.changeSets.find((item) => item.id === changeSetId);
  if (!changeSet) throw new DesignWorkflowError("change set not found", 404);
  return { document, changeSet };
}

designWorkflowRouter.get("/sessions/:id/design-workflow", async (request, response) => {
  try {
    await requireSession(request.params.id);
    response.json(await workflowWithRevisions(request.params.id));
  } catch (error) {
    sendWorkflowError(response, error);
  }
});

designWorkflowRouter.get(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/visual-regression",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      await requireChangeSet(request.params.id, request.params.changeSetId);
      response.json(
        await readVisualRegressionEvidence(request.params.id, request.params.changeSetId),
      );
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/visual-regression/baseline",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      const { changeSet } = await requireChangeSet(request.params.id, request.params.changeSetId);
      if (!exactBody(request.body, [])) {
        throw new DesignWorkflowError("visual baseline request is invalid", 400);
      }
      if (
        changeSet.revisionIds.some(
          (revisionId) => !changeSet.rolledBackRevisionIds.includes(revisionId),
        )
      ) {
        throw new DesignWorkflowError(
          "capture the visual baseline before applying source revisions",
          409,
        );
      }
      const manifest = await readVisualManifest(request.params.id);
      if (!manifest) {
        throw new DesignWorkflowError("run Visual Verification before capturing a baseline", 409);
      }
      if (manifest.route !== changeSet.route) {
        throw new DesignWorkflowError(
          "Visual Verification must capture the same route as this change set",
          409,
        );
      }
      response.status(201).json({
        baseline: await captureVisualRegressionBaseline(
          request.params.id,
          request.params.changeSetId,
          manifest,
        ),
        report: null,
      });
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/visual-regression/compare",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      await requireChangeSet(request.params.id, request.params.changeSetId);
      if (!exactBody(request.body, [])) {
        throw new DesignWorkflowError("visual comparison request is invalid", 400);
      }
      const manifest = await readVisualManifest(request.params.id);
      if (!manifest) {
        throw new DesignWorkflowError("run Visual Verification before comparing screenshots", 409);
      }
      const report = await compareVisualRegression(
        request.params.id,
        request.params.changeSetId,
        manifest,
      );
      if (!report) {
        throw new DesignWorkflowError(
          "capture a visual baseline before comparing screenshots",
          409,
        );
      }
      response.json({
        baseline: (
          await readVisualRegressionEvidence(request.params.id, request.params.changeSetId)
        ).baseline,
        report,
      });
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.get(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/visual-regression/images/:kind/:file",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      if (request.params.kind !== "baseline" && request.params.kind !== "diff") {
        return response.status(400).json({ error: "invalid visual regression image kind" });
      }
      const file = visualRegressionImagePath(
        request.params.id,
        request.params.changeSetId,
        request.params.kind,
        request.params.file,
      );
      if (!file) return response.status(400).json({ error: "invalid filename" });
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 50 * 1024 * 1024) {
        return response.status(404).json({ error: "not found" });
      }
      response
        .set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
        .type("png")
        .send(await fs.readFile(file));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return response.status(404).json({ error: "not found" });
      }
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      if (
        !exactBody(request.body, [
          "expectedRevision",
          "title",
          "goal",
          "route",
          "componentName",
          "selector",
          "sourcePath",
          "viewport",
        ])
      ) {
        throw new DesignWorkflowError("change set create request is invalid", 400);
      }
      const document = await createDesignChangeSet(
        request.params.id,
        request.body as unknown as DesignChangeSetCreateRequest,
      );
      const created = document.changeSets.find((item) => item.id === document.activeChangeSetId);
      const manifest = await readVisualManifest(request.params.id);
      if (
        created &&
        manifest?.status === "pass" &&
        manifest.route === created.route &&
        manifest.captures.length > 0 &&
        manifest.captures.every(
          (capture) => capture.status === "captured" && Boolean(capture.screenshot),
        )
      ) {
        try {
          await captureVisualRegressionBaseline(request.params.id, created.id, manifest);
        } catch (error) {
          console.warn("[design-workflow] automatic visual baseline was not captured:", error);
        }
      }
      response.status(201).json(document);
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.put(
  "/sessions/:id/design-workflow/change-sets/:changeSetId",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      if (
        !exactBody(request.body, [
          "expectedRevision",
          "title",
          "goal",
          "componentName",
          "selector",
          "sourcePath",
          "viewport",
        ])
      ) {
        throw new DesignWorkflowError("change set update request is invalid", 400);
      }
      response.json(
        await updateDesignChangeSet(
          request.params.id,
          request.params.changeSetId,
          request.body as unknown as DesignChangeSetUpdateRequest,
        ),
      );
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/activate",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      if (!exactBody(request.body, ["expectedRevision"])) {
        throw new DesignWorkflowError("activate request is invalid", 400);
      }
      response.json(
        await activateDesignChangeSet(
          request.params.id,
          request.params.changeSetId,
          expectedRevision(request.body.expectedRevision),
        ),
      );
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/transition",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      if (!exactBody(request.body, ["expectedRevision", "action", "note"])) {
        throw new DesignWorkflowError("workflow transition request is invalid", 400);
      }
      if (
        typeof request.body.action !== "string" ||
        !WORKFLOW_ACTIONS.has(request.body.action as DesignWorkflowTransitionAction)
      ) {
        throw new DesignWorkflowError("workflow transition is invalid", 400);
      }
      if (request.body.note !== undefined && typeof request.body.note !== "string") {
        throw new DesignWorkflowError("decision note is invalid", 400);
      }
      response.json(
        await transitionDesignChangeSet(
          request.params.id,
          request.params.changeSetId,
          expectedRevision(request.body.expectedRevision),
          request.body.action as DesignWorkflowTransitionAction,
          typeof request.body.note === "string" ? request.body.note : undefined,
        ),
      );
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

function feedbackIds(document: NonNullable<Awaited<ReturnType<typeof readDesignFeedback>>>) {
  return {
    annotationIds: new Set(document.annotations.map((item) => item.id)),
    variantIds: new Set(document.variants.map((item) => item.id)),
    inspirationIds: new Set(document.inspirations.map((item) => item.screenId)),
    elementEditIds: new Set(document.elementEdits.map((item) => item.id)),
    assetRequestIds: new Set(document.assetRequests.map((item) => item.id)),
  };
}

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/link-feedback",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      if (
        !exactBody(request.body, ["expectedRevision", "refs"]) ||
        !exactBody(request.body.refs, REF_KEYS)
      ) {
        throw new DesignWorkflowError("feedback link request is invalid", 400);
      }
      const feedback = await readDesignFeedback(request.params.id);
      if (!feedback) throw new DesignWorkflowError("design feedback has not been saved", 409);
      const known = feedbackIds(feedback);
      const refs = request.body.refs as Partial<DesignChangeSetFeedbackRefs>;
      for (const key of REF_KEYS) {
        const values = refs[key];
        if (values === undefined) continue;
        if (
          !Array.isArray(values) ||
          values.some((id) => typeof id !== "string" || !known[key].has(id))
        ) {
          throw new DesignWorkflowError("feedback reference does not exist in this session", 409);
        }
      }
      response.json(
        await linkDesignFeedback(
          request.params.id,
          request.params.changeSetId,
          expectedRevision(request.body.expectedRevision),
          refs,
        ),
      );
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/unlink-feedback",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      if (
        !exactBody(request.body, ["expectedRevision", "refs"]) ||
        !exactBody(request.body.refs, REF_KEYS)
      ) {
        throw new DesignWorkflowError("feedback unlink request is invalid", 400);
      }
      response.json(
        await unlinkDesignFeedback(
          request.params.id,
          request.params.changeSetId,
          expectedRevision(request.body.expectedRevision),
          request.body.refs as Partial<DesignChangeSetFeedbackRefs>,
        ),
      );
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

function findingsFor(findings: VisualFinding[], viewport: string, state: string): VisualFinding[] {
  return findings.filter(
    (finding) =>
      (!finding.viewport || finding.viewport === viewport) &&
      (!finding.state || finding.state === state),
  );
}

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/verify",
  async (request, response) => {
    try {
      await requireSession(request.params.id);
      if (!exactBody(request.body, ["expectedRevision"])) {
        throw new DesignWorkflowError("verification request is invalid", 400);
      }
      const { changeSet } = await requireChangeSet(request.params.id, request.params.changeSetId);
      const history = await listLiveDesignRevisions(request.params.id);
      const activeRevisionIds = new Set(
        changeSet.revisionIds.filter(
          (revisionId) => !changeSet.rolledBackRevisionIds.includes(revisionId),
        ),
      );
      const latestActiveRevision = history.revisions
        .filter((revision) => activeRevisionIds.has(revision.id))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
      const manifest = await readVisualManifest(request.params.id);
      if (!manifest) {
        throw new DesignWorkflowError(
          "run Visual Verification before verifying this change set",
          409,
        );
      }
      const findings = await readVisualFindings(request.params.id);
      if (
        !["pass", "partial", "failed"].includes(String(manifest.status)) ||
        !Array.isArray(manifest.viewports) ||
        !manifest.viewports.length ||
        !manifest.viewports.every(
          (viewport) => typeof viewport === "string" && viewport.length <= 100,
        ) ||
        !Array.isArray(manifest.captures) ||
        !manifest.captures.length ||
        !manifest.captures.every(
          (capture) =>
            capture &&
            typeof capture.viewport === "string" &&
            (capture.state === undefined || typeof capture.state === "string") &&
            (capture.status === "captured" || capture.status === "failed") &&
            (capture.error === null || typeof capture.error === "string"),
        ) ||
        (findings !== null &&
          (!["NOT_RUN", "PASS", "FAIL", "BLOCKED", "PASS_WITH_WARNINGS"].includes(
            String(findings.status),
          ) ||
            !Array.isArray(findings.findings)))
      ) {
        throw new DesignWorkflowError("visual verification evidence is invalid", 409);
      }
      const checkedAt = new Date().toISOString();
      const hasMultipleViewports = new Set(manifest.viewports).size >= 2;
      const regression = await compareVisualRegression(
        request.params.id,
        request.params.changeSetId,
        manifest,
        latestActiveRevision?.createdAt,
      );
      const hardFailure =
        manifest.status !== "pass" ||
        findings?.status === "FAIL" ||
        findings?.status === "BLOCKED" ||
        regression?.status === "failed";
      const warning =
        !hardFailure &&
        (!hasMultipleViewports ||
          !findings ||
          findings.status === "NOT_RUN" ||
          findings.status === "PASS_WITH_WARNINGS");
      const verification: DesignChangeSetVerification = {
        status: hardFailure ? "failed" : warning ? "passed_with_warnings" : "passed",
        checkedAt,
        manifestStatus: manifest.status,
        ...(findings ? { findingsStatus: findings.status } : {}),
        regressionStatus: regression?.status ?? "not_configured",
        viewports: manifest.captures.map((capture) => {
          const state = capture.state ?? "initial";
          const relevant = findingsFor(findings?.findings ?? [], capture.viewport, state);
          const visualDifference = regression?.comparisons.find(
            (comparison) => comparison.viewport === capture.viewport && comparison.state === state,
          );
          const captureFailed = capture.status === "failed";
          const findingFailed = relevant.some(
            (item) => item.severity === "critical" || item.severity === "high",
          );
          const regressionFailed =
            visualDifference !== undefined && visualDifference.status !== "passed";
          const viewportWarning =
            !captureFailed &&
            !findingFailed &&
            !regressionFailed &&
            (!findings ||
              findings.status === "NOT_RUN" ||
              relevant.length > 0 ||
              !hasMultipleViewports);
          return {
            viewport: capture.viewport,
            state,
            status:
              captureFailed || findingFailed || regressionFailed
                ? "failed"
                : viewportWarning
                  ? "warning"
                  : "passed",
            findingCount: relevant.length,
            ...(visualDifference
              ? {
                  visualDifferenceRatio: visualDifference.differenceRatio,
                  visualDifferenceThreshold: visualDifference.differenceThreshold,
                  ...(visualDifference.diffScreenshot
                    ? { visualDiffScreenshot: visualDifference.diffScreenshot }
                    : {}),
                }
              : {}),
            ...(capture.error
              ? { message: capture.error }
              : visualDifference?.message
                ? { message: visualDifference.message }
                : !findings || findings.status === "NOT_RUN"
                  ? { message: "Captured, but no vision review was run." }
                  : !hasMultipleViewports
                    ? { message: "Add another viewport for responsive evidence." }
                    : {}),
          };
        }),
        summary: hardFailure
          ? regression?.status === "failed"
            ? regression.summary
            : "Visual evidence contains a failed capture or blocking finding."
          : warning
            ? "Captured successfully with incomplete or warning-level review evidence."
            : regression
              ? `Visual review and screenshot regression gate passed across ${regression.comparisons.length} viewport state(s).`
              : "Visual review passed across multiple viewports.",
      };
      response.json(
        await recordDesignWorkflowVerification(
          request.params.id,
          request.params.changeSetId,
          expectedRevision(request.body.expectedRevision),
          verification,
        ),
      );
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);

designWorkflowRouter.post(
  "/sessions/:id/design-workflow/change-sets/:changeSetId/rollback",
  async (request, response) => {
    try {
      const session = await requireSession(request.params.id);
      if (!exactBody(request.body, ["expectedRevision"])) {
        throw new DesignWorkflowError("rollback request is invalid", 400);
      }
      const expected = expectedRevision(request.body.expectedRevision);
      const document = await workflowWithRevisions(request.params.id);
      if (document.revision !== expected) {
        throw new DesignWorkflowError("design workflow changed; refresh before rolling back", 409);
      }
      const changeSet = document.changeSets.find((item) => item.id === request.params.changeSetId);
      if (!changeSet) throw new DesignWorkflowError("change set not found", 404);
      if (EDIT_BLOCKING_STATUSES.has(session.status)) {
        throw new DesignWorkflowError(
          "wait until the active Glimmer run stops before rollback",
          409,
        );
      }
      const branch = (await gitStatus(session.workspace)).branch;
      if (!branch.startsWith("glimmer/")) {
        throw new DesignWorkflowError(
          "workflow rollback is only allowed on a glimmer/* branch",
          409,
        );
      }
      const history = await listLiveDesignRevisions(request.params.id);
      const activeIds = new Set(
        changeSet.revisionIds.filter((id) => !changeSet.rolledBackRevisionIds.includes(id)),
      );
      const ordered = history.revisions.filter((revision) => activeIds.has(revision.id));
      if (!ordered.length)
        throw new DesignWorkflowError("this change set has no active revisions", 409);
      if (ordered.length !== activeIds.size) {
        throw new DesignWorkflowError(
          "complete revision history is unavailable; rollback was refused before changing source",
          409,
        );
      }
      const rolledBackRevisionIds: string[] = [];
      const skippedRevisionIds: string[] = [];
      try {
        for (const revision of ordered) {
          if (revision.rolledBackAt) {
            skippedRevisionIds.push(revision.id);
            continue;
          }
          await rollbackLiveDesignRevision(request.params.id, session.workspace, revision.id);
          rolledBackRevisionIds.push(revision.id);
        }
      } catch (rollbackError) {
        const message = rollbackError instanceof Error ? rollbackError.message : "rollback stopped";
        await recordDesignWorkflowRollbackBlocked(
          request.params.id,
          changeSet.id,
          rolledBackRevisionIds,
          message,
        );
        throw new DesignWorkflowError(
          `${message}. ${rolledBackRevisionIds.length} earlier revision(s) were already rolled back; the change set is blocked for review.`,
          409,
        );
      }
      const workflow = await recordDesignWorkflowRollback(request.params.id, changeSet.id, [
        ...rolledBackRevisionIds,
        ...skippedRevisionIds,
      ]);
      response.json({ workflow, rolledBackRevisionIds, skippedRevisionIds });
    } catch (error) {
      sendWorkflowError(response, error);
    }
  },
);
