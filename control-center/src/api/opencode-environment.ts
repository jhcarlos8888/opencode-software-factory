import { delimiter, dirname, join } from "node:path";
import { lstatSync, realpathSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";

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

/** Append the installed Bun toolchain without overriding existing commands. */
export function appendInstalledBunPath(path: string | undefined, home = homedir(), separator = delimiter): string {
  const entries = (path ?? "").split(separator).filter(Boolean);
  const bin = join(home, ".bun", "bin");
  const exe = join(bin, "bun");
  try {
    if (realpathSync(bin) !== bin || realpathSync(exe) !== exe || !lstatSync(exe).isFile()) return entries.join(separator);
    accessSync(exe, constants.X_OK);
    if (!entries.includes(bin)) entries.push(bin);
  } catch { /* Bun is optional. */ }
  return entries.join(separator);
}
