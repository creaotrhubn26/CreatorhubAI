import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DesignChangeSet,
  DesignChangeSetCreateRequest,
  DesignChangeSetFeedbackRefs,
  DesignChangeSetUpdateRequest,
  DesignChangeSetVerification,
  DesignWorkflowDocument,
  DesignWorkflowTransitionAction,
  LiveDesignRevision,
} from "@glimmer/shared";
import { sessionsDir } from "../config.js";
import { isValidSessionId, resolveSessionId } from "./sessions.js";

const FILE_NAME = "design-workflow.json";
const MAX_CHANGE_SETS = 20;
const MAX_EVENTS = 100;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const STATUSES = new Set([
  "draft",
  "in_review",
  "approved",
  "implementing",
  "verifying",
  "verified",
  "blocked",
  "delivered",
  "rejected",
]);
const EVENT_TYPES = new Set([
  "created",
  "updated",
  "feedback_linked",
  "feedback_unlinked",
  "submitted_for_review",
  "approved",
  "rejected",
  "returned_to_draft",
  "source_applied",
  "verification_completed",
  "rollback_completed",
  "rollback_blocked",
  "delivered",
  "reopened",
]);
const REF_KEYS = [
  "annotationIds",
  "variantIds",
  "inspirationIds",
  "elementEditIds",
  "assetRequestIds",
] as const;

export class DesignWorkflowError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const mutationTails = new Map<string, Promise<void>>();

async function withSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationTails.set(sessionId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(sessionId) === current) mutationTails.delete(sessionId);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown, limit: number, allowEmpty = false): string | null {
  if (typeof value !== "string" || value.includes("\0") || value.length > limit) return null;
  const trimmed = value.trim();
  return trimmed || (allowEmpty ? "" : null);
}

function optionalText(value: unknown, limit: number): string | undefined | null {
  if (value === undefined) return undefined;
  return text(value, limit, true);
}

function safeSourcePath(value: string): boolean {
  return (
    !path.isAbsolute(value) &&
    !value.split(/[\\/]+/).includes("..") &&
    !value.includes("\0") &&
    value.length <= 500
  );
}

function localRoute(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function emptyRefs(): DesignChangeSetFeedbackRefs {
  return {
    annotationIds: [],
    variantIds: [],
    inspirationIds: [],
    elementEditIds: [],
    assetRequestIds: [],
  };
}

function emptyDocument(sessionId: string): DesignWorkflowDocument {
  return {
    version: 1,
    revision: 0,
    sessionId,
    updatedAt: "1970-01-01T00:00:00.000Z",
    changeSets: [],
  };
}

function validIdList(value: unknown, limit = 200): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    new Set(value).size === value.length &&
    value.every((id) => typeof id === "string" && SAFE_ID.test(id))
  );
}

function isVerification(value: unknown): value is DesignChangeSetVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (
    !exactKeys(raw, [
      "status",
      "checkedAt",
      "manifestStatus",
      "findingsStatus",
      "regressionStatus",
      "viewports",
      "summary",
    ]) ||
    !["not_run", "passed", "passed_with_warnings", "failed"].includes(String(raw.status)) ||
    (raw.checkedAt !== undefined && text(raw.checkedAt, 100) === null) ||
    (raw.manifestStatus !== undefined &&
      !["pass", "partial", "failed"].includes(String(raw.manifestStatus))) ||
    (raw.findingsStatus !== undefined &&
      !["NOT_RUN", "PASS", "FAIL", "BLOCKED", "PASS_WITH_WARNINGS"].includes(
        String(raw.findingsStatus),
      )) ||
    (raw.regressionStatus !== undefined &&
      !["not_configured", "passed", "failed"].includes(String(raw.regressionStatus))) ||
    !Array.isArray(raw.viewports) ||
    raw.viewports.length > 100 ||
    (raw.summary !== undefined && text(raw.summary, 1_000, true) === null)
  ) {
    return false;
  }
  return raw.viewports.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const viewport = entry as Record<string, unknown>;
    return (
      exactKeys(viewport, [
        "viewport",
        "state",
        "status",
        "findingCount",
        "message",
        "visualDifferenceRatio",
        "visualDifferenceThreshold",
        "visualDiffScreenshot",
      ]) &&
      text(viewport.viewport, 100) !== null &&
      text(viewport.state, 100) !== null &&
      ["passed", "warning", "failed"].includes(String(viewport.status)) &&
      Number.isInteger(viewport.findingCount) &&
      Number(viewport.findingCount) >= 0 &&
      Number(viewport.findingCount) <= 10_000 &&
      (viewport.message === undefined || text(viewport.message, 500, true) !== null) &&
      (viewport.visualDifferenceRatio === undefined ||
        (typeof viewport.visualDifferenceRatio === "number" &&
          Number.isFinite(viewport.visualDifferenceRatio) &&
          viewport.visualDifferenceRatio >= 0 &&
          viewport.visualDifferenceRatio <= 1)) &&
      (viewport.visualDifferenceThreshold === undefined ||
        (typeof viewport.visualDifferenceThreshold === "number" &&
          Number.isFinite(viewport.visualDifferenceThreshold) &&
          viewport.visualDifferenceThreshold >= 0 &&
          viewport.visualDifferenceThreshold <= 1)) &&
      (viewport.visualDiffScreenshot === undefined ||
        (typeof viewport.visualDiffScreenshot === "string" &&
          /^diff-[a-f0-9]{16}-[A-Za-z0-9x-]{1,180}\.png$/.test(viewport.visualDiffScreenshot)))
    );
  });
}

function isChangeSet(value: unknown): value is DesignChangeSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (
    !exactKeys(raw, [
      "id",
      "title",
      "goal",
      "route",
      "status",
      "createdAt",
      "updatedAt",
      "componentName",
      "selector",
      "sourcePath",
      "viewport",
      "decision",
      "feedbackRefs",
      "revisionIds",
      "rolledBackRevisionIds",
      "verification",
      "events",
    ]) ||
    typeof raw.id !== "string" ||
    !SAFE_ID.test(raw.id) ||
    text(raw.title, 160) === null ||
    text(raw.goal, 4_000) === null ||
    text(raw.route, 2_048) === null ||
    !localRoute(String(raw.route)) ||
    !STATUSES.has(String(raw.status)) ||
    text(raw.createdAt, 100) === null ||
    text(raw.updatedAt, 100) === null ||
    optionalText(raw.componentName, 200) === null ||
    optionalText(raw.selector, 500) === null ||
    optionalText(raw.sourcePath, 500) === null ||
    (typeof raw.sourcePath === "string" && raw.sourcePath && !safeSourcePath(raw.sourcePath)) ||
    optionalText(raw.viewport, 100) === null ||
    !raw.feedbackRefs ||
    typeof raw.feedbackRefs !== "object" ||
    Array.isArray(raw.feedbackRefs) ||
    !exactKeys(raw.feedbackRefs as Record<string, unknown>, REF_KEYS) ||
    !REF_KEYS.every((key) => validIdList((raw.feedbackRefs as Record<string, unknown>)[key])) ||
    !validIdList(raw.revisionIds) ||
    !validIdList(raw.rolledBackRevisionIds) ||
    !isVerification(raw.verification) ||
    !Array.isArray(raw.events) ||
    raw.events.length > MAX_EVENTS
  ) {
    return false;
  }
  if (raw.decision !== undefined) {
    if (!raw.decision || typeof raw.decision !== "object" || Array.isArray(raw.decision))
      return false;
    const decision = raw.decision as Record<string, unknown>;
    if (
      !exactKeys(decision, ["outcome", "decidedAt", "note"]) ||
      !["approved", "rejected"].includes(String(decision.outcome)) ||
      text(decision.decidedAt, 100) === null ||
      optionalText(decision.note, 1_000) === null
    )
      return false;
  }
  return raw.events.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const event = entry as Record<string, unknown>;
    return (
      exactKeys(event, ["id", "type", "at", "note"]) &&
      typeof event.id === "string" &&
      SAFE_ID.test(event.id) &&
      EVENT_TYPES.has(String(event.type)) &&
      text(event.at, 100) !== null &&
      optionalText(event.note, 1_000) !== null
    );
  });
}

function isDocument(value: unknown, sessionId: string): value is DesignWorkflowDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    exactKeys(raw, [
      "version",
      "revision",
      "sessionId",
      "updatedAt",
      "activeChangeSetId",
      "changeSets",
    ]) &&
    raw.version === 1 &&
    Number.isInteger(raw.revision) &&
    Number(raw.revision) >= 0 &&
    raw.sessionId === sessionId &&
    text(raw.updatedAt, 100) !== null &&
    (raw.activeChangeSetId === undefined ||
      (typeof raw.activeChangeSetId === "string" && SAFE_ID.test(raw.activeChangeSetId))) &&
    Array.isArray(raw.changeSets) &&
    raw.changeSets.length <= MAX_CHANGE_SETS &&
    raw.changeSets.every(isChangeSet) &&
    new Set(raw.changeSets.map((changeSet: any) => changeSet.id)).size === raw.changeSets.length &&
    (raw.activeChangeSetId === undefined ||
      raw.changeSets.some((changeSet: any) => changeSet.id === raw.activeChangeSetId))
  );
}

function workflowPath(sessionId: string): string {
  return path.join(sessionsDir(), sessionId, FILE_NAME);
}

async function readUnlocked(sessionId: string): Promise<DesignWorkflowDocument> {
  let raw: string;
  try {
    raw = await fs.readFile(workflowPath(sessionId), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyDocument(sessionId);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DesignWorkflowError("design workflow record is unreadable", 409);
  }
  if (!isDocument(parsed, sessionId)) {
    throw new DesignWorkflowError("design workflow record is invalid", 409);
  }
  return parsed;
}

async function writeUnlocked(document: DesignWorkflowDocument): Promise<void> {
  const file = workflowPath(document.sessionId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const handle = await fs.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    try {
      const directory = await fs.open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // The file itself is durable even where directory fsync is unavailable.
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function assertSessionId(id: string): string {
  const sessionId = resolveSessionId(id);
  if (!isValidSessionId(sessionId)) throw new DesignWorkflowError("session not found", 404);
  return sessionId;
}

function assertExpected(document: DesignWorkflowDocument, expectedRevision: unknown): void {
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0) {
    throw new DesignWorkflowError("expectedRevision must be a non-negative integer", 400);
  }
  if (document.revision !== expectedRevision) {
    throw new DesignWorkflowError(
      `design workflow changed from revision ${expectedRevision}; refresh before trying again`,
      409,
    );
  }
}

function findChangeSet(document: DesignWorkflowDocument, changeSetId: string): DesignChangeSet {
  if (!SAFE_ID.test(changeSetId)) throw new DesignWorkflowError("change set not found", 404);
  const changeSet = document.changeSets.find((item) => item.id === changeSetId);
  if (!changeSet) throw new DesignWorkflowError("change set not found", 404);
  return changeSet;
}

function event(
  changeSet: DesignChangeSet,
  type: DesignChangeSet["events"][number]["type"],
  at: string,
  note?: string,
): void {
  changeSet.events.push({ id: randomUUID(), type, at, ...(note ? { note } : {}) });
  if (changeSet.events.length > MAX_EVENTS)
    changeSet.events.splice(0, changeSet.events.length - MAX_EVENTS);
}

async function mutate(
  id: string,
  expectedRevision: unknown,
  operation: (document: DesignWorkflowDocument, now: string) => void,
): Promise<DesignWorkflowDocument> {
  const sessionId = assertSessionId(id);
  return withSessionMutation(sessionId, async () => {
    const document = await readUnlocked(sessionId);
    assertExpected(document, expectedRevision);
    const now = new Date().toISOString();
    operation(document, now);
    document.revision += 1;
    document.updatedAt = now;
    await writeUnlocked(document);
    return document;
  });
}

export async function readDesignWorkflow(id: string): Promise<DesignWorkflowDocument> {
  return readUnlocked(assertSessionId(id));
}

export function createDesignChangeSet(
  id: string,
  input: DesignChangeSetCreateRequest,
): Promise<DesignWorkflowDocument> {
  return mutate(id, input.expectedRevision, (document, now) => {
    if (document.changeSets.length >= MAX_CHANGE_SETS) {
      throw new DesignWorkflowError(
        `a session may contain at most ${MAX_CHANGE_SETS} change sets`,
        409,
      );
    }
    const title = text(input.title, 160);
    const goal = text(input.goal, 4_000);
    const route = text(input.route, 2_048);
    const componentName = optionalText(input.componentName, 200);
    const selector = optionalText(input.selector, 500);
    const sourcePath = optionalText(input.sourcePath, 500);
    const viewport = optionalText(input.viewport, 100);
    if (!title || !goal || !route || !localRoute(route)) {
      throw new DesignWorkflowError("title, goal, and a local preview route are required", 400);
    }
    if (componentName === null || selector === null || sourcePath === null || viewport === null) {
      throw new DesignWorkflowError("change set context is invalid", 400);
    }
    if (sourcePath && !safeSourcePath(sourcePath)) {
      throw new DesignWorkflowError("change set source path is invalid", 400);
    }
    const changeSet: DesignChangeSet = {
      id: randomUUID(),
      title,
      goal,
      route,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      ...(componentName ? { componentName } : {}),
      ...(selector ? { selector } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(viewport ? { viewport } : {}),
      feedbackRefs: emptyRefs(),
      revisionIds: [],
      rolledBackRevisionIds: [],
      verification: { status: "not_run", viewports: [] },
      events: [],
    };
    event(changeSet, "created", now);
    document.changeSets.push(changeSet);
    document.activeChangeSetId = changeSet.id;
  });
}

export function updateDesignChangeSet(
  id: string,
  changeSetId: string,
  input: DesignChangeSetUpdateRequest,
): Promise<DesignWorkflowDocument> {
  return mutate(id, input.expectedRevision, (document, now) => {
    const changeSet = findChangeSet(document, changeSetId);
    if (!["draft", "rejected", "blocked"].includes(changeSet.status)) {
      throw new DesignWorkflowError(
        "only a draft, rejected, or blocked change set may be edited",
        409,
      );
    }
    const fields = [
      "title",
      "goal",
      "componentName",
      "selector",
      "sourcePath",
      "viewport",
    ] as const;
    if (!fields.some((key) => input[key] !== undefined)) {
      throw new DesignWorkflowError("at least one change set field is required", 400);
    }
    for (const key of fields) {
      if (input[key] === undefined) continue;
      const limit =
        key === "goal"
          ? 4_000
          : key === "selector" || key === "sourcePath"
            ? 500
            : key === "componentName"
              ? 200
              : key === "viewport"
                ? 100
                : 160;
      const value = text(input[key], limit, key !== "title" && key !== "goal");
      if (value === null || ((key === "title" || key === "goal") && !value)) {
        throw new DesignWorkflowError(`${key} is invalid`, 400);
      }
      if (key === "sourcePath" && value && !safeSourcePath(value)) {
        throw new DesignWorkflowError("change set source path is invalid", 400);
      }
      if (value) (changeSet as any)[key] = value;
      else delete (changeSet as any)[key];
    }
    if (changeSet.status !== "draft") {
      changeSet.status = "draft";
      delete changeSet.decision;
      changeSet.verification = { status: "not_run", viewports: [] };
      event(changeSet, "returned_to_draft", now, "brief changed");
    }
    changeSet.updatedAt = now;
    event(changeSet, "updated", now);
  });
}

export function activateDesignChangeSet(
  id: string,
  changeSetId: string,
  expectedRevision: number,
): Promise<DesignWorkflowDocument> {
  return mutate(id, expectedRevision, (document) => {
    findChangeSet(document, changeSetId);
    document.activeChangeSetId = changeSetId;
  });
}

const TRANSITIONS: Record<
  DesignWorkflowTransitionAction,
  {
    from: DesignChangeSet["status"][];
    to: DesignChangeSet["status"];
    event: DesignChangeSet["events"][number]["type"];
  }
> = {
  submit_review: { from: ["draft"], to: "in_review", event: "submitted_for_review" },
  approve: { from: ["in_review"], to: "approved", event: "approved" },
  reject: { from: ["in_review"], to: "rejected", event: "rejected" },
  return_to_draft: {
    from: ["rejected", "blocked", "in_review", "approved"],
    to: "draft",
    event: "returned_to_draft",
  },
  deliver: { from: ["verified"], to: "delivered", event: "delivered" },
  reopen: { from: ["delivered", "verified"], to: "draft", event: "reopened" },
};

export function transitionDesignChangeSet(
  id: string,
  changeSetId: string,
  expectedRevision: number,
  action: DesignWorkflowTransitionAction,
  note?: string,
): Promise<DesignWorkflowDocument> {
  return mutate(id, expectedRevision, (document, now) => {
    const transition = TRANSITIONS[action];
    if (!transition) throw new DesignWorkflowError("workflow transition is invalid", 400);
    const changeSet = findChangeSet(document, changeSetId);
    const normalizedNote = note === undefined ? undefined : text(note, 1_000, true);
    if (normalizedNote === null) throw new DesignWorkflowError("decision note is invalid", 400);
    if (action === "reject" && !normalizedNote) {
      throw new DesignWorkflowError("a reason is required when requesting changes", 400);
    }
    if (!transition.from.includes(changeSet.status)) {
      throw new DesignWorkflowError(`cannot ${action} a ${changeSet.status} change set`, 409);
    }
    changeSet.status = transition.to;
    changeSet.updatedAt = now;
    if (action === "approve" || action === "reject") {
      changeSet.decision = {
        outcome: action === "approve" ? "approved" : "rejected",
        decidedAt: now,
        ...(normalizedNote ? { note: normalizedNote } : {}),
      };
    }
    if (action === "return_to_draft" || action === "reopen") {
      delete changeSet.decision;
      changeSet.verification = { status: "not_run", viewports: [] };
    }
    event(changeSet, transition.event, now, normalizedNote);
  });
}

export function linkDesignFeedback(
  id: string,
  changeSetId: string,
  expectedRevision: number,
  refs: Partial<DesignChangeSetFeedbackRefs>,
): Promise<DesignWorkflowDocument> {
  return mutate(id, expectedRevision, (document, now) => {
    const changeSet = findChangeSet(document, changeSetId);
    if (changeSet.status === "delivered") {
      throw new DesignWorkflowError(
        "reopen the delivered change set before changing its scope",
        409,
      );
    }
    if (!exactKeys(refs as Record<string, unknown>, REF_KEYS)) {
      throw new DesignWorkflowError("feedback reference type is invalid", 400);
    }
    let added = 0;
    for (const key of REF_KEYS) {
      const incoming = refs[key];
      if (incoming === undefined) continue;
      if (!validIdList(incoming, 50))
        throw new DesignWorkflowError("feedback references are invalid", 400);
      for (const itemId of incoming) {
        if (!changeSet.feedbackRefs[key].includes(itemId)) {
          changeSet.feedbackRefs[key].push(itemId);
          added += 1;
        }
      }
    }
    if (!added) throw new DesignWorkflowError("no new feedback references were supplied", 409);
    if (changeSet.status !== "draft") {
      changeSet.status = "draft";
      delete changeSet.decision;
      changeSet.verification = { status: "not_run", viewports: [] };
      event(changeSet, "returned_to_draft", now, "scope changed after review");
    }
    changeSet.updatedAt = now;
    event(changeSet, "feedback_linked", now, `${added} item${added === 1 ? "" : "s"}`);
  });
}

export function unlinkDesignFeedback(
  id: string,
  changeSetId: string,
  expectedRevision: number,
  refs: Partial<DesignChangeSetFeedbackRefs>,
): Promise<DesignWorkflowDocument> {
  return mutate(id, expectedRevision, (document, now) => {
    const changeSet = findChangeSet(document, changeSetId);
    if (changeSet.status === "delivered") {
      throw new DesignWorkflowError(
        "reopen the delivered change set before changing its scope",
        409,
      );
    }
    if (!exactKeys(refs as Record<string, unknown>, REF_KEYS)) {
      throw new DesignWorkflowError("feedback reference type is invalid", 400);
    }
    let removed = 0;
    for (const key of REF_KEYS) {
      const outgoing = refs[key];
      if (outgoing === undefined) continue;
      if (!validIdList(outgoing, 50))
        throw new DesignWorkflowError("feedback references are invalid", 400);
      const ids = new Set(outgoing);
      const before = changeSet.feedbackRefs[key].length;
      changeSet.feedbackRefs[key] = changeSet.feedbackRefs[key].filter(
        (itemId) => !ids.has(itemId),
      );
      removed += before - changeSet.feedbackRefs[key].length;
    }
    if (!removed) throw new DesignWorkflowError("no linked feedback references were supplied", 409);
    if (changeSet.status !== "draft") {
      changeSet.status = "draft";
      delete changeSet.decision;
      changeSet.verification = { status: "not_run", viewports: [] };
      event(changeSet, "returned_to_draft", now, "scope changed after review");
    }
    changeSet.updatedAt = now;
    event(changeSet, "feedback_unlinked", now, `${removed} item${removed === 1 ? "" : "s"}`);
  });
}

export async function requireDesignWorkflowApply(
  id: string,
  suppliedChangeSetId: unknown,
): Promise<string | undefined> {
  const document = await readDesignWorkflow(id);
  if (!document.activeChangeSetId) {
    if (suppliedChangeSetId !== undefined) {
      throw new DesignWorkflowError("the supplied change set is not active", 409);
    }
    return undefined;
  }
  if (
    typeof suppliedChangeSetId !== "string" ||
    suppliedChangeSetId !== document.activeChangeSetId
  ) {
    throw new DesignWorkflowError("select the active change set before writing source", 409);
  }
  const changeSet = findChangeSet(document, document.activeChangeSetId);
  if (!["approved", "implementing"].includes(changeSet.status)) {
    throw new DesignWorkflowError("approve the active change set before writing source", 409);
  }
  return changeSet.id;
}

export async function recordDesignWorkflowRevision(
  id: string,
  changeSetId: string,
  revisionId: string,
): Promise<DesignWorkflowDocument> {
  const sessionId = assertSessionId(id);
  return withSessionMutation(sessionId, async () => {
    const document = await readUnlocked(sessionId);
    const changeSet = findChangeSet(document, changeSetId);
    if (!changeSet.revisionIds.includes(revisionId)) changeSet.revisionIds.push(revisionId);
    const now = new Date().toISOString();
    if (changeSet.status === "approved") changeSet.status = "implementing";
    changeSet.updatedAt = now;
    event(changeSet, "source_applied", now, revisionId);
    document.revision += 1;
    document.updatedAt = now;
    await writeUnlocked(document);
    return document;
  });
}

export async function reconcileDesignWorkflowRevisions(
  id: string,
  revisions: LiveDesignRevision[],
): Promise<DesignWorkflowDocument> {
  const sessionId = assertSessionId(id);
  return withSessionMutation(sessionId, async () => {
    const document = await readUnlocked(sessionId);
    let changed = false;
    for (const revision of revisions) {
      if (!revision.changeSetId) continue;
      const changeSet = document.changeSets.find((item) => item.id === revision.changeSetId);
      if (!changeSet) continue;
      if (!changeSet.revisionIds.includes(revision.id)) {
        changeSet.revisionIds.push(revision.id);
        if (changeSet.status === "approved") changeSet.status = "implementing";
        changed = true;
      }
      if (revision.rolledBackAt && !changeSet.rolledBackRevisionIds.includes(revision.id)) {
        changeSet.rolledBackRevisionIds.push(revision.id);
        changed = true;
      }
    }
    if (!changed) return document;
    const now = new Date().toISOString();
    document.revision += 1;
    document.updatedAt = now;
    await writeUnlocked(document);
    return document;
  });
}

export function recordDesignWorkflowVerification(
  id: string,
  changeSetId: string,
  expectedRevision: number,
  verification: DesignChangeSetVerification,
): Promise<DesignWorkflowDocument> {
  return mutate(id, expectedRevision, (document, now) => {
    const changeSet = findChangeSet(document, changeSetId);
    if (changeSet.status !== "implementing") {
      throw new DesignWorkflowError(
        "apply at least one approved source revision before verification",
        409,
      );
    }
    if (
      !changeSet.revisionIds.some(
        (revisionId) => !changeSet.rolledBackRevisionIds.includes(revisionId),
      )
    ) {
      throw new DesignWorkflowError("there are no active source revisions to verify", 409);
    }
    if (!isVerification(verification) || verification.status === "not_run") {
      throw new DesignWorkflowError("visual verification result is invalid", 400);
    }
    changeSet.verification = verification;
    changeSet.status = verification.status === "failed" ? "blocked" : "verified";
    changeSet.updatedAt = now;
    event(changeSet, "verification_completed", now, verification.summary);
  });
}

export async function recordDesignWorkflowRollback(
  id: string,
  changeSetId: string,
  rolledBackRevisionIds: string[],
): Promise<DesignWorkflowDocument> {
  const sessionId = assertSessionId(id);
  return withSessionMutation(sessionId, async () => {
    const document = await readUnlocked(sessionId);
    const changeSet = findChangeSet(document, changeSetId);
    for (const revisionId of rolledBackRevisionIds) {
      if (!changeSet.rolledBackRevisionIds.includes(revisionId)) {
        changeSet.rolledBackRevisionIds.push(revisionId);
      }
    }
    const now = new Date().toISOString();
    changeSet.status = "draft";
    changeSet.verification = { status: "not_run", viewports: [] };
    changeSet.updatedAt = now;
    event(changeSet, "rollback_completed", now, `${rolledBackRevisionIds.length} source revisions`);
    document.revision += 1;
    document.updatedAt = now;
    await writeUnlocked(document);
    return document;
  });
}

export async function recordDesignWorkflowRollbackBlocked(
  id: string,
  changeSetId: string,
  rolledBackRevisionIds: string[],
  message: string,
): Promise<DesignWorkflowDocument> {
  const sessionId = assertSessionId(id);
  return withSessionMutation(sessionId, async () => {
    const document = await readUnlocked(sessionId);
    const changeSet = findChangeSet(document, changeSetId);
    for (const revisionId of rolledBackRevisionIds) {
      if (!changeSet.rolledBackRevisionIds.includes(revisionId))
        changeSet.rolledBackRevisionIds.push(revisionId);
    }
    const now = new Date().toISOString();
    changeSet.status = "blocked";
    changeSet.updatedAt = now;
    event(changeSet, "rollback_blocked", now, text(message, 1_000, true) || "rollback stopped");
    document.revision += 1;
    document.updatedAt = now;
    await writeUnlocked(document);
    return document;
  });
}
