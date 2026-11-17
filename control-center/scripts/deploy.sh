#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
CONTROL_CENTER_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="factory-control-center.service"
BUILD_INFO="$CONTROL_CENTER_ROOT/dist-api/api/build-info.json"

cd "$CONTROL_CENTER_ROOT"
echo "== 1. Verificación integral antes del despliegue =="
npm run verify

echo "== 2. Compilar Control Center =="
npm run build

if [[ ! -s "$BUILD_INFO" ]]; then
  echo "ERROR: no se generó $BUILD_INFO" >&2
  exit 1
fi

EXPECTED_BUILD_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["buildId"])' "$BUILD_INFO")"
echo "Build esperado: $EXPECTED_BUILD_ID"

echo "== 3. Reiniciar servicio =="
systemctl --user restart "$SERVICE_NAME"

echo "== 4. Esperar API y comprobar fingerprint cargado =="
python3 - "$EXPECTED_BUILD_ID" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

expected = sys.argv[1]
url = "http://127.0.0.1:4141/api/health"
deadline = time.monotonic() + 35
last_error = "API no respondió"

while time.monotonic() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        build = payload.get("build") or {}
        runtime = build.get("runtimeBuildId")
        artifact = build.get("artifactBuildId")
        matches = build.get("runtimeMatchesDisk") is True
        if payload.get("status") == "ok" and matches and runtime == expected and artifact == expected:
            print("PASS: servicio activo y ejecutando exactamente el build compilado.")
            print(f"  Runtime: {runtime}")
            print(f"  Artefacto: {artifact}")
            print(f"  Generado: {build.get('generatedAt')}")
            raise SystemExit(0)
        last_error = f"runtime={runtime!r}, artefacto={artifact!r}, coincide={matches}"
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        last_error = str(error)
    time.sleep(1)

print("ERROR: el servicio no confirmó el fingerprint esperado en 35 segundos.", file=sys.stderr)
print(last_error, file=sys.stderr)
raise SystemExit(1)
PY

echo "== 5. Estado del servicio =="
systemctl --user --no-pager --full status "$SERVICE_NAME" | head -22
