import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ClaudeProviderId } from "./database.js";
import type { EngineId } from "./database.js";

const execFileAsync = promisify(execFile);
export const OPEN_CODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/inference/go/anthropic";
const OPEN_CODE_GO_LEGACY_BASE_URLS = new Set([
  "https://opencode.ai/zen/go",
  "https://opencode.ai/zen/go/anthropic"
]);

export interface ModelOption {
  id: string;
  label: string;
  source: "detected" | "alias";
}

export interface ClaudeLocalConfig {
  provider: ClaudeProviderId;
  baseUrl: string;
  model: string;
  hasCredential: boolean;
  endpointCompatible: boolean;
  env: Record<string, string>;
}

function normalizeClaudeModel(value: string, provider?: ClaudeProviderId): string {
  const model = value.trim();
  const providerPrefix = provider ? provider + "/" : "";
  if (providerPrefix && model.startsWith(providerPrefix)) {
    return model.slice(providerPrefix.length);
  }
  return model.startsWith("opencode-go/") ? model.slice("opencode-go/".length) : model;
}

export async function readClaudeLocalConfig(): Promise<ClaudeLocalConfig> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
    env?: Record<string, unknown>;
  };
  const rawEnv = settings.env ?? {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if ((key.startsWith("ANTHROPIC_") || key === "CLAUDE_CODE_SUBAGENT_MODEL") &&
        typeof value === "string") env[key] = value;
  }

  const baseUrl = String(env.ANTHROPIC_BASE_URL ?? "").replace(/\/$/, "");
  const configuredModel = String(
    env.ANTHROPIC_MODEL ??
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
    env.CLAUDE_CODE_SUBAGENT_MODEL ??
    ""
  );
  const model = normalizeClaudeModel(configuredModel);
  const isOpenCodeGo = baseUrl === OPEN_CODE_GO_ANTHROPIC_BASE_URL ||
    OPEN_CODE_GO_LEGACY_BASE_URLS.has(baseUrl);
  const provider: ClaudeProviderId = isOpenCodeGo
    ? "opencode-go"
    : baseUrl === "https://api.apmix.ai"
      ? "apmix"
      : "anthropic";

  return {
    provider,
    baseUrl,
    model,
    hasCredential: Boolean(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY),
    endpointCompatible: provider !== "opencode-go" || baseUrl === OPEN_CODE_GO_ANTHROPIC_BASE_URL,
    env
  };
}

export async function getDetectedClaudeProvider(fallback: ClaudeProviderId): Promise<ClaudeProviderId> {
  try {
    return (await readClaudeLocalConfig()).provider;
  } catch {
    return fallback;
  }
}

function executable(name: EngineId): string {
  if (name === "opencode") {
    const localBinary = join(homedir(), ".opencode", "bin", "opencode");
    return process.env.OPENCODE_BIN || localBinary;
  }
  return process.env.CLAUDE_BIN || "claude";
}

export async function getEngineVersion(engine: EngineId): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable(engine), ["--version"], {
      timeout: 8000,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim().split(/\r?\n/)[0] || "Instalado";
  } catch {
    return null;
  }
}

export async function getOpenCodeModels(): Promise<ModelOption[]> {
  try {
    const { stdout } = await execFileAsync(executable("opencode"), ["models"], {
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024
    });
    const ids = [...new Set(
      stdout.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[a-zA-Z0-9._-]+\/.+/.test(line))
    )];
    return ids.map((id) => ({ id, label: id, source: "detected" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo consultar el catálogo de OpenCode: ${message}`);
  }
}

const CLAUDE_MODEL_ALIASES: ModelOption[] = [
  { id: "sonnet", label: "Sonnet (alias de Claude Code)", source: "alias" },
  { id: "opus", label: "Opus (alias de Claude Code)", source: "alias" },
  { id: "haiku", label: "Haiku (alias de Claude Code)", source: "alias" }
];

/**
 * Adapt the active provider's connected OpenCode catalog to the bare model IDs
 * expected by Claude Code's ANTHROPIC_MODEL / SDK model option.
 *
 * Only models under the provider detected in ~/.claude/settings.json are
 * admitted. This does not mix models from unrelated OpenCode providers.
 */
export function buildClaudeConnectorModelCatalog(
  provider: ClaudeProviderId,
  connectedModels: ModelOption[],
  configuredModel: string
): ModelOption[] {
  const providerPrefix = provider + "/";
  const providerName = provider === "opencode-go" ? "OpenCode Go"
    : provider === "apmix" ? "APMix"
      : "Anthropic";
  const normalizedConfigured = normalizeClaudeModel(configuredModel, provider);
  const options: ModelOption[] = [];
  const seen = new Set<string>();

  const add = (option: ModelOption) => {
    if (!option.id || option.id.length > 200 ||
        !/^[a-zA-Z0-9._:-]{1,200}$/.test(option.id) || seen.has(option.id)) return;
    seen.add(option.id);
    options.push(option);
  };

  if (normalizedConfigured) {
    add({
      id: normalizedConfigured,
      label: normalizedConfigured + " · configurado en settings.json",
      source: "detected"
    });
  }

  for (const model of connectedModels) {
    if (!model.id.startsWith(providerPrefix)) continue;
    const id = model.id.slice(providerPrefix.length);
    add({
      id,
      label: id + " · catálogo " + providerName,
      source: "detected"
    });
  }

  for (const alias of CLAUDE_MODEL_ALIASES) add(alias);
  return options;
}

export async function getClaudeModels(provider: ClaudeProviderId): Promise<ModelOption[]> {
  try {
    const config = await readClaudeLocalConfig();
    if (config.provider !== provider) return [...CLAUDE_MODEL_ALIASES];

    // OpenCode's model registry is the connected catalog for providers shared
    // with Claude Code (notably OpenCode Go's Anthropic-compatible endpoint).
    // If the catalog is unavailable, retain the configured model and aliases.
    const connectedModels = await getOpenCodeModels().catch(() => []);
    return buildClaudeConnectorModelCatalog(provider, connectedModels, config.model);
  } catch {
    // Configuración local ausente o inválida: no se exponen detalles ni credenciales.
    return [...CLAUDE_MODEL_ALIASES];
  }
}

export async function listModels(engine: EngineId, claudeProvider: ClaudeProviderId = "apmix"): Promise<ModelOption[]> {
  return engine === "opencode" ? getOpenCodeModels() : getClaudeModels(claudeProvider);
}
