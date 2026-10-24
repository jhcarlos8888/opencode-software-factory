#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== 1. Validar configuración JSON =="
jq -e '
  .default_agent == "build"
  and .model == "mistral/codestral-2508"
' opencode.json >/dev/null
echo "PASS: configuración del repositorio válida"

echo
echo "== 2. Validar estructura de agentes y skills =="
python3 <<'PYTHON'
import json
from pathlib import Path

root = Path.cwd()
config = json.loads((root / "opencode.json").read_text(encoding="utf-8"))

required_agents = {
    "build", "architect", "implementer",
    "reviewer", "tester", "cloud-arbiter"
}

agent_dir = root / ".opencode" / "agents"
actual_agents = {p.stem for p in agent_dir.glob("*.md")}
missing_agents = required_agents - actual_agents

if missing_agents:
    raise SystemExit(f"Faltan archivos de agentes: {sorted(missing_agents)}")

for path in sorted(agent_dir.glob("*.md")):
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        raise SystemExit(f"Encabezado YAML ausente: {path}")
    try:
        closing = lines.index("---", 1)
    except ValueError:
        raise SystemExit(f"Encabezado YAML sin cierre: {path}")
    if closing == 1:
        raise SystemExit(f"Encabezado YAML vacío: {path}")

required_skills = {
    "implementation-plan", "independent-review",
    "project-discovery", "systematic-debugging",
    "test-and-repair"
}
skills_dir = root / ".opencode" / "skills"
actual_skills = {
    p.parent.name
    for p in skills_dir.glob("*/SKILL.md")
}
missing_skills = required_skills - actual_skills

if missing_skills:
    raise SystemExit(f"Faltan skills: {sorted(missing_skills)}")

snapshot = json.loads(
    (root / "config/global-inline-agents.snapshot.json")
    .read_text(encoding="utf-8")
)
if "build" not in snapshot.get("agents", {}):
    raise SystemExit("La instantánea no contiene build")

print(f"PASS: {len(actual_agents)} archivos de agentes")
print(f"PASS: {len(actual_skills)} skills locales verificadas")
print("PASS: instantánea de agentes disponible")
PYTHON

echo
echo "== 3. Verificar configuración efectiva de OpenCode =="
config_tmp="$(mktemp)"
agents_tmp="$(mktemp)"
errors_tmp="$(mktemp)"
trap 'rm -f "$config_tmp" "$agents_tmp" "$errors_tmp"' EXIT

if ! opencode debug config >"$config_tmp" 2>"$errors_tmp"; then
    cat "$errors_tmp"
    exit 1
fi

jq -e --arg cfg "$PWD/opencode.json" '
  any(.[];
    .type == "document"
    and .path == $cfg
    and .info.default_agent == "build"
    and .info.model.providerID == "mistral"
    and .info.model.model == "codestral-2508"
  )
' "$config_tmp" >/dev/null
echo "PASS: OpenCode carga la configuración del repositorio"

echo
echo "== 4. Verificar agentes efectivos =="
if ! opencode debug agents >"$agents_tmp" 2>"$errors_tmp"; then
    cat "$errors_tmp"
    exit 1
fi

jq -e '
  def has_agent($id; $mode):
    any(.[]; .id == $id and .mode == $mode);

  has_agent("build"; "primary")
  and has_agent("architect"; "all")
  and has_agent("implementer"; "all")
  and has_agent("reviewer"; "all")
  and has_agent("tester"; "all")
  and has_agent("cloud-arbiter"; "subagent")
' "$agents_tmp" >/dev/null

echo "PASS: coordinador y cinco agentes especializados reconocidos"

echo
echo "== 5. Verificación completada =="
echo "Este script no ejecuta pruebas del proyecto ni consume llamadas al modelo."
