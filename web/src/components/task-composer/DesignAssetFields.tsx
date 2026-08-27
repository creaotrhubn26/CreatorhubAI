import { useState } from "react";
import type {
  DesignAssetAspectRatio,
  DesignAssetKind,
  DesignAssetRequest,
  DesignReferenceImage,
} from "@glimmer/shared";

function references(value: string): DesignReferenceImage[] {
  return value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((entry) => {
      const parts = entry.split("|").map((part) => part.trim());
      return parts.length > 1
        ? { label: parts.slice(0, -1).join(" | "), path: parts.at(-1)! }
        : { path: entry };
    });
}

export function DesignAssetFields({
  value,
  onChange,
}: {
  value: DesignAssetRequest[];
  onChange(value: DesignAssetRequest[]): void;
}) {
  const [kind, setKind] = useState<DesignAssetKind>("image");
  const [prompt, setPrompt] = useState("");
  const [outputPath, setOutputPath] = useState("public/generated/asset.png");
  const [aspectRatio, setAspectRatio] = useState<DesignAssetAspectRatio>("16:9");
  const [referencePaths, setReferencePaths] = useState("");
  const [allowReferenceUpload, setAllowReferenceUpload] = useState(false);

  function updateKind(next: DesignAssetKind) {
    setKind(next);
    setOutputPath(
      next === "image"
        ? "public/generated/asset.png"
        : next === "video"
          ? "public/generated/asset.mp4"
          : "public/generated/asset.svg",
    );
  }

  function add() {
    if (!prompt.trim() || !outputPath.trim()) return;
    const common = {
      id: crypto.randomUUID(),
      kind,
      prompt: prompt.trim(),
      outputPath: outputPath.trim(),
      aspectRatio,
      referenceImages: references(referencePaths),
      referenceUploadPolicy: allowReferenceUpload
        ? ("generation-model" as const)
        : ("local-only" as const),
      createdAt: new Date().toISOString(),
    };
    const request: DesignAssetRequest =
      kind === "image"
        ? { ...common, kind, size: "2K" }
        : kind === "video"
          ? { ...common, kind, resolution: "720p", durationSeconds: 4, audio: false }
          : { ...common, kind, animated: false };
    onChange([...value, request]);
    setPrompt("");
  }

  return (
    <div className="design-assets">
      <strong>Generate assets</strong>
      <small>
        Queue a real image, video, or SVG task. Glimmer reports BLOCKED instead of inventing an
        asset when no compatible generator is available.
      </small>
      <label>
        Asset kind
        <select
          value={kind}
          onChange={(event) => updateKind(event.target.value as DesignAssetKind)}
        >
          <option value="image">Image</option>
          <option value="video">Video</option>
          <option value="vector">Vector graphic (SVG)</option>
        </select>
      </label>
      <label>
        Prompt
        <textarea
          value={prompt}
          maxLength={2_000}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the asset, composition, lighting, tone, and how it should fit the product."
        />
      </label>
      <label>
        Output path
        <input
          value={outputPath}
          maxLength={4_096}
          onChange={(event) => setOutputPath(event.target.value)}
        />
      </label>
      <label>
        Aspect ratio
        <select
          value={aspectRatio}
          onChange={(event) => setAspectRatio(event.target.value as DesignAssetAspectRatio)}
        >
          {(["1:1", "16:9", "9:16", "4:3", "3:4"] as const).map((ratio) => (
            <option key={ratio} value={ratio}>
              {ratio}
            </option>
          ))}
        </select>
      </label>
      <label>
        Workspace reference images
        <textarea
          value={referencePaths}
          onChange={(event) => setReferencePaths(event.target.value)}
          placeholder={"One per line\nHero reference | design/hero-reference.png"}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={allowReferenceUpload}
          onChange={(event) => setAllowReferenceUpload(event.target.checked)}
        />
        Allow these reference-image bytes to be sent to the selected generation model
      </label>
      <button type="button" disabled={!prompt.trim() || !outputPath.trim()} onClick={add}>
        Add generation request
      </button>
      {!!value.length && (
        <ul>
          {value.map((item) => (
            <li key={item.id}>
              <span>
                {item.kind} · {item.aspectRatio} · {item.outputPath}
              </span>
              <button
                type="button"
                aria-label={`Remove asset request for ${item.outputPath}`}
                onClick={() => onChange(value.filter((candidate) => candidate.id !== item.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
