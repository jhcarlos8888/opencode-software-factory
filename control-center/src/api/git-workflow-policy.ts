import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isSensitiveFilesystemPath } from "./filesystem-guards.js";

export interface GitRoundAuthority { instructions: string; agentId: string }
type Dict = Record<string, unknown>;
const obj = (v: unknown): Dict => v && typeof v === "object" && !Array.isArray(v) ? v as Dict : {};

/** Deliberately narrow: direct user instruction, not agent output, history,
 * task kind, or a quoted example. Negations/questions fail closed. */
export function gitRoundAuthorization(authority?: GitRoundAuthority): { commit: boolean; push: boolean } {
  const no = { commit: false, push: false };
  if (!authority || authority.agentId !== "implementer") return no;
  const text = authority.instructions.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (text.length > 1200 || /[?¿\x60"“”]|\b(?:no|sin|nunca|evita|prohibido|explica|explicame|como|ejemplo|comando|simula)\b/.test(text)) return no;
  const match = /^(?:(?:listo|bueno|perfecto|por favor|ahora|entonces|si)[,.:!\s]+)*(?:hagamos|haz|haga|hacer|realiza|realice|realizar|ejecuta|ejecute|ejecutar|crea|creemos|quiero(?: que hagas)?|necesito(?: que hagas)?)\s+(?:el\s+)?(?:git\s+)?(commit(?:\s+(?:y|e)\s+(?:git\s+)?push)?|push)\b/.exec(text);
  if (!match) return no;
  const operation = match[1]!;
  // Do not infer publication from a separately mentioned branch, URL or force.
  if (/\b(?:force|forzado|forzar|mirror|ramas?|branch|remotos?|origin|otro repositorio|master|main)\b|https?:\/\/|git@/.test(text)) return no;
  return { commit: operation.startsWith("commit"), push: operation.includes("push") };
}

function git(root: string, args: string[]): string | null {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    return execFileSync("git", ["--no-pager", "-C", root, ...args], {
      encoding: "utf8", timeout: 2500, maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"], env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    }).trimEnd();
  } catch { return null; }
}
function repositoryRoot(root: string): boolean {
  try { return isAbsolute(root) && realpathSync(root) === root && git(root, ["rev-parse", "--show-toplevel"]) === root; }
  catch { return false; }
}
function safePath(path: string): boolean {
  return path.length <= 512 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path)
    && !path.split("/").some(p => p === "." || p === ".." || p.startsWith("-"))
    && !isSensitiveFilesystemPath(path);
}
function regularPath(root: string, path: string): boolean {
  if (!safePath(path)) return false;
  try {
    const absolute = resolve(root, path);
    return realpathSync(absolute) === absolute && lstatSync(absolute).isFile();
  } catch { return false; }
}
function safeRemoteUrl(value: string): boolean {
  // Azure DevOps emits https://ORG@dev.azure.com/ORG/PROJECT/_git/REPO.
  // That exact duplicated public organization is not a credential. No other
  // HTTPS userinfo, passwords, custom helpers, query or fragment is admitted.
  const azure = /^https:\/\/([A-Za-z0-9][A-Za-z0-9-]{0,49})@dev\.azure\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,49})\/(?:[A-Za-z0-9._-]|%20)+\/_git\/(?:[A-Za-z0-9._-]|%20)+$/.exec(value);
  if (azure && azure[1]!.toLowerCase() === azure[2]!.toLowerCase()) return true;
  return /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._/-]+$/.test(value)
    || /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(value)
    || /^ssh:\/\/git@[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._/-]+$/.test(value);
}
export function safeGitRemoteInspection(root: string): boolean {
  if (!repositoryRoot(root)) return false;
  const output = git(root, ["remote", "-v"]);
  if (!output) return false;
  return output.split("\n").every(line => {
    const m = /^[A-Za-z0-9_.-]+\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line);
    return !!m && safeRemoteUrl(m[1]!);
  });
}
const remoteRef = /^origin\/(?:[A-Za-z0-9_][A-Za-z0-9_./#-]{0,150}|"[A-Za-z0-9_][A-Za-z0-9_./#-]{0,150}")$/;
function safeRef(value: string): boolean {
  const plain = value.replace(/"/g, "");
  return remoteRef.test(value) && !plain.includes("..") && !plain.includes("//") && !plain.endsWith("/") && !plain.endsWith(".lock");
}
// The diagnostics below expose only bounded Git metadata, not arbitrary
// configuration. Evaluate the same effective configuration internally and
// inspect the values without ever logging them.
function configRead(root: string, args: string[]): string | null {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const result = spawnSync("git", ["--no-pager", "-C", root, "config", ...args], {
    encoding: "utf8", timeout: 2500, maxBuffer: 1024 * 1024, env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.stderr) return null;
  if (result.status === 1 && result.stdout === "") return "";
  return result.status === 0 ? result.stdout : null;
}
function configEntries(root: string, pattern: string): [string,string][] | null {
  const raw = configRead(root, ["-z", "--get-regexp", pattern]);
  if (raw === null) return null;
  if (!raw) return [];
  if (!raw.endsWith("\0")) return null;
  const entries: [string,string][] = [];
  for (const row of raw.slice(0,-1).split("\0")) {
    const newline = row.indexOf("\n");
    if (newline < 1) return null;
    entries.push([row.slice(0,newline),row.slice(newline+1)]);
  }
  return entries;
}
function safeBranch(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_./#-]{0,150}$/.test(value) &&
    !value.includes("..") && !value.includes("//") && !value.endsWith("/") &&
    !value.split("/").some(p => p.startsWith(".") || p.endsWith(".lock"));
}
function safeHeadRef(value: string): boolean {
  return value.startsWith("refs/heads/") && safeBranch(value.slice(11));
}
function safeBranchConfig(root: string): boolean {
  const rows = configEntries(root, "^branch\\.");
  return rows !== null && rows.every(([key,value]) => {
    const match = /^branch\.(.+)\.(remote|merge|pushremote|rebase)$/.exec(key);
    if (!match || !safeBranch(match[1]!)) return false;
    if (match[2] === "merge") return safeHeadRef(value);
    if (match[2] === "rebase") return /^(?:true|false|merges|interactive)$/.test(value);
    return /^(?:\.|[A-Za-z0-9_-]{1,80})$/.test(value);
  });
}
function safeOriginConfig(root: string): boolean {
  const rows = configEntries(root, "^remote\\.origin\\.");
  return rows !== null && rows.every(([key,value]) => {
    if (key === "remote.origin.url" || key === "remote.origin.pushurl") return safeRemoteUrl(value);
    if (key === "remote.origin.fetch") return /^\+?refs\/heads\/\*:refs\/remotes\/origin\/\*$/.test(value) ||
      /^\+?refs\/heads\/[A-Za-z0-9_./#-]+:refs\/remotes\/origin\/[A-Za-z0-9_./#-]+$/.test(value);
    if (key === "remote.origin.mirror" || key === "remote.origin.prune" || key === "remote.origin.prunetags") return /^(?:true|false)$/.test(value);
    if (key === "remote.origin.tagopt") return /^(?:--tags|--no-tags)$/.test(value);
    return false;
  });
}
function safeOriginNetwork(root: string): boolean {
  // Only the existing origin, with a single effective HTTPS destination.
  // SSH/custom helpers, alternate uploadpack and arbitrary refspecs are not
  // part of this automatic network grant. Git uses existing authentication.
  const url = git(root, ["remote","get-url","--all","origin"]);
  if (!url || !url.startsWith("https://") || !safeRemoteUrl(url)) return false;
  const rows = configEntries(root, "^remote\\.origin\\.");
  if (rows === null || !safeOriginConfig(root)) return false;
  // A configured rewrite may redirect requests; require no rewrite rules.
  const rewrites = configEntries(root, "^url\\.");
  return rewrites !== null && rewrites.length === 0;
}
function safeLsRemote(command: string): boolean {
  if (/^git ls-remote (?:--heads )?origin(?: --verbose)?$/.test(command)) return true;
  const match = /^git ls-remote origin (?:'([^']+)'|([A-Za-z0-9_./#-]+))$/.exec(command);
  if (!match) return false;
  const ref = match[1] ?? match[2] ?? "";
  if (safeHeadRef(ref)) return true;
  // Quoted ref filtering is passed to Git, never expanded by the shell.
  return !!match[1] && /^refs\/heads\/\*[A-Za-z0-9_-]{1,80}\*$/.test(ref);
}
function safeDryFetch(command: string): boolean {
  const match = /^git fetch --dry-run origin (?:'([^']+)'|([A-Za-z0-9_./#-]+))$/.exec(command);
  return !!match && safeHeadRef(match[1] ?? match[2] ?? "");
}
/** Context-sensitive reads must be bound to the actual native command and
 * root; callers cannot infer safety from a provider's proposed save glob. */
export function isContextualGitInspection(command: string): boolean {
  return /^(?:git (?:config(?: |$)|remote(?: |$)|ls-remote(?: |$)|fetch(?: |$)))/.test(command);
}
export function isGitWorkflowInspection(command: string, root: string): boolean {
  if (command === "git show --stat --format=fuller HEAD" ||
      command === "git show --name-status --format='%H%n%P%n%s' HEAD" ||
      command === "git show --name-status --format='%H%n%P%n%an <%ae>%n%s' HEAD" ||
      command === "git show --stat --format='' HEAD" ||
      command === "git rev-parse --abbrev-ref '@{u}'" ||
      command === "git rev-parse --abbrev-ref --symbolic-full-name '@{u}'" ||
      command === "type -a git" || command === "git --exec-path" ||
      command === "git for-each-ref refs/remotes/origin --format='%(refname) %(objectname:short) %(committerdate:iso)'") return true;
  const count = /^git rev-list --left-right --count '(origin\/[^']+)\.\.\.HEAD'$/.exec(command);
  if (count && safeRef(count[1]!)) return true;
  const tracked = /^git ls-files (?:-- )?([A-Za-z0-9_./-]+)$/.exec(command);
  if (tracked && safePath(tracked[1]!)) return true;
  const reflog = /^git reflog show '([^']+)' --date=iso$/.exec(command);
  if (reflog && safeRef(reflog[1]!)) return true;
  const ref = /^(?:git log --oneline -[1235] |git rev-parse (?:HEAD )?)(origin\/.+?)(?: 2>\/dev\/null)?$/.exec(command);
  if (ref && safeRef(ref[1]!)) return true;
  if (!isContextualGitInspection(command) || !repositoryRoot(root)) return false;
  if (command === "git remote -v") return safeGitRemoteInspection(root);
  if (command === "git remote get-url --push origin" || command === "git remote get-url origin") {
    const url = git(root, ["remote","get-url",...(command.includes("--push")?["--push"]:[]),"origin"]);
    return !!url && safeRemoteUrl(url);
  }
  if (command === "git config --get push.default") {
    const result = configRead(root, ["--get","push.default"]);
    return result !== null && /^(?:|nothing|current|upstream|simple|matching)\n?$/.test(result);
  }
  if (command === "git config --get-regexp '^branch\\.'") return safeBranchConfig(root);
  if (command === "git config --get-regexp '^remote\\.origin\\.'") return safeOriginConfig(root);
  if (command === "git config --show-origin --get-regexp '^url\\.'") {
    const rows = configEntries(root, "^url\\.");
    // Empty output is harmless. Nonempty rewrites may embed tokens in keys
    // or values, and disclose external config paths. Never auto-return them.
    return rows !== null && rows.length === 0;
  }
  if (safeLsRemote(command)) return safeOriginNetwork(root);
  if (safeDryFetch(command)) {
    if (!safeOriginNetwork(root)) return false;
    // A dry run must not contact additional submodule remotes.
    for (const key of ["fetch.recurseSubmodules", "submodule.recurse"]) {
      const value = configRead(root, ["--get-all",key]);
      if (value === null || !/^(?:|false\n?|no\n?)$/.test(value)) return false;
    }
    return true;
  }
  return false;
}

function stagePaths(command: string): string[] | null {
  if (command.includes("\r")) return null;
  // Bash removes backslash + LF, not the surrounding whitespace.
  const text = command.replace(/\\\n/g, "").trim();
  if (!text.startsWith("git add ")) return null;
  const raw = text.slice(8).trim().replace(/^-- /, "");
  const parts = raw.split(/[ \t]+/);
  if (!parts.length || parts.length > 80) return null;
  const paths = parts.map(x => /^"[^"]+"$/.test(x) || /^'[^']+'$/.test(x) ? x.slice(1,-1) : x);
  return paths.every(safePath) ? paths : null;
}
function commitHeredoc(command: string): string | null {
  const match = /^git commit -m "\$\(cat <<'EOF'\n([\s\S]{1,6000})\nEOF\n\)"$/.exec(command);
  if (!match || /(?:^|\n)EOF(?:\n|$)|[\x00-\x08\x0b-\x1f\x7f]/.test(match[1]!)) return null;
  return "cat <<'EOF'\n" + match[1] + "\nEOF";
}
function isLiteralCommit(command: string): boolean {
  return /^git commit -m '(?:[^'\x00-\x1f]{1,1000})'$/.test(command)
    || /^git commit -m "[^"$\x60\\\x00-\x1f]{1,1000}"$/.test(command);
}
function indexSafe(root: string): boolean {
  const raw = git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
  if (!raw) return false;
  const staged = git(root, ["diff", "--cached", "--raw", "--no-renames", "-z"]);
  if (!staged) return false;
  // Only regular-file additions/modifications, never staged symlinks, gitlinks
  // or deletions. A working-tree file alone cannot prove the index mode.
  const entries = staged.split("\0").filter(Boolean);
  if (entries.length % 2 !== 0 || !entries.every((entry,i) =>
      i % 2 === 0 ? /^:[0-7]{6} 100(?:644|755) [0-9a-f]+ [0-9a-f]+ [AM]$/.test(entry)
      : regularPath(root,entry))) return false;
  return raw.split("\0").filter(Boolean).every(path => regularPath(root,path));
}
function pushSafe(root: string): boolean {
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"]);
  if (!branch || !safeRef("origin/" + branch)) return false;
  const config = (key: string): string | null => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const result = spawnSync("git", ["--no-pager", "-C", root, "config", "--get-all", key],
      { encoding: "utf8", timeout: 2500, maxBuffer: 1024 * 1024, env });
    if (result.status === 1 && !result.error && !result.stderr.trim()) return null;
    if (result.status !== 0 || result.error) throw new Error("No se pudo comprobar la configuración Git.");
    return result.stdout.trimEnd();
  };
  if (config("branch." + branch + ".remote") !== "origin" ||
      config("branch." + branch + ".merge") !== "refs/heads/" + branch) return false;
  for (const key of ["branch." + branch + ".pushRemote", "remote.pushDefault", "remote.origin.push",
    "remote.origin.receivepack", "remote.origin.vcs", "push.pushOption"]) {
    const val = config(key);
    if (val !== null) return false;
  }
  for (const key of ["remote.origin.mirror", "push.followTags"]) {
    const val = config(key);
    if (val !== null && val !== "false") return false;
  }
  const recurse = config("push.recurseSubmodules");
  if (recurse !== null && recurse !== "no") return false;
  const mode = config("push.default");
  if (mode !== null && mode !== "simple" && mode !== "upstream") return false;
  const fetch = git(root, ["remote", "get-url", "--all", "origin"]);
  const push = git(root, ["remote", "get-url", "--push", "--all", "origin"]);
  if (!fetch || push !== fetch || !safeRemoteUrl(fetch)) return false;
  const upstream = "refs/remotes/origin/" + branch;
  if (git(root, ["merge-base", "--is-ancestor", upstream, "HEAD"]) === null) return false;
  const paths = git(root, ["log", "-m", "--format=", "--name-only", "--no-renames", "-z", upstream + "..HEAD"]);
  const diff = git(root, ["diff", "--name-only", "--no-renames", "-z", upstream, "HEAD"]);
  return paths !== null && diff !== null && [paths,diff].every(value =>
    value.split("\0").filter(Boolean).every(safePath));
}

/** Match the concrete provider segments to the actual native tool command.
 * Only a bounded sequence of ;, && or || is allowed, no hidden shell pieces.
 * The sole nested resource accepted is the exact quoted commit heredoc. */
export function nativeGitCommandMatches(command: string, resources: string[]): boolean {
  if (command.length > 16000 || command.includes("\r") || resources.length > 12) return false;
  const flat = resources.filter((r,i) => !(i > 0 && commitHeredoc(resources[i-1]!) === r));
  let rest = command.trim();
  for (let i=0; i<flat.length; i++) {
    const segment = flat[i]!.trim();
    if (!rest.startsWith(segment)) return false;
    rest = rest.slice(segment.length);
    if (i < flat.length-1) {
      const sep = /^(?:[ \t]|\\\r?\n)*(?:&&|\|\||;|\r?\n)(?:[ \t\r\n]|\\\r?\n)*/.exec(rest);
      if (!sep) return false;
      rest = rest.slice(sep[0].length);
    }
  }
  return rest.trim() === "";
}

/** Resolve only a tool part from the matching native message and call ID.
 * Do not trust the model's report or the provider's suggested save patterns. */
export function findNativeGitToolInput(messages: unknown, request: Dict): Dict | null {
  const source = obj(request.source);
  if (source.type !== "tool" || typeof source.messageID !== "string" || typeof source.id !== "string") return null;
  const list = Array.isArray(messages) ? messages : obj(messages).data;
  if (!Array.isArray(list)) return null;
  for (const raw of list) {
    const m = obj(raw), info = obj(m.info);
    if ((info.id ?? m.id) !== source.messageID || (info.role ?? m.role ?? m.type) !== "assistant") continue;
    const parts = Array.isArray(m.parts) ? m.parts : m.content;
    if (!Array.isArray(parts)) continue;
    for (const rawPart of parts) {
      const part = obj(rawPart);
      if (part.type !== "tool" || (part.tool ?? part.name) !== "shell" ||
          ![part.id, part.callID, part.callId, part.toolCallId, part.toolCallID].includes(source.id)) continue;
      const state = obj(part.state ?? part);
      const input = obj(state.input);
      if (typeof input.command === "string") return input;
    }
  }
  return null;
}

export function assessAuthorizedGitWorkflow(resources: string[], root: string, authority: GitRoundAuthority | undefined,
  nativeInput: Dict | null, isSafeInspection: (value: string) => boolean): boolean {
  const auth = gitRoundAuthorization(authority);
  if ((!auth.commit && !auth.push) || !nativeInput || nativeInput.workdir !== root ||
      (nativeInput.cwd !== undefined && nativeInput.cwd !== root) || nativeInput.env !== undefined || nativeInput.environment !== undefined ||
      typeof nativeInput.command !== "string" || (nativeInput.dangerouslyDisableSandbox !== undefined && nativeInput.dangerouslyDisableSandbox !== false) ||
      !nativeGitCommandMatches(nativeInput.command, resources) || !repositoryRoot(root)) return false;
  let mutationCount = 0;
  for (let i=0; i<resources.length; i++) {
    const value = resources[i]!;
    if (isSafeInspection(value) || isGitWorkflowInspection(value, root)) continue;
    const paths = stagePaths(value);
    if (paths) {
      if (!auth.commit || !paths.every(path => regularPath(root,path))) return false;
      mutationCount++; continue;
    }
    const heredoc = commitHeredoc(value);
    if (heredoc || isLiteralCommit(value)) {
      if (!auth.commit || !indexSafe(root)) return false;
      if (heredoc && resources[i+1] === heredoc) i++;
      mutationCount++; continue;
    }
    if (value === "git push" || value === "git push 2>&1") {
      if (!auth.push) return false;
      try { if (!pushSafe(root)) return false; } catch { return false; }
      mutationCount++; continue;
    }
    return false;
  }
  // Do not approve add+commit+push in one request: validate repository state
  // independently immediately before every mutation.
  return mutationCount === 1;
}
