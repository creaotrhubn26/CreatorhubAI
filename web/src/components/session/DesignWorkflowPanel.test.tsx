import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesignChangeSet, DesignWorkflowDocument } from "@glimmer/shared";
import { DesignWorkflowPanel } from "./DesignWorkflowPanel";

function changeSet(patch: Partial<DesignChangeSet> = {}): DesignChangeSet {
  return {
    id: "change-set-1",
    title: "Improve checkout",
    goal: "Make the checkout action easier to understand.",
    route: "http://localhost:4173/checkout",
    status: "draft",
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    feedbackRefs: {
      annotationIds: [],
      variantIds: [],
      inspirationIds: [],
      elementEditIds: [],
      assetRequestIds: [],
    },
    revisionIds: [],
    rolledBackRevisionIds: [],
    verification: { status: "not_run", viewports: [] },
    events: [],
    ...patch,
  };
}

function document(active?: DesignChangeSet): DesignWorkflowDocument {
  return {
    version: 1,
    revision: active ? 4 : 0,
    sessionId: "s1",
    updatedAt: active ? active.updatedAt : "1970-01-01T00:00:00.000Z",
    ...(active ? { activeChangeSetId: active.id } : {}),
    changeSets: active ? [active] : [],
  };
}

function renderPanel(
  workflow: DesignWorkflowDocument,
  callbacks: Partial<React.ComponentProps<typeof DesignWorkflowPanel>> = {},
) {
  const defaults: React.ComponentProps<typeof DesignWorkflowPanel> = {
    document: workflow,
    route: "http://localhost:4173/checkout",
    selected: null,
    busy: false,
    error: "",
    onCreate: vi.fn(),
    onActivate: vi.fn(),
    onTransition: vi.fn(),
    onVerify: vi.fn(),
    onRollback: vi.fn(),
  };
  const props = { ...defaults, ...callbacks };
  render(<DesignWorkflowPanel {...props} />);
  return props;
}

describe("DesignWorkflowPanel", () => {
  it("starts from a user outcome instead of treating the prompt as a filename search", () => {
    const props = renderPanel(document());
    expect(screen.getByText("Start with a clear outcome")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/user outcome, not filenames/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What should become better?"), {
      target: { value: "Reduce hesitation at checkout." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start workflow" }));
    expect(props.onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Improve checkout",
        goal: "Reduce hesitation at checkout.",
      }),
    );
  });

  it("shows the review decision as the single next action and requires a rejection reason", () => {
    const onTransition = vi.fn();
    renderPanel(document(changeSet({ status: "in_review" })), { onTransition });
    expect(screen.getByText("Review").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(/continuously saved · revision 4/i)).toBeInTheDocument();
    const reject = screen.getByRole("button", { name: "Request changes" });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Decision note/), {
      target: { value: "Keep the token, change the hierarchy." },
    });
    fireEvent.click(reject);
    expect(onTransition).toHaveBeenCalledWith("reject", "Keep the token, change the hierarchy.");
  });

  it("summarizes multi-viewport evidence before delivery", () => {
    const onTransition = vi.fn();
    renderPanel(
      document(
        changeSet({
          status: "verified",
          revisionIds: ["revision-1"],
          verification: {
            status: "passed_with_warnings",
            checkedAt: "2026-08-27T12:10:00.000Z",
            viewports: [
              { viewport: "390x844", state: "initial", status: "passed", findingCount: 0 },
              {
                viewport: "1280x720",
                state: "initial",
                status: "warning",
                findingCount: 1,
              },
            ],
            summary: "Captured successfully with one warning.",
          },
        }),
      ),
      { onTransition },
    );
    expect(screen.getByText(/390x844 · initial/)).toBeInTheDocument();
    expect(screen.getByText(/1280x720 · initial · 1 finding/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark delivered →" }));
    expect(onTransition).toHaveBeenCalledWith("deliver");
  });
});
