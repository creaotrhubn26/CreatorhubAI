import { inferTaskIntent, type TaskContract, type TaskIntent } from "@glimmer/shared";

export interface ObjectiveInterpretation {
  kind: "improvement-assessment";
  intent: TaskIntent;
  explanation: string;
}

export function explainTaskIntent(kind: TaskIntent["kind"], mode: TaskContract["mode"]): string {
  if (kind === "direct") {
    return "Interpreted as a direct task: Glimmer will follow the literal objective and inspect only the code needed to carry it out.";
  }
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
  const intent = inferTaskIntent(objective);
  if (intent.kind !== "improvement-assessment") return null;

  return {
    kind: "improvement-assessment",
    intent,
    explanation: explainTaskIntent(intent.kind, mode),
  };
}
