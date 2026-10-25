#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== 1. Validar configuración JSON =="
jq -e '
  .default_agent == "build"
  and .model == "opencode-go/mimo-v2.6-flash"
  and (has("provider") | not)
  and .compaction.auto == true
  and .compaction.keep.tokens == 15000
  and ((.compaction | has("prune")) | not)
' opencode.json >/dev/null
echo "PASS: configuración del repositorio válida"

echo
echo "== 1b. Validar modelo fijado en los agentes =="
agent_models=0
for agent_file in .opencode/agents/*.md; do
    if grep -qx 'model: opencode-go/mimo-v2.6-flash' "$agent_file"; then
        agent_models=$((agent_models + 1))
    fi
done
if [ "$agent_models" -ne 6 ]; then
    echo "ERROR: se esperaban 6 agentes con el modelo fijado; encontrados: $agent_models"
    exit 1
fi
echo "PASS: los 6 agentes fijan opencode-go/mimo-v2.6-flash"

echo
echo "== 1c. Validar newline final =="
newline_targets=()
while IFS= read -r -d '' target_file; do
    newline_targets+=("$target_file")
done < <(
    printf '%s\0' opencode.json .gitignore templates/AGENTS.md
    find .opencode/agents .opencode/commands .opencode/skills .agents/skills \
        -type f -name '*.md' -print0
)
if [ "${#newline_targets[@]}" -eq 0 ]; then
    echo "ERROR: no se encontraron archivos que comprobar"
    exit 1
fi
for target_file in "${newline_targets[@]}"; do
    if [ "$(tail -c1 "$target_file" | xxd -p)" != "0a" ]; then
        echo "ERROR: falta el newline final en $target_file"
        exit 1
    fi
done
echo "PASS: newline final correcto en ${#newline_targets[@]} archivos"

echo
echo "== 1d. Validar plantilla AGENTS.md =="
if [ ! -f templates/AGENTS.md ]; then
    echo "ERROR: falta la plantilla templates/AGENTS.md"
    exit 1
fi
if [ ! -s templates/AGENTS.md ]; then
    echo "ERROR: templates/AGENTS.md está vacío"
    exit 1
fi
if [ "$(tail -c1 templates/AGENTS.md | xxd -p)" != "0a" ]; then
    echo "ERROR: falta el newline final en templates/AGENTS.md"
    exit 1
fi
if ! grep -q "Instrucciones del proyecto" templates/AGENTS.md; then
    echo "ERROR: templates/AGENTS.md no contiene 'Instrucciones del proyecto'"
    exit 1
fi
if cmp -s templates/AGENTS.md AGENTS.md; then
    echo "ERROR: templates/AGENTS.md es idéntica al AGENTS.md de la raíz"
    exit 1
fi
echo "PASS: plantilla AGENTS.md válida y distinta del AGENTS.md de la fábrica"

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
    "test-and-repair", "metric-collector",
    "dependency-audit", "security-scan"
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
    and .info.model.providerID == "opencode-go"
    and .info.model.model == "mimo-v2.6-flash"
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
echo "== 5. Ejecutar self-test del instalador =="
selftest_out="$(mktemp)"
trap 'rm -f "$config_tmp" "$agents_tmp" "$errors_tmp" "$selftest_out"' EXIT
if ! python3 scripts/factory.py self-test >"$selftest_out" 2>&1; then
    echo "ERROR: 'python3 scripts/factory.py self-test' devolvió un código distinto de 0"
    tail -20 "$selftest_out"
    exit 1
fi
if ! grep -q "SELF-TEST COMPLETADO" "$selftest_out"; then
    echo "ERROR: la salida del self-test no contiene 'SELF-TEST COMPLETADO'"
    tail -20 "$selftest_out"
    exit 1
fi
echo "PASS: self-test del instalador completado (SELF-TEST COMPLETADO)"

echo
echo "== 6. Verificación completada =="
echo "Este script no ejecuta pruebas del proyecto ni consume llamadas al modelo."
