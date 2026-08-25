import { useQuery } from "@tanstack/react-query";
import { glimmerApi } from "../../api/client";
import { CollapsibleSection } from "../common/CollapsibleSection";

export function TaskReportPanel({
  sessionId,
  ready = true,
}: {
  sessionId: string;
  ready?: boolean;
}) {
  const { data: report } = useQuery({
    queryKey: ["task-report", sessionId],
    queryFn: () => glimmerApi.getTaskReport(sessionId),
    // The report is written immediately before the session becomes terminal.
    // Fetching while the run is active returns 404; with retry disabled that
    // failed query would otherwise remain cached after completion.
    enabled: !!sessionId && ready,
    retry: false,
  });
  if (!report) return null;

  const summary = `${report.mode} · ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} · ${report.confidence} confidence`;
  return (
    <CollapsibleSection title="Task Report" summary={summary} defaultOpen>
      <p>{report.summary}</p>
      {report.reportFailed && (
        <p role="alert" style={{ color: "var(--red)" }}>
          Report generation failed
          {report.reportFailureReason ? `: ${report.reportFailureReason}` : "."}
        </p>
      )}
      {report.findings.length > 0 && (
        <>
          <h3>Findings</h3>
          <ol>
            {report.findings.map((finding, index) => (
              <li key={`${finding.title}-${index}`}>
                <strong>
                  {finding.severity}: {finding.title}
                </strong>
                <p>{finding.description}</p>
                {finding.evidence.length > 0 && (
                  <ul>
                    {finding.evidence.map((evidence, evidenceIndex) => (
                      <li key={`${evidence.path}-${evidence.line ?? 0}-${evidenceIndex}`}>
                        <span className="mono">
                          {evidence.path}
                          {evidence.line ? `:${evidence.line}` : ""}
                        </span>
                        {` — ${evidence.detail}`}
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  <strong>Recommended fix:</strong> {finding.recommendedFix}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
      {report.implementationPlan.length > 0 && (
        <>
          <h3>Implementation plan</h3>
          <ol>
            {report.implementationPlan.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </>
      )}
    </CollapsibleSection>
  );
}
