import { delimiter, dirname } from "node:path";

/** Keep Node, OpenCode and the user's toolchain available to shell subprocesses. */
export function buildOpenCodeChildPath(
  runtimeBin: string,
  opencodeExecutable: string,
  inheritedPath: string | undefined,
  separator = delimiter
): string {
  const candidates = [runtimeBin, dirname(opencodeExecutable), ...(inheritedPath ?? "").split(separator)];
  return [...new Set(candidates.filter(Boolean))].join(separator);
}
