#!/usr/bin/env python3
"""Instalador reversible de OpenCode Software Factory. Solo usa Python estándar."""

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
ALLOWED = (
    ".opencode/agents",
    ".opencode/commands",
    ".opencode/skills",
    ".agents/skills",
    "opencode.json",
)
OPTIONAL_TARGETS = ("AGENTS.md",)
OPTIONAL_SOURCES = {"AGENTS.md": "templates/AGENTS.md"}
EXPECTED_AGENTS = {
    "build", "architect", "implementer",
    "reviewer", "tester", "cloud-arbiter",
}
EXPECTED_MODEL = ("zen-proxy", "nemotron-3.5-super-vl-free")
EXPECTED_AGENT_MODES = {
    "build": "primary",
    "architect": "all",
    "implementer": "all",
    "reviewer": "all",
    "tester": "all",
    "cloud-arbiter": "subagent",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def state_root():
    base = os.environ.get("OPENCODE_SOFTWARE_FACTORY_STATE")
    if not base:
        base = os.environ.get(
            "XDG_STATE_HOME", str(Path.home() / ".local/state")
        )
    return Path(base).expanduser() / "opencode-software-factory"


def manifest_path(target):
    key = sha(str(target).encode())[:24]
    return state_root() / f"{key}.json"


def resolve_target(raw):
    target = Path(raw).expanduser().resolve(strict=True)
    if not target.is_dir():
        raise ValueError(f"No es un directorio: {target}")
    if target == ROOT or target in ROOT.parents or ROOT in target.parents:
        raise ValueError(
            "El destino no puede ser la fábrica ni un directorio "
            "padre o descendiente de ella."
        )
    return target


def source_files():
    result = {}
    for prefix in ALLOWED:
        base = ROOT / prefix
        if base.is_symlink():
            raise ValueError(f"No se admiten enlaces simbólicos: {base}")
        if base.is_file():
            # Las entradas de ALLOWED que son archivos (p. ej. opencode.json).
            result[prefix] = base.read_bytes()
            continue
        if not base.is_dir():
            continue
        for src in sorted(base.rglob("*")):
            if src.is_symlink():
                raise ValueError(f"No se admiten enlaces simbólicos: {src}")
            if src.is_file():
                rel = src.relative_to(ROOT).as_posix()
                result[rel] = src.read_bytes()

    agents = {
        PurePosixPath(p).stem
        for p in result
        if p.startswith(".opencode/agents/") and p.endswith(".md")
    }
    missing = EXPECTED_AGENTS - agents
    if missing:
        raise ValueError(f"Faltan agentes de la fábrica: {sorted(missing)}")
    if not result:
        raise ValueError("No se encontraron archivos instalables.")
    return result


def optional_sources():
    """Fuentes opcionales: solo se instalan si el destino todavía no existe."""
    result = {}
    for rel, src_name in OPTIONAL_SOURCES.items():
        src = ROOT / src_name
        if src.is_symlink():
            raise ValueError(f"No se admiten enlaces simbólicos: {src}")
        if not src.is_file():
            raise ValueError(f"Fuente opcional no encontrada: {src}")
        data = src.read_bytes()
        if not data:
            raise ValueError(f"Fuente opcional vacía: {src}")
        result[rel] = data
    return result


def safe_relative(value):
    p = PurePosixPath(value)
    if p.is_absolute() or ".." in p.parts:
        raise ValueError(f"Ruta insegura en manifiesto: {value}")
    if not any(
        value == prefix or value.startswith(prefix + "/")
        for prefix in ALLOWED + OPTIONAL_TARGETS
    ):
        raise ValueError(f"Ruta fuera de los directorios permitidos: {value}")
    return p


def check_ancestors(target, rel):
    current = target
    for part in rel.parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Hay un enlace simbólico en la ruta: {current}")
        if current.exists() and not current.is_dir():
            raise ValueError(f"Se esperaba un directorio: {current}")


def write_manifest_exclusive(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    # El modo exclusivo evita sobrescribir un manifiesto creado por otra ejecución.
    with path.open("x", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def factory_commit():
    import subprocess
    try:
        return subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return "desconocido"


def install(raw_target, dry_run=False):
    try:
        target = resolve_target(raw_target)
        sources = source_files()
        manifest = manifest_path(target)

        if manifest.exists() or manifest.is_symlink():
            raise ValueError(
                f"Ya existe un manifiesto para {target}. "
                "Usa 'status' o 'uninstall' antes de reinstalar."
            )

        copies = []
        skipped = []
        conflicts = []

        # Preflight completo: no copiar nada si hay conflictos.
        for name, data in sources.items():
            rel = safe_relative(name)
            check_ancestors(target, rel)
            dest = target.joinpath(*rel.parts)

            if dest.is_symlink():
                conflicts.append(f"{name}: el destino es un enlace simbólico")
            elif dest.exists():
                if dest.is_file() and dest.read_bytes() == data:
                    skipped.append(name)
                else:
                    conflicts.append(
                        f"{name}: ya existe con contenido diferente"
                    )
            else:
                copies.append((name, dest, data))

        # Opcionales (AGENTS.md): nunca son conflicto. Si el destino ya existe
        # (archivo, enlace o lo que sea) se conserva y no se registra en el
        # manifiesto; solo se crea cuando falta.
        for name, data in optional_sources().items():
            rel = safe_relative(name)
            check_ancestors(target, rel)
            dest = target.joinpath(*rel.parts)
            if dest.exists() or dest.is_symlink():
                skipped.append(name)
            else:
                copies.append((name, dest, data))

        print(f"Destino: {target}")
        print(f"Archivos nuevos: {len(copies)}")
        print(f"Archivos idénticos o preexistentes que se conservarán: {len(skipped)}")

        if conflicts:
            print("\nCONFLICTOS: no se instaló ningún archivo.")
            for item in conflicts:
                print(f"  - {item}")
            return 2

        for name, _, _ in copies:
            print(f"  + {name}")

        if dry_run:
            print("\nVista previa: no se modificó el proyecto.")
            return 0

        created = []
        created_dirs = []
        manifest_created = False

        try:
            for name, dest, data in copies:
                # Crear cada directorio individualmente para poder revertirlo.
                current = target
                rel = PurePosixPath(name)
                for part in rel.parts[:-1]:
                    current = current / part
                    if not current.exists():
                        current.mkdir()
                        created_dirs.append(current)
                    elif current.is_symlink() or not current.is_dir():
                        raise ValueError(f"Ruta de destino insegura: {current}")

                # Exclusivo: no sobrescribe archivos creados concurrentemente.
                with dest.open("xb") as f:
                    f.write(data)
                created.append((dest, sha(data)))

            record = {
                "schema_version": 1,
                "target": str(target),
                "factory_commit": factory_commit(),
                "files": [
                    {"path": name, "sha256": sha(data)}
                    for name, _, data in copies
                ],
            }
            write_manifest_exclusive(manifest, record)
            manifest_created = True

        except Exception:
            if manifest_created and manifest.exists():
                manifest.unlink()
            for path, expected_hash in reversed(created):
                try:
                    if path.is_file() and not path.is_symlink():
                        if sha(path.read_bytes()) == expected_hash:
                            path.unlink()
                except OSError:
                    pass
            for directory in reversed(created_dirs):
                try:
                    directory.rmdir()
                except OSError:
                    pass
            raise

        print("\nInstalación completada.")
        print(f"Manifiesto de control: {manifest}")
        print(
            "opencode.json solo se crea si falta o si coincide con el de la "
            "fábrica; nunca se sobrescribe. AGENTS.md solo se crea si falta "
            "y nunca se sobrescribe."
        )
        return 0

    except Exception as exc:
        print(f"ERROR: {exc}")
        return 1


def load_record(target):
    path = manifest_path(target)
    if path.is_symlink():
        raise ValueError(f"El manifiesto es un enlace simbólico: {path}")
    if not path.is_file():
        return None, path
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or data.get("target") != str(target):
        raise ValueError("Manifiesto inválido o perteneciente a otro destino.")
    return data, path


def status(raw_target):
    try:
        target = resolve_target(raw_target)
        record, manifest = load_record(target)
        if record is None:
            print(f"Sin instalación registrada para: {target}")
            return 0

        changed = 0
        for item in record.get("files", []):
            rel = safe_relative(item["path"])
            path = target.joinpath(*rel.parts)

            if path.is_symlink():
                state = "ENLACE SIMBÓLICO (se conservará)"
                changed += 1
            elif not path.is_file():
                state = "AUSENTE"
            elif sha(path.read_bytes()) == item["sha256"]:
                state = "SIN CAMBIOS"
            else:
                state = "MODIFICADO (se conservará)"
                changed += 1
            print(f"{state}: {item['path']}")

        print(f"Manifiesto: {manifest}")
        return 2 if changed else 0
    except Exception as exc:
        print(f"ERROR: {exc}")
        return 1


def uninstall(raw_target):
    try:
        target = resolve_target(raw_target)
        record, manifest = load_record(target)
        if record is None:
            print(f"No hay instalación registrada para: {target}")
            return 0

        retained = []
        removed = 0

        for item in record.get("files", []):
            rel = safe_relative(item["path"])
            check_ancestors(target, rel)
            path = target.joinpath(*rel.parts)

            if path.is_symlink():
                print(f"CONSERVADO (enlace simbólico): {item['path']}")
                retained.append(item)
                continue
            if not path.exists():
                continue
            if not path.is_file():
                print(f"CONSERVADO (ya no es archivo): {item['path']}")
                retained.append(item)
                continue
            if sha(path.read_bytes()) != item["sha256"]:
                print(f"CONSERVADO (fue modificado): {item['path']}")
                retained.append(item)
                continue

            path.unlink()
            removed += 1
            print(f"Eliminado: {item['path']}")

        if retained:
            # No perdemos el registro de archivos que se preservaron.
            temp = manifest.with_suffix(".tmp")
            temp.write_text(
                json.dumps({**record, "files": retained}, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(temp, manifest)
            print(f"\nQuedaron {len(retained)} archivos modificados.")
            print(f"Registro conservado: {manifest}")
            return 2

        manifest.unlink()
        try:
            manifest.parent.rmdir()
        except OSError:
            pass
        print(f"\nDesinstalación completada. Archivos eliminados: {removed}")
        return 0

    except Exception as exc:
        print(f"ERROR: {exc}")
        return 1


def doctor(raw_target):
    """Comprueba que la fábrica funciona en el proyecto consumidor."""
    import subprocess

    try:
        target = resolve_target(raw_target)
    except Exception as exc:
        print(f"ERROR: {exc}")
        return 1

    config_path = target / "opencode.json"
    if not config_path.is_file():
        print(f"ERROR: no existe {config_path}")
        print("Instala la fábrica en el proyecto antes de ejecutar 'doctor'.")
        return 1

    findings = 0

    def check(ok, message):
        nonlocal findings
        if ok:
            print(f"PASS: {message}")
        else:
            findings += 1
            print(f"ERROR: {message}")

    def run_debug(subcommand):
        try:
            proc = subprocess.run(
                ["opencode", "debug", subcommand],
                cwd=str(target),
                capture_output=True,
                text=True,
                timeout=180,
            )
        except FileNotFoundError:
            print("ERROR: no existe el comando 'opencode' en este entorno.")
            return None
        except subprocess.TimeoutExpired:
            print(f"ERROR: 'opencode debug {subcommand}' superó los 180 s.")
            return None
        if proc.returncode != 0:
            if proc.stderr:
                print(proc.stderr, end="")
            print(
                f"ERROR: 'opencode debug {subcommand}' terminó con el "
                f"código {proc.returncode}."
            )
            return None
        return proc.stdout

    agents_stdout = run_debug("agents")
    if agents_stdout is None:
        return 1
    try:
        agents = json.loads(agents_stdout)
    except json.JSONDecodeError as exc:
        print(f"ERROR: 'opencode debug agents' no devolvió JSON: {exc}")
        return 1

    # En un directorio recién creado, la primera invocación de `opencode
    # debug agents` devuelve una lista vacía con código 0 (comportamiento
    # observado del CLI). Se reintenta una vez antes de darlo por vacío.
    if isinstance(agents, list) and not agents:
        print(
            "NOTA: 'opencode debug agents' devolvió [] (primera invocación "
            "en este directorio); se reintenta una vez."
        )
        agents_stdout = run_debug("agents")
        if agents_stdout is None:
            return 1
        try:
            agents = json.loads(agents_stdout)
        except json.JSONDecodeError as exc:
            print(f"ERROR: 'opencode debug agents' no devolvió JSON: {exc}")
            return 1

    by_id = {}
    if isinstance(agents, list):
        by_id = {
            item.get("id"): item
            for item in agents
            if isinstance(item, dict)
        }

    for agent_id in sorted(EXPECTED_AGENTS):
        expected_mode = EXPECTED_AGENT_MODES[agent_id]
        agent = by_id.get(agent_id)
        check(agent is not None, f"agente '{agent_id}' reconocido")
        if agent is None:
            continue
        mode = agent.get("mode")
        check(
            mode == expected_mode,
            f"agente '{agent_id}' en modo {expected_mode} "
            f"(obtenido: {mode})",
        )
        model = agent.get("model") or {}
        provider = model.get("providerID")
        # El CLI usa model.id dentro del objeto model de cada agente.
        name = model.get("model", model.get("id"))
        check(
            provider == EXPECTED_MODEL[0],
            f"agente '{agent_id}' con proveedor {EXPECTED_MODEL[0]} "
            f"(obtenido: {provider})",
        )
        check(
            name == EXPECTED_MODEL[1],
            f"agente '{agent_id}' con modelo {EXPECTED_MODEL[1]} "
            f"(obtenido: {name})",
        )

    config_stdout = run_debug("config")
    if config_stdout is None:
        return 1
    try:
        documents = json.loads(config_stdout)
    except json.JSONDecodeError as exc:
        print(f"ERROR: 'opencode debug config' no devolvió JSON: {exc}")
        return 1

    document = None
    if isinstance(documents, list):
        for entry in documents:
            if (
                isinstance(entry, dict)
                and entry.get("path") == str(config_path)
            ):
                document = entry
                break
    check(
        document is not None,
        f"OpenCode carga {config_path}",
    )
    info = (document or {}).get("info") or {}
    default_agent = info.get("default_agent")
    check(
        default_agent == "build",
        f"default_agent == 'build' en {config_path} "
        f"(obtenido: {default_agent})",
    )
    model_info = info.get("model") or {}
    model_name = model_info.get("model")
    check(
        model_name == EXPECTED_MODEL[1],
        f"modelo {EXPECTED_MODEL[1]} en {config_path} "
        f"(obtenido: {model_name})",
    )

    if findings:
        print(f"\nDoctor: {findings} hallazgo(s).")
        return 2
    print("\nDoctor: la fábrica funciona en este proyecto.")
    return 0


def self_test():
    # Pruebas aisladas: no tocan tus proyectos ni el estado habitual del usuario.
    import tempfile

    old_state = os.environ.get("OPENCODE_SOFTWARE_FACTORY_STATE")

    with tempfile.TemporaryDirectory(prefix="factory-test-") as temp:
        base = Path(temp)
        os.environ["OPENCODE_SOFTWARE_FACTORY_STATE"] = str(base / "state")

        project = base / "project"
        project.mkdir()
        (project / "README.md").write_text("README del usuario\n")
        factory_config = (ROOT / "opencode.json").read_bytes()
        agents_template = (ROOT / "templates/AGENTS.md").read_bytes()

        try:
            # Caso: proyecto SIN opencode.json → se crea con el de la fábrica.
            assert install(project, dry_run=True) == 0
            assert not (project / ".opencode/agents/build.md").exists()
            assert not (project / "opencode.json").exists()
            assert not (project / "AGENTS.md").exists()

            assert install(project) == 0
            assert (project / ".opencode/agents/build.md").is_file()
            assert (project / "opencode.json").read_bytes() == factory_config
            assert (project / "README.md").read_text() == "README del usuario\n"
            # AGENTS.md ausente → se crea con la plantilla de la fábrica.
            assert (project / "AGENTS.md").read_bytes() == agents_template

            installed = project / ".opencode/agents/build.md"
            installed.write_text(installed.read_text() + "\n# Modificación del usuario\n")
            assert uninstall(project) == 2
            assert installed.exists()
            # opencode.json era copia intacta creada por la fábrica: se retira.
            assert not (project / "opencode.json").exists()

            installed.unlink()
            assert uninstall(project) == 0
            assert not (project / ".opencode/agents/architect.md").exists()
            # AGENTS.md lo creó la fábrica y nadie lo modificó: se retira.
            assert not (project / "AGENTS.md").exists()
            print(
                "PASS: instalación, preservación, reversión y archivos "
                "modificados (AGENTS.md ausente se crea y se revierte)"
            )

            # Caso: AGENTS.md PREEXISTENTE → no es conflicto, se conserva
            # intacto y la desinstalación no lo retira.
            own_project = base / "own-agents"
            own_project.mkdir()
            own_md = own_project / "AGENTS.md"
            own_content = "Instrucciones propias del equipo\n"
            own_md.write_text(own_content)

            assert install(own_project) == 0
            assert own_md.read_text() == own_content
            assert uninstall(own_project) == 0
            assert own_md.read_text() == own_content
            print("PASS: AGENTS.md preexistente se conserva sin cambios")

            # Caso: opencode.json IDÉNTICO al de la fábrica → skipped/ok,
            # se conserva y la desinstalación no lo toca (no lo creó la fábrica).
            same_project = base / "same"
            same_project.mkdir()
            (same_project / "opencode.json").write_bytes(factory_config)

            assert install(same_project) == 0
            assert (same_project / "opencode.json").read_bytes() == factory_config
            assert uninstall(same_project) == 0
            assert (same_project / "opencode.json").read_bytes() == factory_config
            print("PASS: opencode.json idéntico se conserva sin cambios")

            # Caso: opencode.json DISTINTO → CONFLICTO (código 2),
            # el archivo del proyecto queda intacto y nada se instala.
            conflict_project = base / "conflict"
            conflict_project.mkdir()
            (conflict_project / "opencode.json").write_text('{"model":"propio"}\n')
            custom = conflict_project / ".opencode/agents/build.md"
            custom.parent.mkdir(parents=True)
            custom.write_text("Agente personalizado preexistente\n")

            assert install(conflict_project) == 2
            assert (conflict_project / "opencode.json").read_text() == '{"model":"propio"}\n'
            assert custom.read_text() == "Agente personalizado preexistente\n"
            assert not (conflict_project / ".opencode/commands/implementar.md").exists()
            print("PASS: los conflictos abortan sin sobrescribir el proyecto")

        finally:
            if old_state is None:
                os.environ.pop("OPENCODE_SOFTWARE_FACTORY_STATE", None)
            else:
                os.environ["OPENCODE_SOFTWARE_FACTORY_STATE"] = old_state

    print("SELF-TEST COMPLETADO")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_install = sub.add_parser("install", help="Instalar la fábrica en un proyecto")
    p_install.add_argument("target", help="Ruta de un proyecto existente")
    p_install.add_argument("--dry-run", action="store_true", help="Solo mostrar cambios")

    p_status = sub.add_parser("status", help="Revisar archivos instalados")
    p_status.add_argument("target")

    p_uninstall = sub.add_parser("uninstall", help="Retirar archivos sin cambios")
    p_uninstall.add_argument("target")

    p_doctor = sub.add_parser(
        "doctor",
        help="Comprobar que la fábrica funciona en el proyecto consumidor",
    )
    p_doctor.add_argument("target")

    sub.add_parser("self-test", help="Probar el instalador en directorios temporales")

    args = parser.parse_args()
    if args.command == "install":
        return install(args.target, args.dry_run)
    if args.command == "status":
        return status(args.target)
    if args.command == "uninstall":
        return uninstall(args.target)
    if args.command == "doctor":
        return doctor(args.target)
    return self_test()


if __name__ == "__main__":
    raise SystemExit(main())
