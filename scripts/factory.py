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
)
EXPECTED_AGENTS = {
    "build", "architect", "implementer",
    "reviewer", "tester", "cloud-arbiter",
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


def safe_relative(value):
    p = PurePosixPath(value)
    if p.is_absolute() or ".." in p.parts:
        raise ValueError(f"Ruta insegura en manifiesto: {value}")
    if not any(
        value.startswith(prefix + "/") for prefix in ALLOWED
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

        print(f"Destino: {target}")
        print(f"Archivos nuevos: {len(copies)}")
        print(f"Archivos idénticos que se conservarán: {len(skipped)}")

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
        print("No se modificaron opencode.json ni AGENTS.md.")
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
        (project / "opencode.json").write_text('{"model":"propio"}\n')

        try:
            assert install(project, dry_run=True) == 0
            assert not (project / ".opencode/agents/build.md").exists()

            assert install(project) == 0
            assert (project / ".opencode/agents/build.md").is_file()
            assert (project / "opencode.json").read_text() == '{"model":"propio"}\n'
            assert (project / "README.md").read_text() == "README del usuario\n"
            assert not (project / "AGENTS.md").exists()

            installed = project / ".opencode/agents/build.md"
            installed.write_text(installed.read_text() + "\n# Modificación del usuario\n")
            assert uninstall(project) == 2
            assert installed.exists()

            installed.unlink()
            assert uninstall(project) == 0
            assert not (project / ".opencode/agents/architect.md").exists()
            print("PASS: instalación, preservación, reversión y archivos modificados")

            conflict_project = base / "conflict"
            conflict_project.mkdir()
            custom = conflict_project / ".opencode/agents/build.md"
            custom.parent.mkdir(parents=True)
            custom.write_text("Agente personalizado preexistente\n")

            assert install(conflict_project) == 2
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

    sub.add_parser("self-test", help="Probar el instalador en directorios temporales")

    args = parser.parse_args()
    if args.command == "install":
        return install(args.target, args.dry_run)
    if args.command == "status":
        return status(args.target)
    if args.command == "uninstall":
        return uninstall(args.target)
    return self_test()


if __name__ == "__main__":
    raise SystemExit(main())
