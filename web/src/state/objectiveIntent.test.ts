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

  it("records structured intent without replacing the literal objective", () => {
    const result = interpretObjectiveIntent("Hva kan bli bedre?", "implement");

    expect(result?.intent).toEqual({
      kind: "improvement-assessment",
      source: "deterministic-inference",
    });
  });

  it("keeps review intent read-only and tailored to the selected mode", () => {
    const result = interpretObjectiveIntent("Hva som kan bli bedre?", "review");

    expect(result?.intent.kind).toBe("improvement-assessment");
    expect(result?.explanation).toContain("prioritized findings");
  });

  it.each([
    "Fix cancellation when the adopted session id is used",
    'Fiks teksten "Hva kan bli bedre?" i AssessmentTab',
    "Improve the frontend session screen by keeping the error visible after refresh",
  ])("does not rewrite an already concrete task: %s", (objective) => {
    expect(interpretObjectiveIntent(objective, "implement")).toBeNull();
  });
});
