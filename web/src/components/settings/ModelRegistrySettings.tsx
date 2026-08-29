import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdaptiveRoutingConfig,
  ModelRegistry,
  ModelRegistryUpdateEntry,
  ModelRole,
} from "@glimmer/shared";
import { glimmerApi } from "../../api/client";

const ROLES: Array<{ id: ModelRole; label: string; note: string }> = [
  { id: "engineer", label: "Engineer", note: "Implementation and delivery review" },
  { id: "architect", label: "Architect", note: "Planning and architecture review" },
  { id: "consult", label: "Consult", note: "Read-only escalation calls" },
  { id: "vision", label: "Vision", note: "Screenshot verification" },
];

type DraftModel = ModelRegistryUpdateEntry & {
  hasApiKey: boolean;
  apiKey: string;
  clearApiKey: boolean;
  persisted: boolean;
  draftKey: string;
};
type Draft = {
  models: DraftModel[];
  roles: ModelRegistry["roles"];
  routing: AdaptiveRoutingConfig;
};

function draftFromRegistry(registry: ModelRegistry): Draft {
  return {
    models: registry.models.map((model) => ({
      ...model,
      apiKey: "",
      clearApiKey: false,
      persisted: true,
      draftKey: `saved:${model.id}`,
    })),
    roles: { ...registry.roles },
    routing: registry.routing ?? {
      enabled: false,
      highRisk: {},
      criticProviderId: null,
      requireIndependentCritic: false,
    },
  };
}

function nextModelId(models: DraftModel[]): string {
  let n = models.length + 1;
  while (models.some((model) => model.id === `model-${n}`)) n += 1;
  return `model-${n}`;
}

export function ModelRegistrySettings() {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery({
    queryKey: ["model-registry"],
    queryFn: glimmerApi.getModelRegistry,
    retry: false,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (data && !draft) setDraft(draftFromRegistry(data));
  }, [data, draft]);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("model registry is not loaded");
      return glimmerApi.saveModelRegistry({
        models: draft.models.map(
          ({
            hasApiKey: _has,
            persisted: _persisted,
            draftKey: _draftKey,
            apiKey,
            clearApiKey,
            ...model
          }) => ({
            ...model,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            ...(clearApiKey ? { clearApiKey: true } : {}),
          }),
        ),
        roles: draft.roles,
        routing: draft.routing,
      });
    },
    onSuccess: (registry) => {
      queryClient.setQueryData(["model-registry"], registry);
      setDraft(draftFromRegistry(registry));
    },
  });

  function updateModel(index: number, patch: Partial<DraftModel>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            models: current.models.map((model, i) =>
              i === index ? { ...model, ...patch } : model,
            ),
          }
        : current,
    );
  }

  function addModel() {
    setDraft((current) => {
      if (!current) return current;
      const id = nextModelId(current.models);
      return {
        ...current,
        models: [
          ...current.models,
          {
            id,
            label: "New model",
            baseUrl: "https://",
            modelId: "",
            hasApiKey: false,
            apiKey: "",
            clearApiKey: false,
            persisted: false,
            draftKey: `new:${id}`,
          },
        ],
      };
    });
  }

  function removeModel(draftKey: string) {
    setDraft((current) => {
      if (!current || current.models.length === 1) return current;
      const removed = current.models.find((model) => model.draftKey === draftKey);
      if (!removed) return current;
      const models = current.models.filter((model) => model.draftKey !== draftKey);
      const fallback = models[0].id;
      const roles = { ...current.roles };
      const highRisk = { ...current.routing.highRisk };
      if (!models.some((model) => model.id === removed.id)) {
        for (const role of ROLES) {
          if (roles[role.id] === removed.id) roles[role.id] = fallback;
          if (highRisk[role.id] === removed.id) delete highRisk[role.id];
        }
      }
      return {
        models,
        roles,
        routing: {
          ...current.routing,
          highRisk,
          criticProviderId:
            current.routing.criticProviderId === removed.id
              ? null
              : current.routing.criticProviderId,
        },
      };
    });
  }

  if (isPending) return <p>Loading model registry…</p>;
  if (error || !draft)
    return (
      <p role="alert">
        Could not load model registry — {(error as Error)?.message ?? "unavailable"}
      </p>
    );

  return (
    <section aria-labelledby="model-registry-heading">
      <h2
        id="model-registry-heading"
        style={{
          fontSize: "var(--fs-h1)",
          fontWeight: 600,
          textTransform: "none",
          letterSpacing: "-0.01em",
          color: "inherit",
        }}
      >
        Model registry
      </h2>
      <p>
        Role routing is read when a new Glimmer process starts. API keys are stored in separate
        local files; existing values are never returned to this screen.
      </p>
      <p className="mono" style={{ fontSize: 12 }}>
        Configuration: {data?.source === "saved" ? "saved registry" : "local default"}
      </p>

      <div className="model-registry__models">
        {draft.models.map((model, index) => (
          <fieldset key={model.draftKey}>
            <legend>{model.label || model.id}</legend>
            <label>
              Registry id
              <input
                value={model.id}
                disabled={model.persisted}
                title={model.persisted ? "Registry ids cannot be renamed after saving" : undefined}
                onChange={(event) => updateModel(index, { id: event.target.value })}
              />
            </label>
            <label>
              Label
              <input
                value={model.label}
                onChange={(event) => updateModel(index, { label: event.target.value })}
              />
            </label>
            <label>
              Base URL
              <input
                value={model.baseUrl}
                onChange={(event) => updateModel(index, { baseUrl: event.target.value })}
              />
              <small>Use the provider origin or its OpenAI-compatible /v1 base.</small>
            </label>
            <label>
              Model id
              <input
                value={model.modelId}
                onChange={(event) => updateModel(index, { modelId: event.target.value })}
              />
            </label>
            <label>
              API key{" "}
              {model.hasApiKey && !model.clearApiKey ? "(stored; blank keeps it)" : "(optional)"}
              <input
                type="password"
                autoComplete="new-password"
                value={model.apiKey}
                onChange={(event) =>
                  updateModel(index, { apiKey: event.target.value, clearApiKey: false })
                }
                placeholder={model.hasApiKey ? "Keep existing key" : "No key"}
              />
            </label>
            {model.hasApiKey && (
              <label>
                <input
                  type="checkbox"
                  checked={model.clearApiKey}
                  onChange={(event) =>
                    updateModel(index, { clearApiKey: event.target.checked, apiKey: "" })
                  }
                />{" "}
                Remove stored key on save
              </label>
            )}
            <button
              type="button"
              onClick={() => removeModel(model.draftKey)}
              disabled={draft.models.length === 1}
            >
              Remove model
            </button>
          </fieldset>
        ))}
      </div>
      <button type="button" onClick={addModel}>
        Add model
      </button>

      <fieldset>
        <legend>Role assignments</legend>
        {ROLES.map((role) => (
          <label key={role.id}>
            {role.label} — {role.note}
            <select
              aria-label={`${role.label} model`}
              value={draft.roles[role.id]}
              onChange={(event) =>
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        roles: { ...current.roles, [role.id]: event.target.value },
                      }
                    : current,
                )
              }
            >
              {draft.models.map((model) => (
                <option key={model.draftKey} value={model.id}>
                  {model.label || model.id}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Adaptive routing</legend>
        <label>
          <input
            type="checkbox"
            checked={draft.routing.enabled}
            onChange={(event) =>
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      routing: { ...current.routing, enabled: event.target.checked },
                    }
                  : current,
              )
            }
          />{" "}
          Use configured high-risk overrides
        </label>
        {ROLES.map((role) => (
          <label key={`high-risk-${role.id}`}>
            {role.label} for HIGH/CRITICAL tasks
            <select
              aria-label={`${role.label} high-risk model`}
              value={draft.routing.highRisk[role.id] ?? ""}
              onChange={(event) =>
                setDraft((current) => {
                  if (!current) return current;
                  const highRisk = { ...current.routing.highRisk };
                  if (event.target.value) highRisk[role.id] = event.target.value;
                  else delete highRisk[role.id];
                  return { ...current, routing: { ...current.routing, highRisk } };
                })
              }
            >
              <option value="">Use normal role assignment</option>
              {draft.models.map((model) => (
                <option key={model.draftKey} value={model.id}>
                  {model.label || model.id}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          Critic model
          <select
            aria-label="Critic model"
            value={draft.routing.criticProviderId ?? ""}
            onChange={(event) =>
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      routing: {
                        ...current.routing,
                        criticProviderId: event.target.value || null,
                      },
                    }
                  : current,
              )
            }
          >
            <option value="">Use Consult role</option>
            {draft.models.map((model) => (
              <option key={model.draftKey} value={model.id}>
                {model.label || model.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.routing.requireIndependentCritic}
            onChange={(event) =>
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      routing: {
                        ...current.routing,
                        requireIndependentCritic: event.target.checked,
                      },
                    }
                  : current,
              )
            }
          />{" "}
          Require a different provider/model identity for critic acceptance
        </label>
        <small>
          Repository evidence is supplied only to a loopback critic endpoint. Remote critics are
          reported as unavailable.
        </small>
      </fieldset>

      <button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save model registry"}
      </button>
      {save.isSuccess && (
        <p role="status">Model registry saved. New sessions will use these assignments.</p>
      )}
      {save.error && (
        <p role="alert">Could not save model registry — {(save.error as Error).message}</p>
      )}
    </section>
  );
}
