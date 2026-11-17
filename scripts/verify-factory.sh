#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# systemd and non-interactive shells may not load the user's PATH additions.
# Prefer an explicit override, then PATH, then OpenCode's documented local bin.
if [[ -z "${OPENCODE_BIN:-}" ]]; then
    if command -v opencode >/dev/null 2>&1; then
        OPENCODE_BIN="$(command -v opencode)"
    elif [[ -x "$HOME/.opencode/bin/opencode" ]]; then
        OPENCODE_BIN="$HOME/.opencode/bin/opencode"
    else
        echo "ERROR: no se encontró OpenCode. Instálalo o define OPENCODE_BIN con la ruta al ejecutable."
        exit 1
    fi
fi
if [[ ! -x "$OPENCODE_BIN" ]]; then
    echo "ERROR: OPENCODE_BIN no es ejecutable: $OPENCODE_BIN"
    exit 1
fi

echo "OpenCode: $OPENCODE_BIN"

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
agent_total=0
agent_models=0
for agent_file in .opencode/agents/*.md; do
    agent_total=$((agent_total + 1))
    if grep -qx 'model: opencode-go/mimo-v2.6-flash' "$agent_file"; then
        agent_models=$((agent_models + 1))
    else
        echo "ERROR: falta 'model: opencode-go/mimo-v2.6-flash' en $agent_file"
    fi
done
if [ "$agent_total" -ne 7 ]; then
    echo "ERROR: se esperaban 7 ficheros de agente; encontrados: $agent_total"
    exit 1
fi
if [ "$agent_models" -ne "$agent_total" ]; then
    echo "ERROR: solo $agent_models de $agent_total agentes fijan opencode-go/mimo-v2.6-flash"
    exit 1
fi
echo "PASS: los 7 agentes fijan opencode-go/mimo-v2.6-flash"

echo
echo "== 1c. Validar newline final =="
# Fragmentos que la plantilla de calidad debe traer siempre; se comprueba su
# existencia antes del bucle para no reportar un "falta newline" engañoso.
for fragment_file in \
    templates/quality/maven-quality-plugins.xml \
    templates/quality/gradle-quality.gradle; do
    if [ ! -s "$fragment_file" ]; then
        echo "ERROR: falta o está vacío el fragmento de calidad $fragment_file"
        exit 1
    fi
done
echo "PASS: fragmentos de calidad presentes (maven y gradle)"

newline_targets=()
while IFS= read -r -d '' target_file; do
    newline_targets+=("$target_file")
done < <(
    printf '%s\0' README.md AGENTS.md opencode.json .gitignore \
        control-center/README.md docs/GUIA-USUARIO-CONTROL-CENTER.md \
        docs/SECURITY-BASELINE.md docs/multi-engine/00-auditoria-inicial.md \
        docs/multi-engine/01-arquitectura-multimotor.md \
        docs/multi-engine/02-hoja-de-ruta.md \
        docs/multi-engine/03-pruebas-iniciales-y-bloqueos.md \
        templates/AGENTS.md templates/quality/README.md \
        templates/quality/maven-quality-plugins.xml \
        templates/quality/gradle-quality.gradle
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
    "reviewer", "tester", "cloud-arbiter", "reverse"
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
    "dependency-audit", "security-scan",
    "spring-boot-architecture", "java-build-quality",
}
skills_dir = root / ".opencode" / "skills"
actual_skills = {
    p.parent.name
    for p in skills_dir.glob("*/SKILL.md")
}
missing_skills = required_skills - actual_skills

if missing_skills:
    raise SystemExit(f"Faltan skills: {sorted(missing_skills)}")

# A2: frontmatter de TODAS las skills que OpenCode carga: las locales de
# .opencode/skills y las de terceros de .agents/skills. OpenCode solo carga
# una skill cuyo SKILL.md empieza por '---' y declara name (igual al
# directorio) y description no vacía; sin eso la skill existe pero nunca se
# puede invocar.
# Si PyYAML está disponible se valida YAML real; si no, se aplica un parser
# mínimo explícito (y se avisa), porque un YAML mal formado que pase este
# check sería un falso negativo del propio objetivo.
try:
    import yaml as _yaml
except ImportError:
    _yaml = None
    print(
        "NOTA: PyYAML no disponible; validación de frontmatter con "
        "parser mínimo (sin chequeo de sintaxis YAML)."
    )

local_skill_paths = sorted(skills_dir.glob("*/SKILL.md"))
third_party_skill_paths = sorted(
    (root / ".agents" / "skills").glob("*/SKILL.md")
)
skill_paths = local_skill_paths + third_party_skill_paths

frontmatter_errors = []
for skill_path in skill_paths:
    rel = skill_path.relative_to(root).as_posix()
    dir_name = skill_path.parent.name
    lines = skill_path.read_text(encoding="utf-8").splitlines()

    if not lines or lines[0] != "---":
        frontmatter_errors.append(
            f"{rel}: la primera línea debe ser exactamente '---'"
        )
        continue
    try:
        closing = lines.index("---", 1)
    except ValueError:
        frontmatter_errors.append(
            f"{rel}: frontmatter YAML sin línea de cierre '---'"
        )
        continue

    header = "\n".join(lines[1:closing])
    name_value = None
    description_value = None
    if _yaml is not None:
        try:
            parsed = _yaml.safe_load(header) or {}
        except Exception as exc:  # noqa: BLE001 - informar y seguir
            frontmatter_errors.append(f"{rel}: YAML inválido ({exc})")
            continue
        if not isinstance(parsed, dict):
            frontmatter_errors.append(f"{rel}: el frontmatter no es un mapa YAML")
            continue
        name_value = parsed.get("name")
        description_value = parsed.get("description")
    else:
        for raw in lines[1:closing]:
            if raw.startswith("name:") and name_value is None:
                name_value = raw.split(":", 1)[1].strip().strip("\"'")
            elif raw.startswith("description:") and description_value is None:
                description_value = raw.split(":", 1)[1].strip().strip("\"'")

    if name_value != dir_name:
        frontmatter_errors.append(
            f"{rel}: 'name' debe ser '{dir_name}' "
            f"(obtenido: {name_value!r})"
        )
    if not description_value:
        frontmatter_errors.append(f"{rel}: falta 'description' o está vacía")

if frontmatter_errors:
    raise SystemExit(
        "Frontmatter YAML inválido en skills:\n- "
        + "\n- ".join(frontmatter_errors)
    )

snapshot = json.loads(
    (root / "config/global-inline-agents.snapshot.json")
    .read_text(encoding="utf-8")
)
if "build" not in snapshot.get("agents", {}):
    raise SystemExit("La instantánea no contiene build")

print(f"PASS: {len(actual_agents)} archivos de agentes")
print(
    f"PASS: {len(actual_skills)} skills locales de .opencode/skills "
    "verificadas"
)
print(
    "PASS: frontmatter YAML válido (---, name, description) en "
    f"{len(skill_paths)} skills ({len(local_skill_paths)} locales + "
    f"{len(third_party_skill_paths)} de terceros)"
)
print("PASS: instantánea de agentes disponible")
PYTHON

echo
echo "== 3. Validar configuración efectiva esperada =="
python3 - <<'PYTHON'
import json
from pathlib import Path

config = json.loads(Path("opencode.json").read_text(encoding="utf-8"))
assert config.get("default_agent") == "build", "default_agent debe ser build"
assert config.get("model") == "opencode-go/mimo-v2.6-flash", "modelo predeterminado inesperado"
compaction = config.get("compaction") or {}
assert compaction.get("auto") is True, "compaction.auto debe ser true"
assert (compaction.get("keep") or {}).get("tokens") == 15000, "compaction.keep.tokens debe ser 15000"
print("PASS: default agent, modelo y compactación de la fábrica")
PYTHON

echo
echo "== 3b. Probar límites anti-symlink y contratos de permisos de los agentes =="
python3 scripts/verify-opencode-agents.test.py

echo "== 4. Verificar el registro real de los agentes OpenCode =="
python3 scripts/verify-opencode-agents.py --project "$PWD" --binary "$OPENCODE_BIN"

echo
echo "== 5. Ejecutar self-test del instalador =="
selftest_out="$(mktemp)"
trap 'rm -f "$selftest_out"' EXIT
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
