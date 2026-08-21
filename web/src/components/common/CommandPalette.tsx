import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands, type PaletteCommand } from "../../state/paletteCommands";

export function CommandPalette({
  commands, placeholder = "Type a command…", onClose,
}: { commands: PaletteCommand[]; placeholder?: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSelected(0); }, [query]);

  function run(index: number) {
    const cmd = filtered[index];
    if (!cmd) return;
    cmd.run();
    onClose();
  }

  return (
    <div className="ide-palette-overlay" onMouseDown={onClose}>
      <div className="ide-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="ide-palette__input"
          aria-label="Command palette"
          placeholder={placeholder}
          value={query}
          data-palette-input="true"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(selected); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
        />
        <ul className="ide-palette__list" role="listbox" aria-label="Commands">
          {filtered.length === 0 && <li className="ide-palette__empty">No matches</li>}
          {filtered.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === selected}
              className={`ide-palette__option${i === selected ? " is-selected" : ""}`}
              onMouseDown={() => run(i)}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="ide-palette__option-label">{c.label}</span>
              {c.hint && <span className="ide-palette__option-hint mono">{c.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
