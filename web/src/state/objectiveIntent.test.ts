import { describe, expect, it } from "vitest";
import { interpretObjectiveIntent } from "./objectiveIntent";

describe("interpretObjectiveIntent", () => {
  it.each([
    "Hva kan bli bedre?",
    "Se hva som kan forbedres i frontenden",
    "Finn forbedringsmuligheter",
    "What can be improved?",
    "Identify improvement opportunities",
  ])("recognizes an open-ended improvement request: %s", (objective) => {
    expect(interpretObjectiveIntent(objective, "implement")?.kind).toBe("improvement-assessment");
  });

  it("turns implement mode into an evidence-first improvement task without carrying the literal wording", () => {
    const result = interpretObjectiveIntent("Hva kan bli bedre?", "implement");

    expect(result?.effectiveObjective).toContain("evidence-backed defects and improvement opportunities");
    expect(result?.effectiveObjective).toContain("Do not search the repository for words or phrases");
    expect(result?.effectiveObjective).toContain("implement it, and verify the change");
    expect(result?.effectiveObjective).not.toContain("Hva kan bli bedre");
  });

  it("keeps review intent read-only and tailored to the selected mode", () => {
    const result = interpretObjectiveIntent("Hva som kan bli bedre?", "review");

    expect(result?.effectiveObjective).toContain("Do not modify files");
    expect(result?.effectiveObjective).toContain("prioritized review");
  });

  it.each([
    "Fix cancellation when the adopted session id is used",
    'Fiks teksten "Hva kan bli bedre?" i AssessmentTab',
    "Improve the frontend session screen by keeping the error visible after refresh",
  ])("does not rewrite an already concrete task: %s", (objective) => {
    expect(interpretObjectiveIntent(objective, "implement")).toBeNull();
  });
});
