import { useEffect, useMemo, useState } from "react";
import type {
  DesignChangeSet,
  DesignChangeSetCreateRequest,
  DesignWorkflowDocument,
  DesignWorkflowTransitionAction,
  LiveDesignElement,
  VisualCapture,
} from "@glimmer/shared";

const STEPS = ["Brief", "Explore", "Edit", "Compare", "Review", "Implement", "Verify", "Deliver"];

function routeLabel(route: string): string {
  try {
    const path = new URL(route).pathname.replace(/^\/+|\/+$/g, "");
    return path ? path.split("/").slice(-2).join(" / ") : "home page";
  } catch {
    return "current page";
  }
}

function feedbackCount(changeSet: DesignChangeSet): number {
  return Object.values(changeSet.feedbackRefs).reduce((total, ids) => total + ids.length, 0);
}

function currentStep(changeSet: DesignChangeSet, hasSelection: boolean): number {
  if (changeSet.status === "delivered") return 7;
  if (["verifying", "verified", "blocked"].includes(changeSet.status)) return 6;
  if (["approved", "implementing"].includes(changeSet.status)) return 5;
  if (["in_review", "rejected"].includes(changeSet.status)) return 4;
  if (changeSet.feedbackRefs.variantIds.length) return 3;
  if (feedbackCount(changeSet)) return 2;
  return hasSelection ? 1 : 0;
}

function statusLabel(status: DesignChangeSet["status"]): string {
  return {
    draft: "Draft",
    in_review: "In review",
    approved: "Approved",
    implementing: "Implementing",
    verifying: "Verifying",
    verified: "Verified",
    blocked: "Needs attention",
    delivered: "Delivered",
    rejected: "Changes requested",
  }[status];
}

interface Props {
  document: DesignWorkflowDocument | undefined;
  route: string;
  selected: LiveDesignElement | null;
  capture?: VisualCapture;
  busy: boolean;
  error: string;
  onCreate: (input: Omit<DesignChangeSetCreateRequest, "expectedRevision">) => void;
  onActivate: (changeSetId: string) => void;
  onTransition: (action: DesignWorkflowTransitionAction, note?: string) => void;
  onVerify: () => void;
  onRollback: () => void;
}

export function DesignWorkflowPanel({
  document,
  route,
  selected,
  capture,
  busy,
  error,
  onCreate,
  onActivate,
  onTransition,
  onVerify,
  onRollback,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState(`Improve ${routeLabel(route)}`);
  const [goal, setGoal] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [confirmRollback, setConfirmRollback] = useState(false);
  const active = document?.changeSets.find((item) => item.id === document.activeChangeSetId);
  const step = active ? currentStep(active, Boolean(selected)) : 0;
  const activeRevisionCount = active
    ? active.revisionIds.filter((id) => !active.rolledBackRevisionIds.includes(id)).length
    : 0;
  const counts = useMemo(
    () =>
      active
        ? {
            notes: active.feedbackRefs.annotationIds.length,
            changes: active.feedbackRefs.elementEditIds.length,
            variants: active.feedbackRefs.variantIds.length,
            assets: active.feedbackRefs.assetRequestIds.length,
            revisions: activeRevisionCount,
          }
        : null,
    [active, activeRevisionCount],
  );

  useEffect(() => {
    if (selected && !goal) {
      setGoal(
        `Improve ${selected.componentName || selected.tagName.toLowerCase()} while preserving the existing design system and responsive behavior.`,
      );
    }
  }, [goal, selected]);

  function create() {
    if (!title.trim() || !goal.trim()) return;
    onCreate({
      title: title.trim(),
      goal: goal.trim(),
      route,
      ...(selected?.componentName ? { componentName: selected.componentName } : {}),
      ...(selected?.selector ? { selector: selected.selector } : {}),
      ...(selected?.sourcePathHint ? { sourcePath: selected.sourcePathHint } : {}),
      ...(capture?.viewport ? { viewport: capture.viewport } : {}),
    });
    setShowCreate(false);
  }

  return (
    <section className="design-workflow" aria-label="Design workflow">
      <div className="design-workflow__topline">
        <div>
          <span className="design-workflow__eyebrow">Design workflow</span>
          <strong>{active?.title ?? "Turn visual ideas into verified changes"}</strong>
        </div>
        <div className="design-workflow__top-actions">
          {document && document.changeSets.length > 1 && (
            <label>
              <span className="sr-only">Active change set</span>
              <select
                value={active?.id ?? ""}
                disabled={busy}
                onChange={(event) => onActivate(event.target.value)}
              >
                {document.changeSets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {active && (
            <span className={`design-workflow__status design-workflow__status--${active.status}`}>
              {statusLabel(active.status)}
            </span>
          )}
          <button
            type="button"
            className="design-workflow__quiet"
            onClick={() => setShowCreate(true)}
          >
            + New change set
          </button>
        </div>
      </div>

      {active && (
        <ol className="design-workflow__steps">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={index < step ? "is-complete" : index === step ? "is-current" : ""}
              aria-current={index === step ? "step" : undefined}
            >
              <span>{index < step ? "✓" : index + 1}</span>
              <small>{label}</small>
            </li>
          ))}
        </ol>
      )}

      {(!active || showCreate) && (
        <div className="design-workflow__create">
          <div>
            <h4>{active ? "Start another change set" : "Start with a clear outcome"}</h4>
            <p>
              Glimmer saves this workflow continuously, including decisions, notes, source
              revisions, and verification evidence.
            </p>
          </div>
          <label>
            Change set name
            <input
              value={title}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="design-workflow__goal">
            What should become better?
            <textarea
              rows={2}
              maxLength={4000}
              value={goal}
              placeholder="Describe the user outcome, not filenames to search for…"
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          <div className="design-workflow__create-actions">
            {showCreate && active && (
              <button type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
            )}
            <button
              type="button"
              className="design-workflow__primary"
              disabled={busy || !title.trim() || !goal.trim()}
              onClick={create}
            >
              {busy ? "Saving…" : "Start workflow"}
            </button>
          </div>
        </div>
      )}

      {active && !showCreate && (
        <div className="design-workflow__body">
          <div className="design-workflow__summary">
            <div>
              <span>Goal</span>
              <p>{active.goal}</p>
            </div>
            <div className="design-workflow__counts" aria-label="Change set contents">
              <span>
                <strong>{counts?.notes}</strong> notes
              </span>
              <span>
                <strong>{counts?.changes}</strong> queued
              </span>
              <span>
                <strong>{counts?.variants}</strong> variants
              </span>
              <span>
                <strong>{counts?.assets}</strong> assets
              </span>
              <span>
                <strong>{counts?.revisions}</strong> source saves
              </span>
            </div>
          </div>

          {active.decision?.note && (
            <p className="design-workflow__decision">
              <strong>
                {active.decision.outcome === "approved" ? "Decision" : "Requested changes"}:
              </strong>{" "}
              {active.decision.note}
            </p>
          )}

          {!!active.verification.viewports.length && (
            <div className="design-workflow__verification">
              {active.verification.viewports.map((viewport) => (
                <span key={`${viewport.viewport}-${viewport.state}`} data-status={viewport.status}>
                  <strong>
                    {viewport.status === "passed" ? "✓" : viewport.status === "warning" ? "!" : "×"}
                  </strong>
                  {viewport.viewport} · {viewport.state}
                  {viewport.findingCount ? ` · ${viewport.findingCount} finding(s)` : ""}
                </span>
              ))}
              {active.verification.summary && <p>{active.verification.summary}</p>}
            </div>
          )}

          {(active.status === "in_review" || active.status === "rejected") && (
            <label className="design-workflow__decision-input">
              Decision note {active.status === "in_review" && "(required when requesting changes)"}
              <input
                value={decisionNote}
                maxLength={1000}
                placeholder="What was decided, and why?"
                onChange={(event) => setDecisionNote(event.target.value)}
              />
            </label>
          )}

          <div className="design-workflow__actions">
            <span className="design-workflow__saved">
              <i /> Continuously saved · revision {document?.revision ?? 0}
            </span>
            <div>
              {activeRevisionCount > 0 && active.status !== "delivered" && !confirmRollback && (
                <button
                  type="button"
                  className="design-workflow__danger"
                  disabled={busy}
                  onClick={() => setConfirmRollback(true)}
                >
                  Roll back change set
                </button>
              )}
              {confirmRollback && (
                <span
                  className="design-workflow__rollback-confirm"
                  role="group"
                  aria-label="Confirm rollback"
                >
                  <span>Undo all {activeRevisionCount} active source save(s)?</span>
                  <button type="button" disabled={busy} onClick={() => setConfirmRollback(false)}>
                    Keep changes
                  </button>
                  <button
                    type="button"
                    className="design-workflow__danger"
                    disabled={busy}
                    onClick={() => {
                      onRollback();
                      setConfirmRollback(false);
                    }}
                  >
                    Confirm rollback
                  </button>
                </span>
              )}
              {active.status === "draft" && (
                <button
                  type="button"
                  className="design-workflow__primary"
                  disabled={busy}
                  onClick={() => onTransition("submit_review")}
                >
                  Send to review →
                </button>
              )}
              {active.status === "in_review" && (
                <>
                  <button
                    type="button"
                    disabled={busy || !decisionNote.trim()}
                    onClick={() => onTransition("reject", decisionNote.trim())}
                  >
                    Request changes
                  </button>
                  <button
                    type="button"
                    className="design-workflow__primary"
                    disabled={busy}
                    onClick={() => onTransition("approve", decisionNote.trim() || undefined)}
                  >
                    Approve implementation →
                  </button>
                </>
              )}
              {(active.status === "rejected" || active.status === "blocked") && (
                <button
                  type="button"
                  className="design-workflow__primary"
                  disabled={busy}
                  onClick={() => onTransition("return_to_draft")}
                >
                  Return to editing →
                </button>
              )}
              {active.status === "approved" && (
                <span className="design-workflow__next">
                  Select an element and save the approved change to source.
                </span>
              )}
              {active.status === "implementing" && (
                <button
                  type="button"
                  className="design-workflow__primary"
                  disabled={busy}
                  onClick={onVerify}
                >
                  Verify across viewports →
                </button>
              )}
              {active.status === "verified" && (
                <button
                  type="button"
                  className="design-workflow__primary"
                  disabled={busy}
                  onClick={() => onTransition("deliver")}
                >
                  Mark delivered →
                </button>
              )}
              {active.status === "delivered" && (
                <button type="button" disabled={busy} onClick={() => onTransition("reopen")}>
                  Reopen workflow
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <p className="design-workflow__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
