import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ModelRegistrySettings } from "./ModelRegistrySettings";
import { glimmerApi } from "../../api/client";
import type { ModelRegistry } from "@glimmer/shared";

const registry: ModelRegistry = {
  version: 1,
  models: [
    {
      id: "local",
      label: "Local",
      baseUrl: "http://127.0.0.1:8080",
      modelId: "local-model",
      hasApiKey: false,
    },
    {
      id: "frontier",
      label: "Frontier",
      baseUrl: "https://models.example.test/v1",
      modelId: "frontier-model",
      hasApiKey: true,
    },
  ],
  roles: { engineer: "local", architect: "local", consult: "local", vision: "local" },
  source: "saved",
};

afterEach(() => vi.restoreAllMocks());

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModelRegistrySettings />
    </QueryClientProvider>,
  );
}

describe("ModelRegistrySettings", () => {
  it("keeps stored keys secret and saves explicit role and key changes", async () => {
    vi.spyOn(glimmerApi, "getModelRegistry").mockResolvedValue(registry);
    const saveRegistry = vi.spyOn(glimmerApi, "saveModelRegistry").mockResolvedValue({
      ...registry,
      roles: { ...registry.roles, architect: "frontier" },
    });
    renderSettings();

    const frontier = await screen.findByRole("group", { name: "Frontier" });
    const keyInput = within(frontier).getByLabelText(/API key/i) as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    expect(keyInput.value).toBe("");
    expect(screen.queryByDisplayValue(/secret/i)).not.toBeInTheDocument();
    expect(within(frontier).getByLabelText("Registry id")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Architect model"), { target: { value: "frontier" } });
    fireEvent.change(keyInput, { target: { value: "new-private-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save model registry" }));

    await waitFor(() => expect(saveRegistry).toHaveBeenCalledTimes(1));
    expect(saveRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        roles: expect.objectContaining({ architect: "frontier" }),
        models: expect.arrayContaining([
          expect.objectContaining({ id: "frontier", apiKey: "new-private-key" }),
        ]),
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("New sessions");
    expect((within(frontier).getByLabelText(/API key/i) as HTMLInputElement).value).toBe("");
  });

  it("adds an editable registry entry without disturbing current role assignments", async () => {
    vi.spyOn(glimmerApi, "getModelRegistry").mockResolvedValue(registry);
    vi.spyOn(glimmerApi, "saveModelRegistry").mockResolvedValue(registry);
    renderSettings();

    await screen.findByRole("group", { name: "Frontier" });
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    const added = screen.getByRole("group", { name: "New model" });
    const idInput = within(added).getByLabelText("Registry id");
    expect(idInput).not.toBeDisabled();
    fireEvent.change(idInput, { target: { value: "cloud" } });
    expect(idInput).toBeInTheDocument();
    expect(idInput).toHaveValue("cloud");
    expect((screen.getByLabelText("Engineer model") as HTMLSelectElement).value).toBe("local");
  });
});
