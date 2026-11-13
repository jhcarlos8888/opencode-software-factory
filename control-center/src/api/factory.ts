import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAssignment } from "./database.js";

export interface FactoryAgent {
  id: string;
  description: string;
  mode: string;
  defaultModel: string;
}

export interface FactoryAssets {
  agents: FactoryAgent[];
  skills: string[];
  defaultModel: string;
}

export async function loadFactoryAssets(factoryRoot: string): Promise<FactoryAssets> {
  const agentDir = join(factoryRoot, ".opencode", "agents");
  const skillDir = join(factoryRoot, ".opencode", "skills");
  const [agentNames, skillNames, openCodeConfig] = await Promise.all([
    readdir(agentDir),
    readdir(skillDir, { withFileTypes: true }),
    readFile(join(factoryRoot, "opencode.json"), "utf8")
  ]);

  const agents = await Promise.all(
    agentNames
      .filter((name) => name.endsWith(".md"))
      .map(async (name): Promise<FactoryAgent> => {
        const id = name.replace(/\.md$/i, "");
        const content = await readFile(join(agentDir, name), "utf8");
        const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1] ?? "";
        const field = (key: string): string => {
          const raw = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
          return raw.replace(/^["']|["']$/g, "");
        };

        return {
          id,
          description: field("description") || "Agente de la fábrica",
          mode: field("mode") || "all",
          defaultModel: field("model") || ""
        };
      })
  );

  const skills = skillNames
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const config = JSON.parse(openCodeConfig) as { model?: string };
  return {
    agents: agents.sort((a, b) => a.id.localeCompare(b.id)),
    skills,
    defaultModel: config.model ?? ""
  };
}

export function mergeAssignments(
  agents: FactoryAgent[],
  saved: AgentAssignment[]
): AgentAssignment[] {
  const byId = new Map(saved.map((item) => [item.agentId, item]));
  return agents.map((agent) => byId.get(agent.id) ?? {
    agentId: agent.id,
    engine: "opencode",
    modelId: agent.defaultModel,
    permissionProfile: agent.mode === "primary" ? "approval-required" : "read-only",
    enabled: true
  });
}
