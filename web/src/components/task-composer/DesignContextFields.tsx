import type { DesignContextStrategy, DesignTaskKind } from "@glimmer/shared";
import type { TaskComposerFormState } from "../../state/buildTaskContract";
import { designComposerError } from "../../state/designContract";
import { MobbinInspirationPicker } from "./MobbinInspirationPicker";
import { DesignVariantFields } from "./DesignVariantFields";
import { DesignAssetFields } from "./DesignAssetFields";

interface Props {
  form: TaskComposerFormState;
  setForm(form: TaskComposerFormState): void;
}

const STRATEGIES: Array<{ value: DesignContextStrategy; label: string }> = [
  { value: "detect", label: "Detect and reuse" },
  { value: "existing", label: "Existing system required" },
  { value: "required", label: "Introduce if missing" },
  { value: "none", label: "Not applicable" },
];

function StrategySelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: DesignContextStrategy;
  onChange(value: DesignContextStrategy): void;
}) {
  return (
    <label>
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as DesignContextStrategy)}
      >
        {STRATEGIES.map((strategy) => (
          <option key={strategy.value} value={strategy.value}>
            {strategy.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DesignContextFields({ form, setForm }: Props) {
  const error = designComposerError(form);
  return (
    <fieldset className="composer__design-context">
      <legend>Design, UX, CMS &amp; tokens</legend>
      <label>
        <input
          type="checkbox"
          checked={form.designEnabled}
          onChange={(event) => setForm({ ...form, designEnabled: event.target.checked })}
        />
        Enable design-aware implementation
      </label>
      {!form.designEnabled ? (
        <small>Adds a read-only UX planning pass and structured design evidence.</small>
      ) : (
        <>
          <label>
            Design task
            <select
              value={form.designKind}
              onChange={(event) =>
                setForm({ ...form, designKind: event.target.value as DesignTaskKind })
              }
            >
              <option value="build">Build from design</option>
              <option value="improve">Improve existing UX</option>
              <option value="audit">Audit design and UX</option>
              <option value="reference-match">Match a reference</option>
            </select>
          </label>
          <label>
            Local preview URL
            <input
              type="url"
              value={form.designTargetUrl}
              onChange={(event) => setForm({ ...form, designTargetUrl: event.target.value })}
              placeholder="http://localhost:5173/settings"
            />
            <small>When present, visual verification runs automatically.</small>
          </label>
          <label>
            Audience
            <input
              value={form.designAudience}
              onChange={(event) => setForm({ ...form, designAudience: event.target.value })}
              placeholder="e.g. first-time content editors"
            />
          </label>
          <label>
            Primary action
            <input
              value={form.designPrimaryAction}
              onChange={(event) => setForm({ ...form, designPrimaryAction: event.target.value })}
              placeholder="e.g. publish a page safely"
            />
          </label>
          <label>
            UX and visual requirements
            <textarea
              value={form.designRequirements}
              onChange={(event) => setForm({ ...form, designRequirements: event.target.value })}
              placeholder={
                "One requirement per line\nPrimary action remains visible\nErrors explain recovery"
              }
            />
          </label>
          <label>
            Reference images
            <textarea
              value={form.designReferenceImages}
              onChange={(event) => setForm({ ...form, designReferenceImages: event.target.value })}
              placeholder={
                "Workspace-relative, one per line\nSettings reference | design/settings.png"
              }
            />
          </label>
          <MobbinInspirationPicker
            value={form.designInspirations}
            onChange={(designInspirations) => setForm({ ...form, designInspirations })}
          />
          <DesignVariantFields
            value={form.designVariants}
            onChange={(designVariants) => setForm({ ...form, designVariants })}
          />
          {!!form.designElementEdits.length && (
            <div className="design-element-edits-summary">
              <strong>Visual element edits</strong>
              <small>{form.designElementEdits.length} edit(s) imported from visual feedback.</small>
              <ul>
                {form.designElementEdits.map((edit) => (
                  <li key={edit.id}>
                    <span>{edit.target}</span>
                    <button
                      type="button"
                      aria-label={`Remove visual edit for ${edit.target}`}
                      onClick={() =>
                        setForm({
                          ...form,
                          designElementEdits: form.designElementEdits.filter(
                            (candidate) => candidate.id !== edit.id,
                          ),
                        })
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DesignAssetFields
            value={form.designAssetRequests}
            onChange={(designAssetRequests) => setForm({ ...form, designAssetRequests })}
          />
          <label>
            <input
              type="checkbox"
              checked={form.allowReferenceImageModelUpload}
              onChange={(event) =>
                setForm({ ...form, allowReferenceImageModelUpload: event.target.checked })
              }
            />
            Send reference images to the configured Vision model for comparison
            <small>
              Off by default. When enabled, image bytes are sent to the Vision endpoint selected in
              Model Registry; the session records the consent, files, and model ID.
            </small>
          </label>
          <label>
            Interaction states
            <textarea
              value={form.designStates}
              onChange={(event) => setForm({ ...form, designStates: event.target.value })}
              placeholder={
                "One action per line\ndialog-open | click | [aria-label='Open settings'] | dialog is visible\nsettled | wait | 300 | loading is complete"
              }
            />
          </label>
          <label>
            Viewports
            <input
              value={form.designViewports}
              onChange={(event) => setForm({ ...form, designViewports: event.target.value })}
            />
          </label>

          <StrategySelect
            label="CMS strategy"
            value={form.cmsStrategy}
            onChange={(cmsStrategy) => setForm({ ...form, cmsStrategy })}
          />
          <label>
            CMS/provider hint
            <input
              value={form.cmsProviderHint}
              onChange={(event) => setForm({ ...form, cmsProviderHint: event.target.value })}
              placeholder="e.g. Sanity, Contentful, Strapi, repository-backed"
            />
          </label>
          <label>
            CMS schema/content paths
            <textarea
              value={form.cmsSchemaPaths}
              onChange={(event) => setForm({ ...form, cmsSchemaPaths: event.target.value })}
              placeholder="cms/schema, src/content/types.ts"
            />
          </label>
          <label>
            CMS/content requirements
            <textarea
              value={form.cmsRequirements}
              onChange={(event) => setForm({ ...form, cmsRequirements: event.target.value })}
              placeholder={
                "One per line\nEditors can change hero copy without code changes\nEmpty content has a designed fallback"
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.cmsLocalizationRequired}
              onChange={(event) =>
                setForm({ ...form, cmsLocalizationRequired: event.target.checked })
              }
            />
            Localization and long-content resilience required
          </label>

          <StrategySelect
            label="Design token strategy"
            value={form.designTokenStrategy}
            onChange={(designTokenStrategy) => setForm({ ...form, designTokenStrategy })}
          />
          <label>
            Token source paths
            <textarea
              value={form.designTokenSourcePaths}
              onChange={(event) => setForm({ ...form, designTokenSourcePaths: event.target.value })}
              placeholder="src/theme.css, tokens/design-tokens.json"
            />
          </label>
          <label>
            Token requirements
            <textarea
              value={form.designTokenRequirements}
              onChange={(event) =>
                setForm({ ...form, designTokenRequirements: event.target.value })
              }
              placeholder={
                "One per line\nUse semantic spacing and color tokens\nPreserve dark-mode mappings"
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.allowNewDesignTokens}
              onChange={(event) => setForm({ ...form, allowNewDesignTokens: event.target.checked })}
            />
            Allow new design tokens when existing tokens cannot express the design
          </label>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </fieldset>
  );
}
