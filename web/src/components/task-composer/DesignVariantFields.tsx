import { useState } from "react";
import type { DesignVariantRequest } from "@glimmer/shared";

export function DesignVariantFields({
  value,
  onChange,
}: {
  value: DesignVariantRequest[];
  onChange(value: DesignVariantRequest[]): void;
}) {
  const [target, setTarget] = useState("");
  const [directions, setDirections] = useState("");
  const [count, setCount] = useState<2 | 3 | 4>(3);

  function add() {
    const normalizedDirections = directions
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (!target.trim() || !normalizedDirections.length) return;
    onChange([
      ...value,
      {
        id: crypto.randomUUID(),
        target: target.trim(),
        count,
        directions: normalizedDirections,
      },
    ]);
    setTarget("");
    setDirections("");
  }

  return (
    <div className="design-variants">
      <strong>Design variants</strong>
      <small>Ask Glimmer to implement bounded alternatives for a specific element.</small>
      <label>
        Target element
        <input
          value={target}
          maxLength={500}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="e.g. pricing card header"
        />
      </label>
      <label>
        Number of alternatives
        <select
          value={count}
          onChange={(event) => setCount(Number(event.target.value) as 2 | 3 | 4)}
        >
          <option value={2}>2</option>
          <option value={3}>3</option>
          <option value={4}>4</option>
        </select>
      </label>
      <label>
        Directions
        <textarea
          value={directions}
          onChange={(event) => setDirections(event.target.value)}
          placeholder={
            "One per line\nCompact and information-dense\nEditorial with stronger hierarchy"
          }
        />
      </label>
      <button type="button" disabled={!target.trim() || !directions.trim()} onClick={add}>
        Add variant request
      </button>
      {!!value.length && (
        <ul>
          {value.map((item) => (
            <li key={item.id}>
              <span>
                {item.target} · {item.count} variants · {item.directions.join(" / ")}
              </span>{" "}
              <button
                type="button"
                aria-label={`Remove variant request for ${item.target}`}
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
