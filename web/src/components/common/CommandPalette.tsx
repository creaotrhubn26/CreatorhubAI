import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands, type PaletteCommand } from "../../state/paletteCommands";

export function CommandPalette({
  commands, placeholder = "Type a command…", onClose,
}: { commands: PaletteCommand[]; placeholder?: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Focus the input on open, restore whatever had focus before on close —
  // the palette is the only focusable element inside it (Tab is trapped
  // below), so there's nowhere else focus could meaningfully land.
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, []);

  // Clamp rather than reset-to-0 on every keystroke: keeps the highlight
  // stable while the list is merely re-filtered, only snapping it back
  // when a shrinking list would otherwise leave it pointing past the end.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(filtered.length - 1, 0)));
  }, [filtered.length]);

  function run(index: number) {
    const cmd = filtered[index];
    if (!cmd) return;
    cmd.run();
    onClose();
  }

  const selectedId = filtered[selected] ? `palette-opt-${filtered[selected].id}` : undefined;

  return (
    <div className="ide-palette-overlay" onMouseDown={onClose}>
      <div className="ide-palette" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="ide-palette__input"
          role="combobox"
          aria-label="Command palette"
          aria-controls="ide-palette-listbox"
          aria-expanded="true"
          aria-activedescendant={selectedId}
          placeholder={placeholder}
          value={query}
          data-palette-input="true"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); run(selected); }
            else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            else if (e.key === "Tab") { e.preventDefault(); }
          }}
        />
        <ul id="ide-palette-listbox" className="ide-palette__list" role="listbox" aria-label="Commands">
          {filtered.length === 0 && <li className="ide-palette__empty">No matches</li>}
          {filtered.map((c, i) => (
            <li
              key={c.id}
              id={`palette-opt-${c.id}`}
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
