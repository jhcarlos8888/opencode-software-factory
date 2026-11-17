#!/usr/bin/env python3
"""Instalador reversible de OpenCode Software Factory. Solo usa Python estándar."""

import argparse
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
ALLOWED = (
    ".opencode/agents",
    ".opencode/commands",
    ".opencode/skills",
    ".opencode/mcp",
    ".agents/skills",
    "opencode.json",
)
OPTIONAL_TARGETS = ("AGENTS.md",)
OPTIONAL_SOURCES = {"AGENTS.md": "templates/AGENTS.md"}
EXPECTED_AGENTS = {
    "build", "architect", "implementer",
    "reviewer", "tester", "cloud-arbiter", "reverse",
}
EXPECTED_MODEL = ("opencode-go", "mimo-v2.6-flash")
EXPECTED_AGENT_MODES = {
    "build": "primary",
    "architect": "all",
    "implementer": "all",
    "reviewer": "all",
    "tester": "all",
    "cloud-arbiter": "subagent",
    "reverse": "primary",
}

# Plantillas de calidad Java por tipo de build (relativas a la raíz).
QUALITY_TEMPLATES = {
    "maven": "templates/quality/maven-quality-plugins.xml",
    "gradle": "templates/quality/gradle-quality.gradle",
}

# Marcadores de sección dentro de las plantillas: cada plugin de calidad
# vive entre "// [[quality:id]]" (o "<!-- [[quality:id]] -->") y su "[[quality:end]]".
QUALITY_MARKER_RE = re.compile(
    r"^\s*(?://|<!--)\s*\[\[quality:([^\]]+)\]\]\s*(?:-->)?\s*$"
)


def _gradle_id_patterns(plugin_id):
    """Regex que detectan un plugin de Gradle sin falsos positivos.

    Cubre el plugins DSL, el apply plugin de Groovy y la forma de Kotlin DSL.
    Las líneas comentadas se descartan antes de buscar.
    """
    q = re.escape(plugin_id)
    return [
        rf"\bid\s+['\"]{q}['\"]",
        rf"\bid\(\s*['\"]{q}['\"]",
        rf"apply\s+plugin\s*:\s*['\"]{q}['\"]",
        rf"apply\s*\(\s*plugin\s*=\s*['\"]{q}['\"]",
    ]


# Plugins de calidad por build. "detect" se evalúa sobre texto ya depurado
# de comentarios; "run" es la meta a ejecutar en el proyecto; "managed" =
# False significa que se informa pero la fábrica NO lo inyecta (queda fuera
# del cálculo del código de salida).
QUALITY_PLUGINS = {
    "maven": {
        "checkstyle": {
            "label": "maven-checkstyle-plugin",
            "detect": [r"<artifactId>\s*maven-checkstyle-plugin\s*</artifactId>"],
            "run": "checkstyle:check",
        },
        "pmd": {
            "label": "maven-pmd-plugin",
            "detect": [r"<artifactId>\s*maven-pmd-plugin\s*</artifactId>"],
            "run": "pmd:check",
        },
        "spotbugs": {
            "label": "spotbugs-maven-plugin",
            "detect": [r"<artifactId>\s*spotbugs-maven-plugin\s*</artifactId>"],
            "run": "spotbugs:check",
        },
        "jacoco": {
            "label": "jacoco-maven-plugin",
            "detect": [r"<artifactId>\s*jacoco-maven-plugin\s*</artifactId>"],
            "run": "jacoco:report",
        },
    },
    "gradle": {
        "checkstyle": {
            "label": "plugin 'checkstyle'",
            "detect": _gradle_id_patterns("checkstyle"),
            "run": "checkstyleMain",
        },
        "pmd": {
            "label": "plugin 'pmd'",
            "detect": _gradle_id_patterns("pmd"),
            "run": "pmdMain",
        },
        "jacoco": {
            "label": "plugin 'jacoco'",
            "detect": _gradle_id_patterns("jacoco"),
            "run": "jacocoTestReport",
        },
        "spotbugs": {
            "label": "plugin 'com.github.spotbugs'",
            "detect": (
                _gradle_id_patterns("com.github.spotbugs")
                + _gradle_id_patterns("spotbugs")
                + [
                    r"com\.github\.spotbugs(?:\.snom)?[:/]"
                    r"spotbugs-gradle-plugin",
                ]
            ),
            "run": "spotbugsMain",
            "managed": False,
        },
    },
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def state_root():
    base = os.environ.get("OPENCODE_SOFTWARE_FACTORY_STATE")
    if not base:
        base = os.environ.get(
            "XDG_STATE_HOME", str(Path.home() / ".local/state")
        )
    root = Path(base).expanduser() / "opencode-software-factory"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"El directorio de estado de la fábrica no es seguro: {root}")
    os.chmod(root, 0o700)
    return root


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
        current = ROOT
        for part in Path(prefix).parts:
            current = current / part
            if current.is_symlink():
                raise ValueError(f"No se admiten enlaces simbólicos en las fuentes: {current}")
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
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        try:
            path.unlink()
        except OSError:
            pass
        raise


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

                # Exclusivo y sin seguir symlinks; registra inode antes de escribir
                # para que incluso un write parcial pueda revertirse.
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(dest, flags, 0o644)
                info = os.fstat(fd)
                created.append((dest, info.st_dev, info.st_ino, data))
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                    f.flush()
                    os.fsync(f.fileno())

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
            for path, device, inode, expected_data in reversed(created):
                try:
                    info = path.lstat()
                    if path.is_symlink() or (info.st_dev, info.st_ino) != (device, inode):
                        continue
                    current_data = path.read_bytes()
                    # Delete only a complete or partial prefix written by this transaction.
                    if expected_data.startswith(current_data):
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
            check_ancestors(target, rel)
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
            fd, temp_name = tempfile.mkstemp(prefix=f".{manifest.name}.", suffix=".tmp", dir=manifest.parent)
            temp = Path(temp_name)
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump({**record, "files": retained}, f, indent=2, ensure_ascii=False)
                    f.write("\n")
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(temp, manifest)
            finally:
                try:
                    temp.unlink()
                except FileNotFoundError:
                    pass
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
    """Comprueba el registro efectivo de agentes en OpenCode V2."""
    import shutil
    import subprocess
    import sys

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

    binary = (
        os.environ.get("OPENCODE_BIN")
        or shutil.which("opencode")
        or str(Path.home() / ".opencode" / "bin" / "opencode")
    )
    if not Path(binary).is_file() or not os.access(binary, os.X_OK):
        print(
            "ERROR: no se encontró un ejecutable OpenCode. "
            "Define OPENCODE_BIN o instala ~/.opencode/bin/opencode."
        )
        return 1

    verifier = ROOT / "scripts" / "verify-opencode-agents.py"
    try:
        proc = subprocess.run(
            [
                sys.executable,
                str(verifier),
                "--project",
                str(target),
                "--binary",
                binary,
            ],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        print("ERROR: la verificación aislada de agentes superó los 60 segundos.")
        return 1

    if proc.stdout:
        print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="")
    if proc.returncode != 0:
        print(f"\nDoctor: la fábrica no está lista en este proyecto (código {proc.returncode}).")
        return 2

    print("\nDoctor: la fábrica funciona en este proyecto.")
    return 0



def _mask_xml_comments(text):
    """Enmascara los comentarios XML conservando offsets y saltos de línea.

    Así las posiciones encontradas sobre el texto enmascarado siguen siendo
    válidas sobre el texto original.
    """
    def repl(match):
        return "".join(
            "\n" if char == "\n" else " " for char in match.group(0)
        )

    return re.sub(r"<!--.*?-->", repl, text, flags=re.S)


def _mask_groovy_comments(text):
    """Enmascara comentarios /* */ y líneas // de Groovy/Kotlin (offsets íntegros)."""
    def repl(match):
        return "".join(
            "\n" if char == "\n" else " " for char in match.group(0)
        )

    text = re.sub(r"/\*.*?\*/", repl, text, flags=re.S)
    lines = []
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\n")
        ending = line[len(body):]
        if body.lstrip().startswith("//"):
            lines.append(" " * len(body) + ending)
        else:
            lines.append(line)
    return "".join(lines)


def _mask_xml_blocks(text, tags):
    """Enmascara el interior de los bloques `tags` conservando offsets.

    Sustituye cada bloque por espacios de la misma longitud, de modo que
    las posiciones halladas sobre el texto enmascarado siguen valiendo para
    el original. Un bloque sin cerrar se deja intacto (no se enmascara).
    """
    for tag in tags:
        open_re = re.compile(rf"<{tag}(\s[^>]*)?>")
        close_tag = f"</{tag}>"
        while True:
            block = open_re.search(text)
            if block is None:
                break
            close = text.find(close_tag, block.end())
            if close < 0:
                break
            end = close + len(close_tag)
            text = text[:block.start()] + " " * (end - block.start()) + text[end:]
    return text


def _maven_scan_text(text):
    """Texto de un pom apto para detectar plugins activos.

    Ignora comentarios y el interior de <pluginManagement>, <profiles>,
    <reporting>, <dependencies> y <dependencyManagement>: un plugin declarado
    solo ahí no está activo en el build (los perfiles además pueden estar
    inactivos y una <dependency> no hace que Maven ejecute el plugin).
    """
    text = _mask_xml_comments(text)
    return _mask_xml_blocks(
        text,
        (
            "dependencyManagement",
            "dependencies",
            "pluginManagement",
            "profiles",
            "reporting",
        ),
    )


def _gradle_scan_text(text):
    """Texto de un build.gradle apto para detectar plugins activos."""
    return _mask_groovy_comments(text)


def _quality_detect(tool, text):
    """Devuelve {plugin: bool} según el texto del build (comentarios ignorados)."""
    scan = _maven_scan_text(text) if tool == "maven" else _gradle_scan_text(text)
    detected = {}
    for name, spec in QUALITY_PLUGINS[tool].items():
        detected[name] = any(
            re.search(pattern, scan) for pattern in spec["detect"]
        )
    return detected


def _quality_sections(template_text):
    """Separa la plantilla en secciones por id (marcas [[quality:id]]).

    Cada sección incluye su marca de apertura Y la de cierre
    `[[quality:end]]`, para que el fragmento inyectado quede con el mismo
    formato de la plantilla (no quedan marcadores sueltos).
    """
    sections = {}
    current = None
    lines = []
    for line in template_text.splitlines(keepends=True):
        match = QUALITY_MARKER_RE.match(line.rstrip("\n"))
        if match:
            name = match.group(1)
            if name == "end":
                if current is not None:
                    lines.append(line)
                    sections[current] = "".join(lines)
                current = None
                lines = []
                continue
            current = name
            lines = [line]
            continue
        if current is not None:
            lines.append(line)
    return sections


def _maven_inject(masked, raw, fragments):
    """Inserta fragmentos en el pom. Devuelve (texto, None) o (None, motivo).

    `masked` es el texto con comentarios enmascarado (mismos offsets que
    `raw`), de modo que un <build> comentado nunca recibe la inyección.
    """
    if "</project>" not in masked:
        return None, "no se encuentra la etiqueta </project>"
    if re.search(r"<build\s*/>", masked):
        return None, "la forma abreviada <build/> es ambigua"

    build = re.search(r"<build(\s[^>]*)?>", masked)
    profiles = re.search(r"<profiles(\s[^>]*)?>", masked)
    if build is None and profiles is not None:
        return None, "no hay <build> y existe <profiles>, posición ambigua"
    if build is not None and profiles is not None:
        if profiles.start() < build.start():
            # ¿El primer <build> cae DENTRO del bloque <profiles>, o es el
            # <build> del proyecto que viene después de </profiles>?
            profiles_end = masked.find("</profiles>", profiles.end())
            if profiles_end < 0 or build.start() < profiles_end:
                return None, "el primer <build> aparece dentro de <profiles>"
            return None, (
                "`<profiles>` precede a `<build>`: posición ambigua, "
                "no se modifica"
            )

    block = "".join(fragments)

    if build is None:
        # Sin <build>: se añade uno nuevo antes de <reporting>/<profiles> o
        # antes del cierre del proyecto, respetando el orden del modelo.
        anchors = [
            pos for pos in (
                masked.find("<reporting"),
                masked.find("<profiles"),
            ) if pos >= 0
        ]
        insert_at = min(anchors) if anchors else masked.rfind("</project>")
        new_block = "<build>\n<plugins>\n" + block + "</plugins>\n</build>\n"
        return raw[:insert_at] + new_block + raw[insert_at:], None

    end_build = masked.find("</build>", build.end())
    if end_build < 0:
        return None, "no se encuentra </build> que cierre el primer <build>"
    region = masked[build.end():end_build]

    # El <plugins> de <pluginManagement> no sirve como punto de inserción:
    # se enmascara su interior (mismo mecanismo que _maven_scan_text) para
    # dar con el <plugins> real del <build>, que puede aparecer ANTES de
    # <pluginManagement> (crear otro <plugins> violaría el XSD de Maven,
    # donde <build> admite como máximo uno).
    management = re.search(r"<pluginManagement(\s[^>]*)?>", region)
    if management is not None:
        close = region.find("</pluginManagement>", management.end())
        if close < 0:
            return None, "<pluginManagement> sin cerrar"

    scan = _maven_scan_text(region)
    # La forma auto-cerrada <plugins/> (con o sin espacio antes de la barra)
    # también es un <plugins>: si no se reconoce, la rama de abajo crearía un
    # SEGUNDO <plugins> y violaría el XSD de Maven (máximo uno por <build>).
    plugins = re.search(r"<plugins(\s[^>]*)?/?>", scan)
    if plugins is not None:
        if plugins.group(0).endswith("/>"):
            return None, "`<plugins/>` vacío: la inyección no sería segura"
        start = plugins.end()
        close = scan.find("</plugins>", start)
        if close < 0:
            return None, "el <plugins> del build no está cerrado"
        insert_at = build.end() + close
    else:
        # <build> sin <plugins> propio: se crea UNO SOLO, delante de
        # <pluginManagement> (o al final del build si no existe).
        if management is not None:
            insert_at = build.end() + management.start()
        else:
            insert_at = end_build
        block = "<plugins>\n" + block + "</plugins>\n"

    return raw[:insert_at] + block + raw[insert_at:], None


def _gradle_inject(raw, fragments):
    """Añade los fragmentos al final del build de Gradle."""
    text = raw if raw.endswith("\n") else raw + "\n"
    return text + "\n" + "".join(fragments)


def _xml_is_well_formed(text):
    """Valida que el pom siga siendo XML legible antes de escribirlo."""
    import xml.etree.ElementTree as ET

    try:
        ET.fromstring(text)
    except ET.ParseError:
        return False
    return True


def _backup_build_file(build_file, data=None):
    """Copia el build a un directorio de estado privado, con creación exclusiva."""
    import time

    backup_dir = state_root() / "quality"
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if backup_dir.is_symlink() or not backup_dir.is_dir():
        raise ValueError(f"Directorio de respaldos inseguro: {backup_dir}")
    os.chmod(backup_dir, 0o700)
    payload = build_file.read_bytes() if data is None else data
    stamp = time.strftime("%Y%m%d-%H%M%S")
    counter = 0
    while True:
        suffix = f"-{counter}" if counter else ""
        dest = backup_dir / f"{build_file.name}.{stamp}{suffix}.bak"
        try:
            fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            break
        except FileExistsError:
            counter += 1
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
    except Exception:
        try:
            dest.unlink()
        except OSError:
            pass
        raise
    return dest


def _atomic_replace_build_file(build_file, original_text, new_text):
    """Reemplaza un build file sin seguir symlinks y solo si no cambió desde la lectura."""
    if build_file.is_symlink():
        raise ValueError(f"El archivo de build se convirtió en enlace simbólico: {build_file}")
    original_info = build_file.stat(follow_symlinks=False)
    if build_file.read_text(encoding="utf-8") != original_text:
        raise ValueError(f"El archivo cambió durante la operación; no se sobrescribió: {build_file}")
    fd, temp_name = tempfile.mkstemp(prefix=f".{build_file.name}.", suffix=".tmp", dir=build_file.parent)
    temp = Path(temp_name)
    try:
        os.fchmod(fd, original_info.st_mode & 0o777)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(new_text)
            f.flush()
            os.fsync(f.fileno())
        current_info = build_file.stat(follow_symlinks=False)
        if build_file.is_symlink() or (current_info.st_dev, current_info.st_ino) != (original_info.st_dev, original_info.st_ino):
            raise ValueError(f"El archivo fue reemplazado durante la operación; no se sobrescribió: {build_file}")
        if build_file.read_text(encoding="utf-8") != original_text:
            raise ValueError(f"El archivo cambió durante la operación; no se sobrescribió: {build_file}")
        os.replace(temp, build_file)
        directory_fd = os.open(build_file.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _quality_command(kind, build_file, goal):
    """Comando real para ejecutar una meta en el proyecto detectado."""
    if kind == "maven":
        base = "./mvnw" if (build_file.parent / "mvnw").is_file() else "mvn"
        return f"{base} -B {goal}"
    base = "./gradlew" if (build_file.parent / "gradlew").is_file() else "gradle"
    return f"{base} {goal}"


def _detect_quality_build(target):
    """Devuelve (kind, build_file): maven | gradle | gradle-kts | none | ambiguo."""
    candidates = (
        target / "pom.xml",
        target / "build.gradle",
        target / "build.gradle.kts",
    )
    linked = [path for path in candidates if path.is_symlink()]
    if linked:
        return "unsafe-symlink", linked[0]
    found = [path for path in candidates if path.is_file()]
    if not found:
        return "none", None
    if len(found) > 1:
        return "ambiguo", None
    only = found[0]
    if only.name == "pom.xml":
        return "maven", only
    if only.name.endswith(".kts"):
        return "gradle-kts", only
    return "gradle", only


def quality(raw_target, apply_changes=False):
    """Informa (y con --apply, inyecta) los plugins de calidad del proyecto.

    Nunca modifica nada sin --apply; sin respaldo previo no escribe; la
    segunda pasada con --apply no cambia el fichero (idempotencia).
    """
    try:
        target = resolve_target(raw_target)
    except Exception as exc:
        print(f"ERROR: {exc}")
        return 1

    kind, build_file = _detect_quality_build(target)
    if kind == "unsafe-symlink":
        print(f"ERROR: no se modifica un archivo de build que sea enlace simbólico: {build_file}")
        return 2
    if kind == "none":
        print(f"ERROR: no hay pom.xml, build.gradle ni build.gradle.kts en {target}")
        print("'quality' solo funciona sobre un proyecto Maven o Gradle.")
        return 1
    if kind == "ambiguo":
        names = sorted(
            path.name
            for path in (
                target / "pom.xml",
                target / "build.gradle",
                target / "build.gradle.kts",
            )
            if path.is_file()
        )
        print(f"Build ambiguo en {target}: conviven {', '.join(names)}.")
        print(
            "No puedo decidir dónde inyectar; no se modifica nada. Añade "
            "los plugins a mano desde templates/quality/."
        )
        return 2

    tool = "maven" if kind == "maven" else "gradle"
    try:
        raw = build_file.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        print(
            f"ERROR: {build_file} no es UTF-8; no se puede analizar con "
            "seguridad. No se modificó nada."
        )
        return 2
    except OSError as exc:
        print(f"ERROR: no se pudo leer {build_file}: {exc}")
        return 1

    specs = QUALITY_PLUGINS[tool]
    detected = _quality_detect(tool, raw)
    missing = [name for name in specs if not detected[name]]
    present = [name for name in specs if detected[name]]
    # Los no gestionables (SpotBugs en Gradle) se informan, pero no se
    # inyectan ni cuentan para el código de salida.
    actionable = [name for name in missing if specs[name].get("managed", True)]

    build_label = {
        "maven": "Maven",
        "gradle": "Gradle (Groovy DSL)",
        "gradle-kts": "Gradle (Kotlin DSL)",
    }[kind]
    print(f"Build detectado: {build_label} ({build_file})")
    print("Plugins de calidad:")
    for name, spec in specs.items():
        state = "PRESENTE" if detected[name] else "FALTA"
        command = _quality_command(kind, build_file, spec["run"])
        if spec.get("managed", True):
            print(f"  [{state:<8}] {spec['label']} -> {command}")
        else:
            print(
                f"  [{state:<8}] {spec['label']} -> {command} "
                "(solo informe, no se inyecta)"
            )

    full = _quality_command(kind, build_file, "verify" if tool == "maven" else "check")
    print(f"Verificación completa: {full}")
    if tool == "gradle":
        print(
            "NOTA: SpotBugs en Gradle requiere el plugin del Portal "
            "(com.github.spotbugs) y se añade aparte; esta fábrica lo "
            "informa pero no lo inyecta."
        )

    if not apply_changes:
        if not actionable:
            print("\nSin cambios: todo lo gestionable ya está presente. "
                  "No se modificó nada.")
            return 0
        print(
            f"\nFalta inyectar: {', '.join(actionable)}. "
            "No se modificó nada."
        )
        print(
            "Ejecuta de nuevo con --apply para inyectarlos con respaldo "
            f"previo: python3 scripts/factory.py quality {raw_target} --apply"
        )
        return 2

    if kind == "gradle-kts":
        if not actionable:
            print("\nSin cambios: todo lo gestionable ya está presente.")
            return 0
        print(
            "\nbuild.gradle.kts: la plantilla está en Groovy (build.gradle); "
            "no se modifica nada. Añade los bloques a mano desde "
            "templates/quality/gradle-quality.gradle."
        )
        return 2

    if not actionable:
        print(
            "\nSin cambios: todos los plugins gestionables ya estaban "
            "presentes. No se creó respaldo porque no hubo modificaciones."
        )
        return 0

    template_path = ROOT / QUALITY_TEMPLATES[tool]
    if not template_path.is_file():
        print(f"ERROR: falta la plantilla {template_path}")
        return 1
    sections = _quality_sections(template_path.read_text(encoding="utf-8"))
    fragments = []
    for name in actionable:
        if name not in sections:
            print(
                f"ERROR: la plantilla {template_path} no tiene la sección "
                f"'{name}'; no se modificó nada."
            )
            return 1
        fragments.append(sections[name])

    if tool == "maven":
        if not _xml_is_well_formed(raw):
            print(
                "\nEl pom.xml no es XML bien formado; no se puede validar "
                "la inyección. No se modificó nada; añade los plugins a "
                "mano desde templates/quality/maven-quality-plugins.xml."
            )
            return 2
        new_text, reason = _maven_inject(_mask_xml_comments(raw), raw, fragments)
        if new_text is None:
            print(f"\nNo se puede inyectar con seguridad: {reason}.")
            print(
                "No se modificó nada; añade los plugins a mano desde "
                "templates/quality/maven-quality-plugins.xml."
            )
            return 2
        if not _xml_is_well_formed(new_text):
            print(
                "\nLa inyección dejaría el pom.xml mal formado; posición "
                "ambigua. No se modificó nada; añade los plugins a mano "
                "desde templates/quality/maven-quality-plugins.xml."
            )
            return 2
    else:
        new_text = _gradle_inject(raw, fragments)

    # Verificación previa a escribir: si tras la inyección algún plugin
    # sigue sin detectarse, el texto quedó en una posición ambigua.
    still_missing = [
        name
        for name, ok in _quality_detect(tool, new_text).items()
        if not ok and specs[name].get("managed", True)
    ]
    if still_missing:
        print(
            "\nLa inyección no dejaría los plugins activos "
            f"({', '.join(still_missing)}); posición ambigua. "
            "No se modificó nada."
        )
        return 2

    try:
        original_bytes = raw.encode("utf-8")
        backup = _backup_build_file(build_file, original_bytes)
        _atomic_replace_build_file(build_file, raw, new_text)
    except Exception as exc:
        print(f"\nERROR: no se pudo aplicar el cambio de forma segura: {exc}. El build no se sobrescribió.")
        return 2
    print(f"\nRespaldo del build: {backup}")
    print(f"Plugins inyectados: {', '.join(actionable)}")
    if present:
        print(f"Plugins que ya estaban (intactos): {', '.join(present)}")
    print(f"Comprueba con: {full}")
    return 0


def self_test():
    # Pruebas aisladas: no tocan tus proyectos ni el estado habitual del usuario.
    import tempfile
    import xml.etree.ElementTree as ET

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
            assert (project / ".opencode/mcp/factory-filesystem.mjs").is_file()
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
            assert not (project / ".opencode/mcp/factory-filesystem.mjs").exists()
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

            # --- quality: detección, inyección e idempotencia (sin red) ---

            # Caso: quality sobre Maven CON los 4 plugins → 0 y no toca nada.
            q_full = base / "quality-maven-full"
            q_full.mkdir()
            q_full_pom = q_full / "pom.xml"
            q_full_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>full</artifactId>\n"
                "  <build>\n    <plugins>\n"
                + "".join(
                    "      <plugin><artifactId>%s</artifactId></plugin>\n"
                    % artifact
                    for artifact in (
                        "maven-checkstyle-plugin",
                        "maven-pmd-plugin",
                        "spotbugs-maven-plugin",
                        "jacoco-maven-plugin",
                    )
                )
                + "    </plugins>\n  </build>\n</project>\n"
            )
            full_before = q_full_pom.read_bytes()
            assert quality(q_full) == 0
            assert q_full_pom.read_bytes() == full_before
            print("PASS: quality sin --apply sobre Maven completo → 0 sin modificar")

            # Caso: quality sobre Maven SIN plugins → informa 2 sin tocar...
            q_maven = base / "quality-maven"
            q_maven.mkdir()
            q_maven_pom = q_maven / "pom.xml"
            q_maven_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>vacio</artifactId>\n"
                "</project>\n"
            )
            maven_before = q_maven_pom.read_bytes()
            assert quality(q_maven) == 2
            assert q_maven_pom.read_bytes() == maven_before
            # ...y con --apply inyecta los 4 y crea el respaldo.
            assert quality(q_maven, apply_changes=True) == 0
            maven_text = q_maven_pom.read_text()
            for artifact in (
                "maven-checkstyle-plugin",
                "maven-pmd-plugin",
                "spotbugs-maven-plugin",
                "jacoco-maven-plugin",
            ):
                assert artifact in maven_text, artifact
            assert "<build>" in maven_text
            backups = list((state_root() / "quality").glob("pom.xml.*.bak"))
            assert backups, "quality no creó el respaldo del pom"
            print("PASS: quality --apply inyecta Maven con respaldo previo")

            # Caso: idempotencia → el segundo --apply no cambia el fichero.
            maven_after = q_maven_pom.read_bytes()
            assert quality(q_maven, apply_changes=True) == 0
            assert q_maven_pom.read_bytes() == maven_after
            assert quality(q_maven) == 0
            print("PASS: quality --apply es idempotente en Maven")

            # Caso: Gradle parcial (solo jacoco) → inyecta lo que falta sin
            # duplicar lo presente.
            q_gradle = base / "quality-gradle"
            q_gradle.mkdir()
            q_gradle_build = q_gradle / "build.gradle"
            q_gradle_build.write_text(
                "plugins {\n    id 'java'\n    id 'jacoco'\n}\n"
            )
            gradle_before = q_gradle_build.read_bytes()
            assert quality(q_gradle) == 2
            assert q_gradle_build.read_bytes() == gradle_before
            assert quality(q_gradle, apply_changes=True) == 0
            gradle_text = q_gradle_build.read_text()
            assert "apply plugin: 'checkstyle'" in gradle_text
            assert "apply plugin: 'pmd'" in gradle_text
            assert "apply plugin: 'jacoco'" not in gradle_text
            gradle_after = q_gradle_build.read_bytes()
            assert quality(q_gradle, apply_changes=True) == 0
            assert q_gradle_build.read_bytes() == gradle_after
            assert quality(q_gradle) == 0
            print("PASS: quality detecta e inyecta en Gradle sin duplicar plugins")

            # Caso: Kotlin DSL → la plantilla es Groovy, no se toca nada.
            q_kts = base / "quality-kts"
            q_kts.mkdir()
            q_kts_build = q_kts / "build.gradle.kts"
            q_kts_build.write_text("plugins {\n    java\n}\n")
            kts_before = q_kts_build.read_bytes()
            assert quality(q_kts, apply_changes=True) == 2
            assert q_kts_build.read_bytes() == kts_before
            print("PASS: quality no toca build.gradle.kts")

            # Caso: pom.xml + build.gradle conviven → ambiguo, solo informa.
            q_amb = base / "quality-ambigua"
            q_amb.mkdir()
            (q_amb / "pom.xml").write_text("<project></project>\n")
            (q_amb / "build.gradle").write_text("plugins { id 'java' }\n")
            amb_pom = (q_amb / "pom.xml").read_bytes()
            amb_build = (q_amb / "build.gradle").read_bytes()
            assert quality(q_amb) == 2
            assert quality(q_amb, apply_changes=True) == 2
            assert (q_amb / "pom.xml").read_bytes() == amb_pom
            assert (q_amb / "build.gradle").read_bytes() == amb_build
            print("PASS: quality ante builds ambiguos solo informa")

            # Caso: <build> existente SIN <plugins> (solo pluginManagement)
            # → la inyección envuelve los fragmentos en <plugins> y el pom
            # sigue siendo XML bien formado.
            q_pm = base / "quality-pom-management"
            q_pm.mkdir()
            q_pm_pom = q_pm / "pom.xml"
            q_pm_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>gestion</artifactId>\n"
                "  <build>\n    <pluginManagement>\n      <plugins>\n"
                "        <plugin><artifactId>maven-antrun-plugin</artifactId></plugin>\n"
                "      </plugins>\n    </pluginManagement>\n  </build>\n"
                "</project>\n"
            )
            assert quality(q_pm) == 2
            assert quality(q_pm, apply_changes=True) == 0
            pm_text = q_pm_pom.read_text()
            assert "maven-checkstyle-plugin" in pm_text
            # <plugin> debe quedar dentro de <plugins> y el XML ser válido.
            ET.fromstring(pm_text)
            assert pm_text.index("<plugins>") < pm_text.index(
                "maven-checkstyle-plugin"
            )
            assert quality(q_pm) == 0
            print("PASS: quality envuelve en <plugins> un <build> que no lo tenía")

            # Caso: <plugins> ANTES de <pluginManagement> dentro de <build>.
            # La inyección va al <plugins> existente y NO se crea un segundo
            # (el XSD de Maven admite como máximo un <plugins> en <build>).
            q_order = base / "quality-pom-orden"
            q_order.mkdir()
            q_order_pom = q_order / "pom.xml"
            q_order_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>orden</artifactId>\n"
                "  <build>\n    <plugins>\n"
                "      <plugin><groupId>org.apache.maven.plugins</groupId>"
                "<artifactId>maven-compiler-plugin</artifactId></plugin>\n"
                "    </plugins>\n    <pluginManagement>\n      <plugins>\n"
                "        <plugin>"
                "<artifactId>maven-antrun-plugin</artifactId></plugin>\n"
                "      </plugins>\n    </pluginManagement>\n  </build>\n"
                "</project>\n"
            )
            assert quality(q_order) == 2
            assert quality(q_order, apply_changes=True) == 0
            order_text = q_order_pom.read_text()
            # (a) EXACTAMENTE UN <plugins> como hijo directo de <build> (el
            #     de <pluginManagement> no cuenta: son hermanos inválidos).
            # (b) XML bien formado.
            order_root = ET.fromstring(order_text)
            ns = "{http://maven.apache.org/POM/4.0.0}"
            order_build = order_root.find(f"{ns}build")
            order_plugins = order_build.findall(f"{ns}plugins")
            assert len(order_plugins) == 1, len(order_plugins)
            order_management = order_build.find(f"{ns}pluginManagement")
            assert order_management is not None
            assert len(order_management.findall(f"{ns}plugins")) == 1
            # Ningún <plugins> suelto fuera de esas dos posiciones.
            assert len(order_root.findall(f"{ns}plugins")) == 0
            assert order_text.count("<plugins>") == 2, order_text
            # (c) todos los inyectados dentro de ese <plugins>.
            order_ids = [
                plugin.find(f"{ns}artifactId").text
                for plugin in order_plugins[0].findall(f"{ns}plugin")
            ]
            for artifact in (
                "maven-checkstyle-plugin",
                "maven-pmd-plugin",
                "spotbugs-maven-plugin",
                "jacoco-maven-plugin",
            ):
                assert artifact in order_ids, (artifact, order_ids)
            assert "maven-antrun-plugin" in order_text
            # (d) idempotencia en una segunda pasada.
            order_after = q_order_pom.read_bytes()
            assert quality(q_order, apply_changes=True) == 0
            assert q_order_pom.read_bytes() == order_after
            assert quality(q_order) == 0
            print(
                "PASS: quality con <plugins> antes de <pluginManagement> "
                "no duplica <plugins>"
            )

            # Caso: plugin solo en <profiles> o <reporting> → no está activo
            # en el build: se reporta FALTA y se inyecta en <build><plugins>.
            q_prof = base / "quality-pom-perfiles"
            q_prof.mkdir()
            q_prof_pom = q_prof / "pom.xml"
            q_prof_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>perfiles</artifactId>\n"
                "  <build>\n    <plugins>\n"
                "      <plugin><artifactId>maven-compiler-plugin</artifactId>"
                "</plugin>\n"
                "    </plugins>\n  </build>\n"
                "  <reporting>\n    <plugins>\n"
                "      <plugin><artifactId>maven-checkstyle-plugin</artifactId>"
                "</plugin>\n"
                "    </plugins>\n  </reporting>\n"
                "  <profiles>\n    <profile>\n      <id>estatica</id>\n"
                "      <build><plugins>\n"
                "        <plugin><artifactId>maven-pmd-plugin</artifactId>"
                "</plugin>\n"
                "      </plugins></build>\n"
                "    </profile>\n  </profiles>\n"
                "</project>\n"
            )
            prof_before = q_prof_pom.read_bytes()
            assert quality(q_prof) == 2
            assert q_prof_pom.read_bytes() == prof_before
            assert quality(q_prof, apply_changes=True) == 0
            prof_text = q_prof_pom.read_text()
            prof_root = ET.fromstring(prof_text)
            prof_build = prof_root.find(f"{ns}build")
            prof_ids = [
                plugin.find(f"{ns}artifactId").text
                for plugin in prof_build.find(f"{ns}plugins").findall(
                    f"{ns}plugin"
                )
            ]
            assert "maven-checkstyle-plugin" in prof_ids, prof_ids
            assert "maven-pmd-plugin" in prof_ids, prof_ids
            # El bloque <profiles> original queda intacto.
            assert "<profiles>" in prof_text
            assert quality(q_prof) == 0
            print(
                "PASS: quality ignora <profiles>/<reporting> y ahí falta "
                "se inyecta en <build>"
            )

            # --- Casos F1/F3/F2: inyección segura y alcance de PRESENTE ---

            # Caso F1: <build> con <plugins/> auto-cerrado (sin espacio
            # entre "plugins" y "/"). Si el regex no lo reconociera, la rama
            # de "sin <plugins>" crearía un SEGUNDO <plugins> y violaría el
            # XSD de Maven (máximo uno por <build>): se aborta con 2 y el
            # fichero queda byte a byte idéntico.
            q_selfclosed = base / "quality-pom-plugins-vacio"
            q_selfclosed.mkdir()
            q_sc_pom = q_selfclosed / "pom.xml"
            q_sc_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>plugins-vacio</artifactId>\n"
                "  <build>\n<plugins/>\n</build>\n"
                "</project>\n"
            )
            sc_before = q_sc_pom.read_bytes()
            assert quality(q_selfclosed, apply_changes=True) == 2
            assert q_sc_pom.read_bytes() == sc_before
            sc_text = q_sc_pom.read_text()
            assert sc_text.count("<plugins") == 1, sc_text
            ET.fromstring(sc_text)
            print(
                "PASS: quality --apply aborta ante <plugins/> auto-cerrado "
                "sin crear un segundo <plugins> (fichero intacto)"
            )

            # Caso F3a: <profiles> precede a <build> y NO hay ningún
            # <build> dentro de <profiles>: el motivo informado ya no afirma
            # lo falso; la inyección se abstiene y el pom queda intacto.
            q_pf_first = base / "quality-pom-perfiles-primero"
            q_pf_first.mkdir()
            q_pf_first_pom = q_pf_first / "pom.xml"
            q_pf_first_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>perfiles-primero</artifactId>\n"
                "  <profiles>\n    <profile>\n      <id>dev</id>\n"
                "    </profile>\n  </profiles>\n"
                "  <build>\n    <plugins>\n"
                "      <plugin><artifactId>maven-compiler-plugin</artifactId>"
                "</plugin>\n"
                "    </plugins>\n  </build>\n"
                "</project>\n"
            )
            pf_first_before = q_pf_first_pom.read_bytes()
            assert quality(q_pf_first) == 2
            assert quality(q_pf_first, apply_changes=True) == 2
            assert q_pf_first_pom.read_bytes() == pf_first_before
            print(
                "PASS: <profiles> antes de <build> sin build interno → 2 y "
                "pom intacto (mensaje ajustado)"
            )

            # Caso F3b: el primer <build> cae SÍ dentro de <profiles> → se
            # rechaza expresamente; nunca se inyecta en el build de un perfil.
            q_pf_inner = base / "quality-pom-build-en-perfil"
            q_pf_inner.mkdir()
            q_pf_inner_pom = q_pf_inner / "pom.xml"
            q_pf_inner_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>build-en-perfil</artifactId>\n"
                "  <profiles>\n    <profile>\n      <id>dev</id>\n"
                "      <build>\n        <plugins>\n"
                "          <plugin><artifactId>maven-compiler-plugin</artifactId>"
                "</plugin>\n"
                "        </plugins>\n      </build>\n"
                "    </profile>\n  </profiles>\n"
                "</project>\n"
            )
            pf_inner_before = q_pf_inner_pom.read_bytes()
            assert quality(q_pf_inner, apply_changes=True) == 2
            assert q_pf_inner_pom.read_bytes() == pf_inner_before
            print(
                "PASS: el primer <build> dentro de <profiles> se rechaza sin "
                "modificar nada"
            )

            # Caso F2: un plugin citado SOLO como <dependency> no cuenta como
            # PRESENTE (su bloque se enmascara); los otros tres sí lo están,
            # así que falta exactamente checkstyle y se inyecta en <build>.
            q_dep = base / "quality-pom-dependencia"
            q_dep.mkdir()
            q_dep_pom = q_dep / "pom.xml"
            q_dep_pom.write_text(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                "  <modelVersion>4.0.0</modelVersion>\n"
                "  <artifactId>solo-dependencia</artifactId>\n"
                "  <dependencies>\n    <dependency>\n"
                "      <groupId>org.apache.maven.plugins</groupId>\n"
                "      <artifactId>maven-checkstyle-plugin</artifactId>\n"
                "      <version>3.6.0</version>\n"
                "    </dependency>\n  </dependencies>\n"
                "  <build>\n    <plugins>\n"
                "      <plugin><artifactId>maven-pmd-plugin</artifactId></plugin>\n"
                "      <plugin><artifactId>spotbugs-maven-plugin</artifactId></plugin>\n"
                "      <plugin><artifactId>jacoco-maven-plugin</artifactId></plugin>\n"
                "    </plugins>\n  </build>\n"
                "</project>\n"
            )
            # Solo checkstyle falta: el resto ya está declarado en <build>.
            assert quality(q_dep) == 2
            assert quality(q_dep, apply_changes=True) == 0
            dep_root = ET.fromstring(q_dep_pom.read_text())
            dep_build = dep_root.find(f"{ns}build")
            dep_plugins = dep_build.findall(f"{ns}plugins")
            assert len(dep_plugins) == 1, len(dep_plugins)
            dep_ids = [
                plugin.find(f"{ns}artifactId").text
                for plugin in dep_plugins[0].findall(f"{ns}plugin")
            ]
            assert "maven-checkstyle-plugin" in dep_ids, dep_ids
            assert quality(q_dep) == 0
            print(
                "PASS: un plugin citado solo como <dependency> no cuenta como "
                "PRESENTE y se inyecta en <build><plugins>"
            )

            # Caso: pom que no es XML bien formado → no se toca nada.
            q_bad = base / "quality-pom-malformado"
            q_bad.mkdir()
            q_bad_pom = q_bad / "pom.xml"
            q_bad_pom.write_text("<project>\n  <artifactId>roto\n</project>\n")
            bad_before = q_bad_pom.read_bytes()
            assert quality(q_bad, apply_changes=True) == 2
            assert q_bad_pom.read_bytes() == bad_before
            print("PASS: quality no toca un pom que no es XML bien formado")

            # Caso: directorio sin build → código 1.
            q_none = base / "quality-sin-build"
            q_none.mkdir()
            assert quality(q_none) == 1
            print("PASS: quality sin build de proyecto → código 1")

            # A build file symlink must never cause quality to edit outside the project.
            quality_symlink = base / "quality-symlink"
            quality_symlink.mkdir()
            external_pom = base / "external-pom.xml"
            external_content = "<project><modelVersion>4.0.0</modelVersion></project>\n"
            external_pom.write_text(external_content, encoding="utf-8")
            os.symlink(external_pom, quality_symlink / "pom.xml")
            assert quality(quality_symlink, apply_changes=True) == 2
            assert external_pom.read_text(encoding="utf-8") == external_content
            print("PASS: quality rechaza pom.xml simbólico y conserva intacto el destino externo")

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

    p_quality = sub.add_parser(
        "quality",
        help="Informar e inyectar plugins de calidad Java (Maven/Gradle)",
        description=(
            "Detecta los plugins de calidad del proyecto (checkstyle, PMD, "
            "SpotBugs y JaCoCo) y muestra un informe con PRESENTE/FALTA por "
            "plugin y los comandos para ejecutarlos. Sin --apply no "
            "modifica ningún build: devuelve 0 si todo lo gestionable está "
            "presente, 2 si falta algo, si el build es ambiguo o si el "
            "fichero de build no está en UTF-8, y 1 si no hay build o la "
            "ruta es inválida. Con --apply respalda el fichero de build en "
            "~/.local/state/opencode-software-factory/quality/ e inyecta "
            "solo los plugins que falten (idempotente): devuelve 0 si todo "
            "quedó aplicado, 2 si algo no se pudo inyectar con seguridad o "
            "el build no es XML bien formado, y 1 en caso de error. "
            "SpotBugs en Gradle se informa pero no se inyecta y no afecta "
            "a los códigos de salida."
        ),
    )
    p_quality.add_argument("target", help="Ruta de un proyecto existente")
    p_quality.add_argument(
        "--apply",
        action="store_true",
        help="Inyectar los plugins que falten, con respaldo previo",
    )

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
    if args.command == "quality":
        return quality(args.target, args.apply)
    return self_test()


if __name__ == "__main__":
    raise SystemExit(main())
