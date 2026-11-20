export interface CatalogModel {
  id: string;
  label: string;
}

export type ModelProviderOption = { id: string; count: number; label: string };

const NAMES: Record<string, string> = {
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode",
  lmstudio: "LM Studio",
  nvidia: "NVIDIA",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  google: "Google"
};

/** OpenCode model IDs have a provider prefix; Claude's SDK uses bare IDs. */
export function openCodeModelProvider(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : "";
}

export function catalogProviderOptions(models: readonly CatalogModel[]): ModelProviderOption[] {
  const counts = new Map<string, number>();
  for (const model of models) {
    const provider = openCodeModelProvider(model.id);
    if (provider) counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  const options = [...counts.entries()].map(([id, count]) => ({
    id, count, label: NAMES[id] ?? id
  }));
  return options.sort((a, b) =>
    (a.id === "opencode-go" ? -1 : b.id === "opencode-go" ? 1 : a.label.localeCompare(b.label))
  );
}

export function modelsForOpenCodeProvider<T extends CatalogModel>(
  models: readonly T[], provider: string
): T[] {
  return provider === "all"
    ? [...models]
    : models.filter((model) => openCodeModelProvider(model.id) === provider);
}

export function preferredOpenCodeProvider(models: readonly CatalogModel[], requested = "opencode-go"): string {
  return catalogProviderOptions(models).some((item) => item.id === requested) ? requested : "all";
}
