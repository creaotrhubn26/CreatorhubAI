import { useEffect, useState } from "react";
import {
  appUpdaterSupported,
  checkForAppUpdate,
  downloadAndInstallAppUpdate,
  getInstalledAppVersion,
  restartApp,
  type AppUpdateInfo,
  type AppUpdateProgress,
} from "../../state/appUpdater";

type UpdatePhase = "idle" | "checking" | "available" | "current" | "installing" | "ready";

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function progressLabel(progress: AppUpdateProgress | null): string {
  if (!progress) return "Preparing download…";
  if (progress.finished) return "Finishing installation…";
  if (!progress.totalBytes) {
    return `${(progress.downloadedBytes / 1_048_576).toFixed(1)} MB downloaded`;
  }
  return `${Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))}% downloaded`;
}

export function AppUpdateSettings() {
  const supported = appUpdaterSupported();
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    void getInstalledAppVersion()
      .then(setCurrentVersion)
      .catch((reason) =>
        setError(`Could not read the installed version — ${readableError(reason)}`),
      );
  }, [supported]);

  async function checkNow() {
    setPhase("checking");
    setUpdate(null);
    setProgress(null);
    setError(null);
    try {
      const result = await checkForAppUpdate();
      if (!result.supported) {
        setPhase("idle");
        return;
      }
      setUpdate(result.update);
      setPhase(result.update ? "available" : "current");
    } catch (reason) {
      setPhase("idle");
      setError(`Could not check for updates — ${readableError(reason)}`);
    }
  }

  async function install() {
    setPhase("installing");
    setProgress(null);
    setError(null);
    try {
      await downloadAndInstallAppUpdate(setProgress);
      setPhase("ready");
    } catch (reason) {
      setPhase("available");
      setError(`Could not install the update — ${readableError(reason)}`);
    }
  }

  async function restart() {
    setError(null);
    try {
      await restartApp();
    } catch (reason) {
      setError(`Could not restart Glimmer — ${readableError(reason)}`);
    }
  }

  return (
    <section className="app-updates" aria-labelledby="app-updates-title">
      <div className="app-updates__title-row">
        <div>
          <h2 id="app-updates-title">App updates</h2>
          <p>
            {supported
              ? `Installed version: ${currentVersion ?? "checking…"}`
              : "Update checks are available in the installed Glimmer desktop app."}
          </p>
        </div>
        <button
          type="button"
          onClick={checkNow}
          disabled={!supported || phase === "checking" || phase === "installing"}
        >
          {phase === "checking" ? "Checking…" : "Check for updates"}
        </button>
      </div>

      {supported && (
        <dl className="app-updates__release-info" aria-label="Release information">
          <div>
            <dt>Channel</dt>
            <dd>Stable</dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd>Apple Silicon</dd>
          </div>
          <div>
            <dt>Trust</dt>
            <dd>Signed updates</dd>
          </div>
        </dl>
      )}

      <p className="app-updates__trust">
        Updates are downloaded from the official GitHub release and must pass Glimmer's embedded
        signature verification before installation.
      </p>

      {phase === "current" && <p role="status">Glimmer is up to date.</p>}
      {error && <p role="alert">{error}</p>}

      {update && (phase === "available" || phase === "installing") && (
        <article className="app-updates__release">
          <div>
            <h3>Version {update.version} is available</h3>
            {update.date && <p>Released {new Date(update.date).toLocaleDateString()}</p>}
          </div>
          {update.notes && <p className="app-updates__notes">{update.notes}</p>}
          {phase === "installing" ? (
            <p role="status">{progressLabel(progress)}</p>
          ) : (
            <button type="button" onClick={install}>
              Download and install
            </button>
          )}
        </article>
      )}

      {phase === "ready" && (
        <div className="app-updates__ready" role="status">
          <p>Version {update?.version} is installed and ready.</p>
          <button type="button" onClick={restart}>
            Restart Glimmer
          </button>
        </div>
      )}
    </section>
  );
}
