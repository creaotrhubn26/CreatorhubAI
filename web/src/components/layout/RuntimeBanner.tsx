import { useEffect, useState } from "react";
import { tauriGlobal } from "../../state/desktopNotify";
import { runPostUpdateSmoke, type PostUpdateSmokeResult } from "../../state/postUpdateSmoke";

interface GatewaySupervisorStatus {
  state: string;
  detail: string;
  pid?: number;
  restartCount: number;
  lastError?: string;
}

export function RuntimeBanner() {
  const [supervisor, setSupervisor] = useState<GatewaySupervisorStatus | null>(null);
  const [updateSmoke, setUpdateSmoke] = useState<PostUpdateSmokeResult>(null);

  useEffect(() => {
    let active = true;
    const tauri = tauriGlobal();
    if (!tauri) return;
    async function refreshSupervisor() {
      try {
        const status = (await tauri!.core.invoke(
          "gateway_supervisor_status",
          {},
        )) as GatewaySupervisorStatus;
        if (active) setSupervisor(status);
      } catch {
        if (active) {
          setSupervisor({
            state: "error",
            detail: "The native gateway supervisor could not be inspected.",
            restartCount: 0,
          });
        }
      }
    }
    void refreshSupervisor();
    const timer = window.setInterval(refreshSupervisor, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void runPostUpdateSmoke().then((result) => {
      if (active) setUpdateSmoke(result);
    });
    return () => {
      active = false;
    };
  }, []);

  const supervisorProblem =
    supervisor && ["port_conflict", "error", "restarting"].includes(supervisor.state)
      ? supervisor
      : null;
  if (!supervisorProblem && !updateSmoke) return null;

  return (
    <div className="runtime-banners" aria-live="polite">
      {supervisorProblem && (
        <div className="runtime-banner" data-state="warning" role="alert">
          <strong>Gateway: {supervisorProblem.state.replaceAll("_", " ")}</strong>
          <span>{supervisorProblem.detail}</span>
        </div>
      )}
      {updateSmoke && (
        <div
          className="runtime-banner"
          data-state={updateSmoke.status === "success" ? "success" : "error"}
          role={updateSmoke.status === "failure" ? "alert" : "status"}
        >
          <strong>Post-update check</strong>
          <span>{updateSmoke.message}</span>
          {updateSmoke.status === "failure" && (
            <a href={updateSmoke.rollbackUrl} target="_blank" rel="noreferrer">
              Previous signed release
            </a>
          )}
        </div>
      )}
    </div>
  );
}
