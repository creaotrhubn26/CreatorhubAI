import type { TaskContract } from "@glimmer/shared";

export interface ObjectiveInterpretation {
  kind: "improvement-assessment";
  effectiveObjective: string;
  explanation: string;
}

const OPEN_ENDED_IMPROVEMENT_PATTERNS = [
  /^(?:kan du\s+)?(?:(?:se(?:\s+på)?|sjekk|vurder|analyser|gjennomgå)\s+)?(?:hva|hvilke)\b.*\b(?:bedre|forbedres|forbedringer|fikses|rettes)\b/i,
  /^(?:kan du\s+)?(?:finn|identifiser|kartlegg)\b.*\b(?:forbedring(?:er|smuligheter)?|svakheter|problemer)\b/i,
  /^(?:can you\s+)?(?:(?:look at|check|assess|analy[sz]e|review)\s+)?(?:what|which)\b.*\b(?:better|improved|improvement|fixed)\b/i,
  /^(?:can you\s+)?(?:find|identify|map)\b.*\b(?:improvements?|weaknesses|issues)\b/i,
];

function isOpenEndedImprovementRequest(objective: string): boolean {
  const normalized = objective.normalize("NFKC").trim().replace(/\s+/g, " ");
  // This interpreter is intentionally narrow. Longer, detailed tasks are
  // already concrete enough for the engineer and should never be rewritten
  // merely because they happen to contain a word such as "improvement".
  if (!normalized || normalized.length > 240) return false;
  return OPEN_ENDED_IMPROVEMENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function actionForMode(mode: TaskContract["mode"]): string {
  switch (mode) {
    case "inspect":
    case "review":
      return "Do not modify files. Return a prioritized review with concrete recommended fixes and the evidence for each finding.";
    case "plan":
      return "Do not modify files. Produce a prioritized implementation plan for the strongest evidence-backed improvements.";
    case "debug":
      return "Select the highest-confidence concrete defect that is safe and well bounded in the current scope, fix it, and verify the change. Report other strong candidates as next steps.";
    case "test":
      return "Select the highest-impact concrete gap in tests or verification that is safe and well bounded in the current scope, implement it, and run the relevant checks. Report other strong candidates as next steps.";
    case "refactor":
      return "Select the highest-impact maintainability improvement that is safe and well bounded in the current scope, implement the refactor, and verify behavior. Report other strong candidates as next steps.";
    case "implement":
      return "Select the highest-impact candidate that is safe and well bounded in the current scope, implement it, and verify the change. Report other strong candidates as next steps.";
  }
}

function explanationForMode(mode: TaskContract["mode"]): string {
  if (mode === "inspect" || mode === "review") {
    return "Interpreted as an improvement review: Glimmer will inspect real code and report prioritized findings, not search for those words.";
  }
  if (mode === "plan") {
    return "Interpreted as an improvement review: Glimmer will inspect real code and produce a prioritized plan, not search for those words.";
  }
  return `Interpreted as an improvement review first: in ${mode} mode, Glimmer will choose one concrete improvement, act on it, and verify it — not search for those words.`;
}

export function interpretObjectiveIntent(
  objective: string,
  mode: TaskContract["mode"],
): ObjectiveInterpretation | null {
  if (!isOpenEndedImprovementRequest(objective)) return null;

  return {
    kind: "improvement-assessment",
    effectiveObjective: [
      "Repository improvement assessment.",
      "Inspect the selected repository scope for concrete, evidence-backed defects and improvement opportunities.",
      "Do not search the repository for words or phrases from the user's question; discover candidates from repository structure, behavior, tests, and code evidence.",
      "Consider correctness, maintainability, architecture, reliability, performance, accessibility and UX, tests, and documentation where relevant.",
      "Prioritize candidates by impact and confidence, citing specific files or symbols.",
      actionForMode(mode),
    ].join(" "),
    explanation: explanationForMode(mode),
  };
}
