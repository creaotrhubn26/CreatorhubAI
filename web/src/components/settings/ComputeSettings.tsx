import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ComputeBackend,
  ComputeConfigV1,
  ComputeProfileV1,
  ComputeProfileUpdateV1,
} from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

interface Draft {
  enabled: boolean;
  defaultBackend: ComputeBackend;
  activeProfileId: string;
  profiles: ComputeProfileV1[];
  apiKey: string;
  clearApiKey: boolean;
}

function draftFromConfig(config: ComputeConfigV1): Draft {
  return {
    enabled: config.enabled,
    defaultBackend: config.defaultBackend,
    activeProfileId: config.activeProfileId ?? config.profiles[0]?.id ?? "",
    profiles: config.profiles.map((profile) => ({ ...profile })),
    apiKey: "",
    clearApiKey: false,
  };
}

function profileUpdate(profile: ComputeProfileV1): ComputeProfileUpdateV1 {
  const { hasApiKey: _hasApiKey, watchdogConfigured: _watchdog, ...update } = profile;
  return update;
}

export function ComputeSettings() {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery({
    queryKey: ["compute-config"],
    queryFn: glimmerApi.getComputeConfig,
    retry: false,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (data && !draft) setDraft(draftFromConfig(data));
  }, [data, draft]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("compute configuration is not loaded");
      return glimmerApi.saveComputeConfig({
        version: 1,
        enabled: draft.enabled,
        defaultBackend: draft.defaultBackend,
        activeProfileId: draft.activeProfileId,
        profiles: draft.profiles.map(profileUpdate),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(draft.clearApiKey ? { clearApiKey: true } : {}),
      });
    },
    onSuccess: (config) => {
      queryClient.setQueryData(["compute-config"], config);
      void queryClient.invalidateQueries({ queryKey: ["compute-status"] });
      setDraft(draftFromConfig(config));
    },
  });
  const testCredential = useMutation({ mutationFn: glimmerApi.testComputeCredential });

  function updateProfile(patch: Partial<ComputeProfileV1>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            profiles: current.profiles.map((profile) =>
              profile.id === current.activeProfileId ? { ...profile, ...patch } : profile,
            ),
          }
        : current,
    );
  }

  if (isPending) return <p>Loading compute settings…</p>;
  if (error || !draft) {
    return (
      <p role="alert">
        Could not load compute settings — {(error as Error)?.message ?? "unavailable"}
      </p>
    );
  }
  const active = draft.profiles.find((profile) => profile.id === draft.activeProfileId);
  if (!active) return <p role="alert">The active compute profile is missing.</p>;
  const hasApiKey = active.hasApiKey && !draft.clearApiKey;
  const artifacts = active.modelArtifacts ?? {
    model: { url: "", sha256: "" },
    mmproj: { url: "", sha256: "" },
    draftModel: { url: "", sha256: "" },
    allowedHosts: [],
  };
  function updateArtifact(
    kind: "model" | "mmproj" | "draftModel",
    field: "url" | "sha256",
    value: string,
  ) {
    updateProfile({
      modelArtifacts: {
        ...artifacts,
        [kind]: { ...artifacts[kind], [field]: value },
      },
    });
  }

  return (
    <section aria-labelledby="compute-settings-heading">
      <h2
        id="compute-settings-heading"
        style={{
          fontSize: "var(--fs-h1)",
          fontWeight: 600,
          textTransform: "none",
          letterSpacing: "-0.01em",
          color: "inherit",
        }}
      >
        External compute
      </h2>
      <p>
        RunPod is additive and disabled by default. Credentials remain in a private gateway-owned
        file and are never returned to this screen.
      </p>
      <p role="note">
        R1 has local idle and hard-deadline cleanup, but no independently deployed watchdog yet. Do
        not leave paid compute unattended.
      </p>
      <p className="mono" style={{ fontSize: 12 }}>
        Configuration: {data?.source === "saved" ? "saved" : "local default"}
      </p>

      <fieldset>
        <legend>Execution policy</legend>
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, enabled: event.target.checked } : current,
              )
            }
          />{" "}
          Enable external compute configuration
        </label>
        <label>
          Default backend
          <select
            value={draft.defaultBackend}
            onChange={(event) =>
              setDraft((current) =>
                current
                  ? { ...current, defaultBackend: event.target.value as ComputeBackend }
                  : current,
              )
            }
          >
            <option value="local_process">Local process</option>
            <option value="runpod_pod">RunPod Pod</option>
          </select>
        </label>
        <label>
          Active profile
          <select
            value={draft.activeProfileId}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, activeProfileId: event.target.value } : current,
              )
            }
          >
            {draft.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset>
        <legend>{active.label}</legend>
        <p>
          Secure Cloud · one GPU ·{" "}
          {active.performance === "economy" ? "A100 economy" : "H100 latency"}
        </p>
        <p className="mono">{active.gpuTypeIds.join(" → ")}</p>
        <label>
          Context tokens
          <select
            value={active.contextTokens}
            onChange={(event) =>
              updateProfile({ contextTokens: Number(event.target.value) as 65_536 | 131_072 })
            }
          >
            <option value={65_536}>65,536</option>
            <option value={131_072}>131,072</option>
          </select>
        </label>
        <label>
          Worker image digest
          <input
            value={active.imageDigest}
            onChange={(event) => updateProfile({ imageDigest: event.target.value })}
            placeholder="registry/repository@sha256:…"
            spellCheck={false}
          />
          <small>Mutable image tags are rejected.</small>
        </label>
        <label>
          Existing network volume id
          <input
            value={active.networkVolumeId ?? ""}
            onChange={(event) => updateProfile({ networkVolumeId: event.target.value })}
            placeholder="RunPod network volume id"
            spellCheck={false}
          />
        </label>
        <fieldset>
          <legend>Checksum-bound model artifacts</legend>
          <p>
            Model files remain on the network volume. The worker accepts only HTTPS hosts listed
            here and verifies every SHA-256 before becoming ready.
          </p>
          <label>
            Allowed download hosts
            <input
              value={artifacts.allowedHosts.join(", ")}
              onChange={(event) =>
                updateProfile({
                  modelArtifacts: {
                    ...artifacts,
                    allowedHosts: event.target.value
                      .split(",")
                      .map((host) => host.trim().toLowerCase())
                      .filter(Boolean),
                  },
                })
              }
              placeholder="huggingface.co, cdn-lfs.huggingface.co"
              spellCheck={false}
            />
          </label>
          {(
            [
              ["model", "Main model"],
              ["mmproj", "Vision projector"],
              ["draftModel", "Draft model"],
            ] as const
          ).map(([kind, label]) => (
            <div key={kind}>
              <label>
                {label} HTTPS URL
                <input
                  value={artifacts[kind].url}
                  onChange={(event) => updateArtifact(kind, "url", event.target.value)}
                  spellCheck={false}
                />
              </label>
              <label>
                {label} SHA-256
                <input
                  value={artifacts[kind].sha256}
                  onChange={(event) => updateArtifact(kind, "sha256", event.target.value)}
                  placeholder="64 lowercase hexadecimal characters"
                  spellCheck={false}
                />
              </label>
            </div>
          ))}
        </fieldset>
        <label>
          Maximum GPU rate (USD/hour)
          <input
            type="number"
            min="0.1"
            max="100"
            step="0.01"
            value={active.maxGpuHourlyUsd}
            onChange={(event) => updateProfile({ maxGpuHourlyUsd: Number(event.target.value) })}
          />
        </label>
        <label>
          Idle cleanup (seconds)
          <input
            type="number"
            min="60"
            max="3600"
            value={active.idleTimeoutSeconds}
            onChange={(event) => updateProfile({ idleTimeoutSeconds: Number(event.target.value) })}
          />
        </label>
        <label>
          Clarification cleanup (seconds)
          <input
            type="number"
            min="60"
            max="900"
            value={active.clarificationTimeoutSeconds}
            onChange={(event) =>
              updateProfile({ clarificationTimeoutSeconds: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Hard session limit (seconds)
          <input
            type="number"
            min="600"
            max="86400"
            value={active.hardSessionLimitSeconds}
            onChange={(event) =>
              updateProfile({ hardSessionLimitSeconds: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Daily budget (USD)
          <input
            type="number"
            min="1"
            step="0.01"
            value={active.dailyBudgetUsd ?? ""}
            onChange={(event) =>
              updateProfile({
                dailyBudgetUsd: event.target.value ? Number(event.target.value) : undefined,
              })
            }
          />
        </label>
        <label>
          Monthly budget (USD)
          <input
            type="number"
            min="1"
            step="0.01"
            value={active.monthlyBudgetUsd ?? ""}
            onChange={(event) =>
              updateProfile({
                monthlyBudgetUsd: event.target.value ? Number(event.target.value) : undefined,
              })
            }
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>RunPod credential</legend>
        <label>
          API key {hasApiKey ? "(stored; blank keeps it)" : "(required before enabling RunPod)"}
          <input
            type="password"
            autoComplete="new-password"
            value={draft.apiKey}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, apiKey: event.target.value, clearApiKey: false } : current,
              )
            }
            placeholder={hasApiKey ? "Keep existing key" : "RunPod API key"}
          />
        </label>
        {active.hasApiKey && (
          <label>
            <input
              type="checkbox"
              checked={draft.clearApiKey}
              onChange={(event) =>
                setDraft((current) =>
                  current ? { ...current, clearApiKey: event.target.checked, apiKey: "" } : current,
                )
              }
            />{" "}
            Remove stored key on save
          </label>
        )}
      </fieldset>

      <button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save compute settings"}
      </button>
      <button
        type="button"
        onClick={() => testCredential.mutate()}
        disabled={testCredential.isPending || !active.hasApiKey}
      >
        {testCredential.isPending ? "Testing…" : "Test stored credential"}
      </button>
      {save.isSuccess && <p role="status">Compute settings saved.</p>}
      {save.error && <p role="alert">Could not save — {(save.error as Error).message}</p>}
      {testCredential.data && (
        <p role="status">
          Credential accepted; {testCredential.data.visiblePodCount} Pod(s) visible. No resource was
          created.
        </p>
      )}
      {testCredential.error && (
        <p role="alert">Credential test failed — {(testCredential.error as Error).message}</p>
      )}
    </section>
  );
}
