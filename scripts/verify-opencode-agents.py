#!/usr/bin/env python3
"""Verifica el registro real de agentes OpenCode V2 sin llamar a ningún modelo."""

from __future__ import annotations

import argparse
import base64
import fnmatch
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

EXPECTED_MODES = {
    "build": "primary",
    "architect": "all",
    "implementer": "all",
    "reviewer": "all",
    "tester": "all",
    "cloud-arbiter": "subagent",
    "reverse": "all",
}


def request_json(base_url: str, auth: str, path: str, timeout: float = 3.0):
    request = urllib.request.Request(
        base_url + path,
        headers={"Authorization": auth, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def find_binary(value: str | None) -> str | None:
    if value:
        candidate = Path(value).expanduser()
        return str(candidate.resolve()) if candidate.is_file() and os.access(candidate, os.X_OK) else None
    from_path = shutil.which("opencode")
    if from_path:
        return str(Path(from_path).resolve())
    fallback = Path.home() / ".opencode" / "bin" / "opencode"
    if fallback.is_file() and os.access(fallback, os.X_OK):
        return str(fallback.resolve())
    return None


def has_symlink_component(root: Path, candidate: Path) -> bool:
    """Return True if any project-relative component is a symbolic link."""
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        return True
    current = root
    for part in relative.parts:
        current = current / part
        try:
            if current.is_symlink():
                return True
        except OSError:
            return True
    return False


def parse_permission_rules(frontmatter_lines: list[str]) -> list[tuple[str, str, str]]:
    """Parse the simple ordered permissions sequence used by agent Markdown frontmatter."""
    rules: list[tuple[str, str, str]] = []
    active = False
    current: dict[str, str] = {}

    def finish() -> None:
        if all(key in current for key in ("action", "resource", "effect")):
            rules.append((current["action"], current["resource"], current["effect"]))

    for raw in frontmatter_lines:
        if raw.strip() == "permissions:" and not raw.startswith(" "):
            active = True
            continue
        if not active:
            continue
        if raw and not raw[0].isspace():
            finish()
            break
        stripped = raw.strip()
        if stripped.startswith("- action:"):
            finish()
            value = stripped.split(":", 1)[1].strip().strip("\"'")
            current = {"action": value}
        elif ":" in stripped and current:
            key, value = stripped.split(":", 1)
            key = key.strip()
            if key in {"action", "resource", "effect"}:
                current[key] = value.strip().strip("\"'")
    finish()
    return rules


def effective_agent_permission(
    rules: list[tuple[str, str, str]],
    action: str,
    resource: str
) -> str | None:
    """Resolve ordered Markdown permission rules using OpenCode's last-match-wins behavior."""
    effect = None
    for rule_action, pattern, rule_effect in rules:
        if rule_action not in {"*", action}:
            continue
        # OpenCode V2 shell rules ending in " *" also match the bare
        # command without arguments; Python's fnmatch does not include the
        # separating space, so model that documented special case explicitly.
        matches = fnmatch.fnmatchcase(resource, pattern)
        if action == "shell" and pattern.endswith(" *") and resource == pattern[:-2]:
            matches = True
        if matches:
            effect = rule_effect
    return effect


def required_agent_permission_rules(agent_id: str) -> set[tuple[str, str, str]]:
    """Security invariants that must be present in the source agent profile."""
    if agent_id in {"architect", "build", "cloud-arbiter", "reviewer", "reverse"}:
        required = {
            ("edit", "*", "deny"),
            ("shell", "*", "deny"),
        }
        if agent_id == "build":
            required.update({
                ("subagent", target, "allow")
                for target in ("architect", "implementer", "reviewer", "tester", "cloud-arbiter", "reverse")
            })
        return required
    if agent_id == "tester":
        return {
            ("edit", "*", "deny"),
            ("shell", "*", "ask"),
        }
    if agent_id == "implementer":
        return {
            ("shell", resource, "deny")
            for resource in (
                "sudo *", "git push *", "git commit *", "git checkout *",
                "git reset *", "git restore *", "curl *", "wget *",
                "rm -rf *", "rm -r *", "rm -fr *"
            )
        }
    return set()


def verify(project: Path, binary: str | None) -> int:
    project = project.resolve(strict=True)
    config_path = project / "opencode.json"
    agent_dir = project / ".opencode" / "agents"
    filesystem_script = project / ".opencode" / "mcp" / "factory-filesystem.mjs"
    for candidate in (config_path, agent_dir, filesystem_script):
        if has_symlink_component(project, candidate):
            print(f"ERROR: no se siguen enlaces simbólicos al verificar configuración/agentes: {candidate}")
            return 1
    if not config_path.is_file():
        print(f"ERROR: no existe {config_path}")
        return 1
    if not agent_dir.is_dir():
        print(f"ERROR: no existe {agent_dir}")
        return 1

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: configuración inválida en {config_path}: {exc}")
        return 1

    default_agent = config.get("default_agent")
    model = config.get("model")
    if default_agent != "build":
        print(f"ERROR: default_agent debe ser 'build' (obtenido: {default_agent!r})")
        return 1
    if not isinstance(model, str) or "/" not in model:
        print(f"ERROR: model debe tener formato proveedor/modelo (obtenido: {model!r})")
        return 1

    permissions = config.get("permissions", [])
    if not isinstance(permissions, list):
        print("ERROR: permissions debe ser una lista de reglas.")
        return 1
    required_rules = {
        ("external_directory", "*", "deny"),
        ("read", "*", "deny"),
        ("glob", "*", "deny"),
        ("grep", "*", "deny"),
        ("list", "*", "deny"),
        ("lsp", "*", "deny"),
        ("subagent", "*", "deny"),
        ("factory_filesystem_*", "*", "allow"),
    }
    actual_rules = {
        (item.get("action"), item.get("resource"), item.get("effect"))
        for item in permissions if isinstance(item, dict)
    }
    missing_rules = sorted(required_rules - actual_rules)
    if missing_rules:
        print("ERROR: faltan reglas de aislamiento OpenCode: " + repr(missing_rules))
        return 1

    servers = (config.get("mcp") or {}).get("servers") or {}
    filesystem_server = servers.get("factory_filesystem")
    if not isinstance(filesystem_server, dict):
        print("ERROR: falta mcp.servers.factory_filesystem.")
        return 1
    if filesystem_server.get("type") != "local":
        print("ERROR: factory_filesystem debe ser un servidor MCP local.")
        return 1
    expected_mcp_command = [
        "node",
        "-e",
        "import(require('node:url').pathToFileURL(require('node:path').resolve(process.env.FACTORY_FILESYSTEM_MCP_ENTRYPOINT || '.opencode/mcp/factory-filesystem.mjs')).href)"
    ]
    if filesystem_server.get("command") != expected_mcp_command:
        print("ERROR: el comando factory_filesystem no coincide con el servidor seguro versionado.")
        return 1
    if filesystem_server.get("codemode") is not False or filesystem_server.get("enabled") is not True:
        print("ERROR: factory_filesystem debe estar enabled y codemode=false.")
        return 1

    if not filesystem_script.is_file() or filesystem_script.is_symlink():
        print("ERROR: falta el servidor MCP seguro .opencode/mcp/factory-filesystem.mjs.")
        return 1

    missing_files = sorted(set(EXPECTED_MODES) - {path.stem for path in agent_dir.glob("*.md")})
    if missing_files:
        print("ERROR: faltan definiciones Markdown: " + ", ".join(missing_files))
        return 1

    # Validate the source files too: the server registry check below proves
    # runtime discovery, while these checks prove the intended configuration
    # has not drifted or fallen back to OpenCode defaults.
    for agent_id, expected_mode in EXPECTED_MODES.items():
        agent_path = agent_dir / (agent_id + ".md")
        if has_symlink_component(project, agent_path) or not agent_path.is_file():
            print(f"ERROR: la definición del agente no es un archivo regular seguro: {agent_path}")
            return 1
        lines = agent_path.read_text(encoding="utf-8").splitlines()
        if not lines or lines[0].strip() != "---":
            print(f"ERROR: {agent_path} no tiene frontmatter YAML inicial.")
            return 1
        try:
            closing = lines.index("---", 1)
        except ValueError:
            print(f"ERROR: {agent_path} no cierra su frontmatter YAML.")
            return 1
        frontmatter = {}
        duplicates = set()
        for line in lines[1:closing]:
            # Only inspect top-level YAML keys; repeated nested keys inside
            # a permissions sequence are valid and expected.
            if not line or line[0].isspace() or ":" not in line or line.startswith("#") or line.startswith("-"):
                continue
            key, value = line.split(":", 1)
            key = key.strip()
            if key in frontmatter:
                duplicates.add(key)
            frontmatter[key] = value.strip().strip("\"'")
        if duplicates:
            print(f"ERROR: {agent_path} repite claves YAML: {sorted(duplicates)}")
            return 1
        if frontmatter.get("mode") != expected_mode:
            print(
                f"ERROR: {agent_id} declara mode={frontmatter.get('mode')!r}; "
                f"se esperaba {expected_mode!r}."
            )
            return 1
        if frontmatter.get("model") != model:
            print(
                f"ERROR: {agent_id} declara model={frontmatter.get('model')!r}; "
                f"se esperaba {model!r}."
            )
            return 1
        actual_agent_rules = parse_permission_rules(lines[1:closing])
        actual_agent_rule_set = set(actual_agent_rules)
        missing_agent_rules = sorted(required_agent_permission_rules(agent_id) - actual_agent_rule_set)
        if missing_agent_rules:
            print(f"ERROR: {agent_id} no cumple su contrato de permisos: {missing_agent_rules!r}")
            return 1

        permission_probes = {
            "architect": [("edit", "src/example.java", "deny"), ("shell", "mvn -B test", "deny")],
            "build": [
                ("edit", "src/example.java", "deny"),
                ("shell", "mvn -B test", "deny"),
                ("subagent", "architect", "allow"),
                ("subagent", "unknown-agent", None),
            ],
            "cloud-arbiter": [("edit", "src/example.java", "deny"), ("shell", "curl https://example.invalid", "deny")],
            "reviewer": [
                ("edit", "src/example.java", "deny"),
                ("shell", "git status --short", "allow"),
                ("shell", "rm -rf /tmp/example", "deny"),
            ],
            "reverse": [("edit", "src/example.java", "deny"), ("shell", "mvn -B test", "deny")],
            "tester": [
                ("edit", "src/example.java", "deny"),
                ("shell", "mvn -B test", "allow"),
                ("shell", "rm -rf /tmp/example", "deny"),
                ("shell", "python3 -c print(1)", "ask"),
            ],
            "implementer": [
                ("shell", "sudo apt install x", "deny"),
                ("shell", "git push origin main", "deny"),
                ("shell", "rm -rf /tmp/example", "deny"),
            ],
        }
        for action, resource, expected_effect in permission_probes.get(agent_id, []):
            actual_effect = effective_agent_permission(actual_agent_rules, action, resource)
            if actual_effect != expected_effect:
                print(
                    f"ERROR: {agent_id} permisos efectivos incorrectos para "
                    f"{action} {resource!r}: {actual_effect!r} (esperado {expected_effect!r})."
                )
                return 1
        if agent_id == "build":
            allowed_subagents = {
                resource for action, resource, effect in actual_agent_rules
                if action == "subagent" and effect == "allow"
            }
            if allowed_subagents != {"architect", "implementer", "reviewer", "tester", "cloud-arbiter", "reverse"}:
                print("ERROR: Build debe permitir delegación solo a los seis agentes especialistas nombrados.")
                return 1
        if not frontmatter.get("description"):
            print(f"ERROR: {agent_id} no declara una descripción.")
            return 1

    binary_path = find_binary(binary)
    if not binary_path:
        print("ERROR: no se encontró un ejecutable OpenCode (usa --binary u OPENCODE_BIN).")
        return 1

    # This smoke test needs the real agent directory but not the configured MCP
    # processes. Use a temporary copy of the project's config with MCP servers
    # omitted so verification has no model calls or external MCP side effects.
    isolated_config = dict(config)
    isolated_config.pop("mcp", None)
    isolated_config.pop("plugin", None)
    isolated_config.pop("instructions", None)
    isolated_config.pop("command", None)

    with tempfile.TemporaryDirectory(prefix="factory-opencode-registry-") as temp_dir:
        temporary_config = Path(temp_dir) / "opencode.json"
        temporary_config.write_text(
            json.dumps(isolated_config, ensure_ascii=False),
            encoding="utf-8",
        )

        port = free_port()
        password = secrets.token_urlsafe(36)
        auth = "Basic " + base64.b64encode(
            ("opencode:" + password).encode("utf-8")
        ).decode("ascii")
        env = os.environ.copy()
        env.update({
            "OPENCODE_CONFIG": str(temporary_config),
            "OPENCODE_CONFIG_DIR": str(project / ".opencode"),
            "OPENCODE_DISABLE_EXTERNAL_SKILLS": "true",
            "OPENCODE_SERVER_PASSWORD": password,
            "OPENCODE_PASSWORD": password,
        })

        process = subprocess.Popen(
            [
                binary_path,
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=str(project),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        base_url = f"http://127.0.0.1:{port}"
        try:
            deadline = time.monotonic() + 20.0
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    print(f"ERROR: OpenCode terminó antes de iniciar (código {process.returncode}).")
                    return 1
                try:
                    info = request_json(base_url, auth, "/api/info", timeout=1.5)
                    if not isinstance(info, dict):
                        raise ValueError("respuesta /api/info no es un objeto")
                    break
                except (OSError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
                    time.sleep(0.2)
            else:
                print("ERROR: OpenCode no respondió a /api/info en 20 segundos.")
                return 1

            query = urllib.parse.urlencode({"location[directory]": str(project)})
            endpoint = "/api/agent?" + query
            expected_ids = set(EXPECTED_MODES)
            last_missing = sorted(expected_ids)
            last_wrong: list[str] = []
            last_count = 0
            agent_map: dict[str, dict] = {}

            # /api/info may be ready before the asynchronous config scanner has
            # registered Markdown agents. Poll the same location-aware endpoint
            # used by OpenCode V2 until all seven IDs and modes are available.
            deadline = time.monotonic() + 15.0
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    print("ERROR: OpenCode terminó mientras cargaba el catálogo de agentes.")
                    return 1
                try:
                    payload = request_json(base_url, auth, endpoint, timeout=2.5)
                    entries = payload.get("data", []) if isinstance(payload, dict) else []
                    if not isinstance(entries, list):
                        entries = []
                    agent_map = {
                        item.get("id"): item
                        for item in entries
                        if isinstance(item, dict) and isinstance(item.get("id"), str)
                    }
                    last_count = len(agent_map)
                    last_missing = sorted(expected_ids - set(agent_map))
                    last_wrong = [
                        f"{agent_id}={agent_map[agent_id].get('mode')!r} (esperado {mode!r})"
                        for agent_id, mode in EXPECTED_MODES.items()
                        if agent_id in agent_map and agent_map[agent_id].get("mode") != mode
                    ]
                    if not last_missing and not last_wrong:
                        print(f"PASS: OpenCode {info.get('version', 'V2')} registró los 7 agentes desde {agent_dir}.")
                        for agent_id, mode in EXPECTED_MODES.items():
                            print(f"  PASS: {agent_id} · mode={mode} · model={model}")
                        print("PASS: permisos de solo lectura, delegación del coordinador y límites del Tester/Implementer verificados.")
                        print("PASS: verificación sin llamadas a modelos ni arranque de MCP externos.")
                        return 0
                except (OSError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
                    pass
                time.sleep(0.25)

            if last_missing:
                print("ERROR: agentes no registrados: " + ", ".join(last_missing))
            if last_wrong:
                print("ERROR: modos incorrectos: " + "; ".join(last_wrong))
            print(f"ERROR: catálogo incompleto tras 15 segundos ({last_count} agentes visibles).")
            return 1
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=str(Path(__file__).resolve().parent.parent),
                        help="raíz del proyecto que contiene opencode.json y .opencode/")
    parser.add_argument("--binary", help="ruta al ejecutable de OpenCode")
    args = parser.parse_args()
    try:
        return verify(Path(args.project), args.binary)
    except (OSError, RuntimeError) as exc:
        print(f"ERROR: no se pudo verificar el registro de agentes: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
