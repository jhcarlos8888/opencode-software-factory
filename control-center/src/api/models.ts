import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ClaudeProviderId } from "./database.js";
import type { EngineId } from "./database.js";

const execFileAsync = promisify(execFile);

export interface ModelOption {
  id: string;
  label: string;
  source: "detected" | "alias";
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

    return ids.map((id) => ({
      id,
      label: id,
      source: "detected"
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo consultar el catálogo de OpenCode: ${message}`);
  }
}

export async function getClaudeModels(provider: ClaudeProviderId): Promise<ModelOption[]> {
  const aliases: ModelOption[] = [
    { id: "sonnet", label: "Sonnet (alias de Claude Code)", source: "alias" },
    { id: "opus", label: "Opus (alias de Claude Code)", source: "alias" },
    { id: "haiku", label: "Haiku (alias de Claude Code)", source: "alias" }
  ];

  // Solo se extraen identificadores de modelo y URL base. Nunca se devuelve ni registra el token.
  if (provider === "apmix") {
    try {
      const settingsPath = join(homedir(), ".claude", "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        env?: Record<string, unknown>;
      };
      const env = settings.env ?? {};
      const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "";
      const configuredModel = typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : "";
      if (baseUrl.replace(/\/$/, "") === "https://api.apmix.ai" && configuredModel &&
          /^[a-zA-Z0-9._:/-]{1,200}$/.test(configuredModel)) {
        return [
          { id: configuredModel, label: configuredModel + " · configurado en settings.json", source: "detected" },
          ...aliases.filter((item) => item.id !== configuredModel)
        ];
      }
    } catch {
      // Settings ausente o inválido: se mantienen alias sin exponer detalles locales.
    }
  }
  return aliases;
}

export async function listModels(engine: EngineId, claudeProvider: ClaudeProviderId = "apmix"): Promise<ModelOption[]> {
  return engine === "opencode" ? getOpenCodeModels() : getClaudeModels(claudeProvider);
}
