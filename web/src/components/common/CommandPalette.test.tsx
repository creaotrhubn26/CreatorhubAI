import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import type { PaletteCommand } from "../../state/paletteCommands";

function commands(overrides: Partial<Record<string, () => void>> = {}): PaletteCommand[] {
  return [
    { id: "a", label: "Go to Dashboard", run: overrides.a ?? vi.fn() },
    { id: "b", label: "Go to Settings", run: overrides.b ?? vi.fn() },
    { id: "c", label: "New Task", run: overrides.c ?? vi.fn() },
  ];
}

describe("CommandPalette", () => {
  it("renders every command and exposes the required a11y roles", () => {
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
  });

  it("filters the list as the user types", () => {
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Command palette" }), { target: { value: "dash" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
  });

  it("runs the selected command and closes on Enter", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands({ a: run })} onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Command palette" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("moves selection with arrow keys before running on Enter", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands({ b: run })} onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Command palette" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalled();
  });

  it("runs a command on mouse click", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands({ c: run })} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("New Task"));
    expect(run).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape without running anything", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands({ a: run })} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Command palette" }), { key: "Escape" });
    expect(run).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on an overlay click but not on a click inside the card", () => {
    const onClose = vi.fn();
    const { container } = render(<CommandPalette commands={commands()} onClose={onClose} />);
    fireEvent.mouseDown(container.querySelector(".ide-palette")!);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector(".ide-palette-overlay")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("restores focus to whatever was focused before it opened, on unmount", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(<CommandPalette commands={commands()} onClose={vi.fn()} />);
    expect(document.activeElement).toHaveAttribute("aria-label", "Command palette");

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("traps Tab inside the palette instead of letting focus leave", () => {
    render(<CommandPalette commands={commands()} onClose={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Command palette" });
    const notCanceled = fireEvent.keyDown(input, { key: "Tab" });
    expect(notCanceled).toBe(false); // false means preventDefault() was called
  });

  it("clamps the highlighted index when filtering shrinks the list below it", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands({ c: run })} onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Command palette" });
    // highlight the 3rd row ("New Task")
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // filter down to just one match, which used to leave the highlight
    // pointing past the end of the list
    fireEvent.change(input, { target: { value: "New Task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalled();
  });
});
