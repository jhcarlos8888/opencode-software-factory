import { useState, type ChangeEvent } from "react";
import { MAX_INSTRUCTION_FILE_BYTES } from "../api/work-instruction-limit";

export interface SelectedInstructionFile {
  name: string;
  content: string;
  byteLength: number;
}
export interface InstructionFileMetadata {
  id: string;
  threadId: string;
  roundNumber: number;
  name: string;
  sha256: string;
  byteLength: number;
  createdAt: string;
}

interface Props {
  id: string;
  disabled: boolean;
  selected: SelectedInstructionFile | null;
  reusableFiles: readonly InstructionFileMetadata[];
  reuseFileId: string;
  onSelected: (file: SelectedInstructionFile | null) => void;
  onReuseChange: (fileId: string) => void;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
}

export function InstructionTxtPicker({
  id, disabled, selected, reusableFiles, reuseFileId, onSelected, onReuseChange, onBusyChange, onError
}: Props) {
  const [busy, setBusy] = useState(false);

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!/\.txt$/i.test(file.name) || file.name.length > 120 ||
        /[/\\\x00-\x1f\x7f]/.test(file.name)) {
      onError("Selecciona un archivo .txt con un nombre válido.");
      return;
    }
    if (file.size > MAX_INSTRUCTION_FILE_BYTES) {
      onError("El archivo TXT supera 128 KiB. Divídelo en secciones antes de adjuntarlo.");
      return;
    }
    onBusyChange(true);
    setBusy(true);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffd]/.test(text)) {
        throw new Error("El archivo TXT está vacío o contiene datos binarios.");
      }
      onSelected({ name: file.name, content: text, byteLength: new TextEncoder().encode(text).byteLength });
      onReuseChange("");
      onError("");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "No fue posible leer el archivo. Usa codificación UTF-8.");
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <div className="instruction-txt-picker">
      <label htmlFor={id}>Archivo de instrucciones TXT (opcional)</label>
      <input id={id} type="file" accept=".txt,text/plain"
        disabled={disabled || busy} onChange={(event) => void onPick(event)} />
      <small>Hasta 128 KiB en UTF-8. El texto se conserva íntegro en el historial y se envía a cada agente de la ronda. Si es muy extenso para el modelo, divídelo en varias rondas.</small>
      {busy && <small role="status">Leyendo el archivo TXT...</small>}
      {selected && (
        <div className="instruction-txt-selection">
          <span><strong>{selected.name}</strong> · {selected.byteLength.toLocaleString("es-CO")} bytes · listo para enviar</span>
          <button type="button" disabled={disabled} onClick={() => onSelected(null)}>Quitar TXT</button>
        </div>
      )}
      {reusableFiles.length > 0 && (
        <div className="instruction-txt-reuse">
          <label htmlFor={id + "-reuse"}>O reutilizar un TXT de este proceso</label>
          <select id={id + "-reuse"} value={reuseFileId} disabled={disabled || busy}
            onChange={(event) => {
              onReuseChange(event.target.value);
              if (event.target.value) onSelected(null);
            }}>
            <option value="">No reutilizar archivo anterior</option>
            {reusableFiles.map((file) => (
              <option key={file.id} value={file.id}>
                {file.name} · ronda {file.roundNumber} · {file.byteLength.toLocaleString("es-CO")} bytes
              </option>
            ))}
          </select>
          <div className="instruction-txt-history">
            {reusableFiles.map((file) => (
              <a key={file.id} href={`/api/work-threads/${encodeURIComponent(file.threadId)}/instruction-files/${encodeURIComponent(file.id)}`}>
                Descargar {file.name} (ronda {file.roundNumber})
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
