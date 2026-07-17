import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type AcceptanceRepo = {
  id: string;
  category: "legacy" | "oss";
  url: string;
  mirrorEnv?: string;
  commit: string;
  ecosystem: string;
  defaultBranch: string;
  expected: {
    codeExt: string[];
    codeDirs: string[];
    lintDirs: string[];
    docsDir: string;
  };
};

export type AcceptanceMatrix = {
  schemaVersion: "1";
  companionPackage: string;
  repositories: AcceptanceRepo[];
};

export type AcceptanceWorkspace = {
  root: string;
  sourceRoot: string;
  home: string;
  prefix: string;
  bin: string;
  repos: string;
  reports: string;
  env: NodeJS.ProcessEnv;
  disk: {
    limitBytes: number;
    currentBytes: number;
    peakBytes: number;
  };
};

export type RunResult = {
  command: string;
  args: string[];
  status: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  allowFailure?: boolean;
};

const REMOTE_WRITES = new Set([
  "git push",
  "git send-pack",
  "gh pr",
  "gh release",
  "npm publish",
  "npm unpublish",
  "npm deprecate",
]);
const ACTIVE_CHILDREN = new Set<ReturnType<typeof spawn>>();
let ACCEPTANCE_ABORT_REASON: Error | null = null;
export const ACCEPTANCE_WORKSPACE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

function rejectRemoteWrite(command: string, args: string[]): void {
  const key = [basename(command), ...args].slice(0, 2).join(" ");
  if ([...REMOTE_WRITES].some(prefix => key === prefix || [basename(command), ...args].join(" ").startsWith(prefix + " "))) {
    throw new Error("Acceptance harness refuses remote write command: " + [command, ...args].join(" "));
  }
}

function terminateTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => {
        try { child.kill("SIGKILL"); } catch {}
      });
    }
  } catch {}
}

export function terminateAllAcceptanceChildren(): void {
  for (const child of ACTIVE_CHILDREN) terminateTree(child, "SIGKILL");
}

export function abortAcceptance(reason: unknown): void {
  ACCEPTANCE_ABORT_REASON ??= reason instanceof Error ? reason : new Error(String(reason));
  terminateAllAcceptanceChildren();
}

export function assertAcceptanceActive(): void {
  if (ACCEPTANCE_ABORT_REASON) throw ACCEPTANCE_ABORT_REASON;
}

async function acceptanceDelay(milliseconds: number): Promise<void> {
  assertAcceptanceActive();
  await new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
  assertAcceptanceActive();
}

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  assertAcceptanceActive();
  rejectRemoteWrite(command, args);
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    ACTIVE_CHILDREN.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      ACTIVE_CHILDREN.delete(child);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateTree(child, "SIGKILL");
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", rejectOnce);
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      terminateTree(child, "SIGTERM");
      killTimer = setTimeout(() => terminateTree(child, "SIGKILL"), 2_000);
    }, timeoutMs);
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result: RunResult = {
        command,
        args,
        status: status ?? (signal ? 128 : 1),
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      };
      if (!options.allowFailure && (timedOut || result.status !== 0)) {
        reject(new Error(
          [command, ...args].join(" ") + " failed"
          + (timedOut ? " (timeout)" : " with exit " + result.status)
          + "\n" + (stderr || stdout).slice(-8_000),
        ));
      } else resolveResult(result);
    });
  });
}

export function loadMatrix(sourceRoot: string): AcceptanceMatrix {
  const matrix = JSON.parse(readFileSync(join(sourceRoot, "test", "acceptance", "matrix.json"), "utf8"));
  if (
    matrix?.schemaVersion !== "1"
    || !Array.isArray(matrix.repositories)
    || matrix.repositories.length !== 5
    || matrix.repositories.some((repo: AcceptanceRepo) =>
      !repo.url.startsWith("https://")
      || !/^[0-9a-f]{40}$/.test(repo.commit)
      || (repo.mirrorEnv !== undefined && !/^HY_ACCEPTANCE_[A-Z0-9_]+_MIRROR$/.test(repo.mirrorEnv))
    )
  ) {
    throw new Error("Acceptance matrix must contain five HTTPS repositories pinned to full commits");
  }
  return matrix;
}

export function createWorkspace(sourceRoot: string): AcceptanceWorkspace {
  const root = mkdtempSync(join(tmpdir(), "hy-workflow-acceptance-"));
  const home = join(root, "home");
  const prefix = join(root, "npm-prefix");
  const bin = join(root, "stub-bin");
  const repos = join(root, "repos");
  const reports = join(root, "reports");
  const lintArchives = join(root, "lint-archives");
  for (const dir of [home, prefix, bin, repos, reports, lintArchives]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const stub = join(bin, "client-stub.mjs");
  copyFileSync(join(sourceRoot, "test", "acceptance", "client-stub.mjs"), stub);
  chmodSync(stub, 0o755);
  for (const name of ["codex", "claude", "opencode", "gh"]) symlinkSync(stub, join(bin, name));

  const xdgConfig = join(home, ".config");
  const xdgState = join(home, ".local", "state");
  const xdgCache = join(home, ".cache");
  const codexHome = join(home, ".codex");
  const npmUserConfig = join(home, ".npmrc");
  const prefixBin = process.platform === "win32" ? prefix : join(prefix, "bin");
  const safeSystemPath = process.platform === "win32"
    ? (process.env.SystemRoot ? join(process.env.SystemRoot, "System32") : "")
    : "/usr/bin:/bin:/usr/local/bin";
  for (const dir of [xdgConfig, xdgState, xdgCache, codexHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(npmUserConfig, "", { mode: 0o600 });

  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USER: "hy-acceptance",
    LOGNAME: "hy-acceptance",
    SHELL: process.platform === "win32" ? process.env.ComSpec : "/bin/sh",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    XDG_CONFIG_HOME: xdgConfig,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    CODEX_HOME: codexHome,
    OPENCODE_CONFIG: join(xdgConfig, "opencode", "opencode.json"),
    npm_config_prefix: prefix,
    npm_config_cache: join(xdgCache, "npm"),
    npm_config_userconfig: npmUserConfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    PATH: [bin, prefixBin, safeSystemPath].filter(Boolean).join(delimiter),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: process.platform === "win32" ? "echo" : "/bin/false",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HY_ACCEPTANCE_CLIENT_STATE: join(root, "client-state.json"),
    HY_ACCEPTANCE_CLIENT_EVENTS: join(reports, "client-events.ndjson"),
    HY_ACCEPTANCE_LINT_ARCHIVE_DIR: lintArchives,
    HY_WORKFLOW_ACCEPTANCE: "1",
  };
  for (const forbidden of ["SSH_AUTH_SOCK", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN"]) {
    if (env[forbidden] !== undefined) throw new Error("Acceptance environment inherited forbidden credential variable: " + forbidden);
  }
  return {
    root,
    sourceRoot: resolve(sourceRoot),
    home,
    prefix,
    bin,
    repos,
    reports,
    env,
    disk: { limitBytes: ACCEPTANCE_WORKSPACE_LIMIT_BYTES, currentBytes: 0, peakBytes: 0 },
  };
}

export async function packAndInstall(workspace: AcceptanceWorkspace, companionPackage: string, packageArchive?: string): Promise<string> {
  let archive: string;
  if (packageArchive) {
    const requested = resolve(packageArchive);
    if (!requested.endsWith(".tgz") || !existsSync(requested)) throw new Error("Acceptance --package-archive must name an existing .tgz file");
    archive = realpathSync(requested);
    if (!lstatSync(archive).isFile()) throw new Error("Acceptance --package-archive must resolve to a regular file");
  } else {
    const before = new Set(readdirSync(workspace.root));
    await run("npm", ["pack", "--silent", "--pack-destination", workspace.root], {
      cwd: workspace.sourceRoot,
      env: workspace.env,
      timeoutMs: 240_000,
    });
    const packed = readdirSync(workspace.root)
      .filter(name => name.endsWith(".tgz") && !before.has(name))
      .map(name => join(workspace.root, name))[0];
    if (!packed) throw new Error("npm pack did not produce a local tgz");
    archive = realpathSync(packed);
  }
  const listing = await run("tar", ["-tzf", archive], { env: workspace.env, timeoutMs: 30_000 });
  for (const forbidden of ["package/src/", "package/test/", "package/.hy/", "package/.codex/", "package/.opencode/"]) {
    if (listing.stdout.includes(forbidden)) throw new Error("Local tgz contains forbidden path: " + forbidden);
  }
  if (!listing.stdout.includes("package/dist/server.js")) throw new Error("Local tgz is missing dist/server.js");

  const installAttempts = 2;
  let installFailure = "";
  for (let attempt = 1; attempt <= installAttempts; attempt += 1) {
    const installed = await run("npm", ["install", "--global", archive, companionPackage, "--no-audit", "--no-fund",
      "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=10000", "--fetch-timeout=60000",
    ], {
      env: workspace.env,
      timeoutMs: 210_000,
      allowFailure: true,
    });
    if (!installed.timedOut && installed.status === 0) {
      installFailure = "";
      break;
    }
    installFailure = `attempt ${attempt}/${installAttempts}${installed.timedOut ? " timed out" : ` exited ${installed.status}`}: ${(installed.stderr || installed.stdout).slice(-4_000)}`;
  }
  if (installFailure) throw new Error(`isolated npm package installation failed after ${installAttempts} attempts: ${installFailure}`);
  const globalRoot = (await run("npm", ["root", "--global"], { env: workspace.env, timeoutMs: 30_000 })).stdout.trim();
  const packageRoot = realpathSync(join(globalRoot, "@voxstudio", "hy-workflow"));
  if (!existsSync(join(packageRoot, "dist", "setup-cli.js"))) throw new Error("Installed local tgz is missing dist/setup-cli.js");
  workspace.env.HY_ACCEPTANCE_PACKAGE_ROOT = packageRoot;
  const executable = process.platform === "win32" ? join(workspace.prefix, "hy-workflow.cmd") : join(workspace.prefix, "bin", "hy-workflow");
  if (!existsSync(executable)) throw new Error("Installed local tgz did not expose hy-workflow");
  return archive;
}

export async function clonePinned(workspace: AcceptanceWorkspace, repo: AcceptanceRepo): Promise<string> {
  const target = join(workspace.repos, repo.id);
  mkdirSync(target, { recursive: true });
  await run("git", ["init", target], { env: workspace.env });
  await run("git", ["remote", "add", "origin", repo.url], { cwd: target, env: workspace.env });
  const mirrorInput = repo.mirrorEnv ? process.env[repo.mirrorEnv] : undefined;
  let fetchSource = "origin";
  if (mirrorInput) {
    const mirror = realpathSync(resolve(mirrorInput));
    if (!lstatSync(mirror).isDirectory()) throw new Error(`${repo.mirrorEnv} must resolve to a Git repository directory`);
    await run("git", ["cat-file", "-e", `${repo.commit}^{commit}`], { cwd: mirror, env: workspace.env, timeoutMs: 30_000 });
    fetchSource = pathToFileURL(mirror).href;
  }
  const fetchAttempts = 3;
  let fetchFailure = "";
  for (let attempt = 1; attempt <= fetchAttempts; attempt += 1) {
    const fetched = await run("git", ["-c", "http.version=HTTP/1.1", "fetch", "--depth=1", "--no-tags", fetchSource, repo.commit], {
      cwd: target,
      env: workspace.env,
      timeoutMs: 240_000,
      allowFailure: true,
    });
    if (!fetched.timedOut && fetched.status === 0) {
      fetchFailure = "";
      break;
    }
    fetchFailure = `attempt ${attempt}/${fetchAttempts}${fetched.timedOut ? " timed out" : ` exited ${fetched.status}`}: ${(fetched.stderr || fetched.stdout).slice(-4_000)}`;
    for (const lock of ["shallow.lock", "index.lock", "FETCH_HEAD.lock", "packed-refs.lock"]) {
      rmSync(join(target, ".git", lock), { force: true });
    }
    if (attempt < fetchAttempts) await acceptanceDelay(attempt * 1_000);
  }
  if (fetchFailure) throw new Error(`${repo.id} pinned fetch failed after ${fetchAttempts} attempts: ${fetchFailure}`);
  await run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: target, env: workspace.env });
  await run("git", ["update-ref", "refs/remotes/origin/" + repo.defaultBranch, "HEAD"], { cwd: target, env: workspace.env });
  await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/" + repo.defaultBranch], { cwd: target, env: workspace.env });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: target, env: workspace.env })).stdout.trim();
  if (head !== repo.commit) throw new Error(repo.id + " checkout drifted: expected " + repo.commit + ", got " + head);
  return target;
}

export async function gitSnapshot(root: string, env: NodeJS.ProcessEnv): Promise<{ head: string; remote: string; refs: string }> {
  const [head, remote, refs] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: root, env }),
    run("git", ["remote", "get-url", "origin"], { cwd: root, env }),
    run("git", ["for-each-ref", "--format=%(refname):%(objectname)", "refs/remotes"], { cwd: root, env }),
  ]);
  return { head: head.stdout.trim(), remote: remote.stdout.trim(), refs: refs.stdout.trim() };
}

export async function assertProjectBoundary(
  root: string,
  env: NodeJS.ProcessEnv,
  additionalAllowed: string[] = [],
): Promise<string[]> {
  const result = await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env });
  const changed = result.stdout.split(/\r?\n/).filter(Boolean).map(line => line.slice(3).replace(/^"|"$/g, ""));
  const allowed = new Set(["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md", ...additionalAllowed]);
  const illegal = changed.filter(file => !allowed.has(file));
  if (illegal.length) throw new Error("setup changed files outside its three-file team-artifact boundary: " + illegal.join(", "));
  for (const forbidden of [".hy", ".codex", ".mcp.json", "codelint.json", "doclint.json", "docs-gardener.json"]) {
    if (existsSync(join(root, forbidden)) && !changed.includes(forbidden)) {
      // Existing tracked legacy artifacts are migration inputs; setup must not create new ones.
      continue;
    }
  }
  return changed;
}

export function parseJsonOutput(output: string): any {
  for (let index = output.indexOf("{"); index >= 0; index = output.indexOf("{", index + 1)) {
    try { return JSON.parse(output.slice(index)); } catch {}
  }
  throw new Error("Command did not return one JSON envelope:\n" + output.slice(-4_000));
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export async function probeTui(workspace: AcceptanceWorkspace, root: string): Promise<number> {
  assertAcceptanceActive();
  if (process.platform === "win32") throw new Error("Release acceptance TUI probe requires a PTY-capable Linux runner");
  const command = ["hy-workflow", "setup"].map(shellQuote).join(" ");
  const started = Date.now();
  return await new Promise((resolveProbe, reject) => {
    const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], {
      cwd: root,
      env: workspace.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    ACTIVE_CHILDREN.add(child);
    let introOutputMs: number | null = null;
    let output = "";
    let settled = false;
    let cancellationSent = false;
    let cancellationTimer: NodeJS.Timeout | undefined;
    const rejectProbe = (error: Error): void => {
      if (settled) return;
      settled = true;
      ACTIVE_CHILDREN.delete(child);
      clearTimeout(timer);
      if (cancellationTimer) clearTimeout(cancellationTimer);
      terminateTree(child, "SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => {
      rejectProbe(new Error("setup TUI did not render its recognizable intro within 1500ms: " + output.slice(-2_000)));
    }, 1_500);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (!cancellationSent && /hy-workflow (?:安装与维护|setup and maintenance)/i.test(output)) {
        introOutputMs = Date.now() - started;
        cancellationSent = true;
        clearTimeout(timer);
        child.stdin.write("\u0003");
        cancellationTimer = setTimeout(() => {
          rejectProbe(new Error("setup TUI rendered but did not exit cleanly after Ctrl-C: " + output.slice(-2_000)));
        }, 1_500);
      }
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
    child.on("error", error => rejectProbe(error));
    child.on("close", (status, signal) => {
      ACTIVE_CHILDREN.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancellationTimer) clearTimeout(cancellationTimer);
      if (introOutputMs === null) {
        reject(new Error("setup TUI exited without its recognizable intro: " + output.slice(-2_000)));
      } else if ((status !== 0 && status !== 130) || signal !== null) {
        reject(new Error(`setup TUI cancellation exited abnormally (status=${status}, signal=${signal}): ${output.slice(-2_000)}`));
      } else if (/(?:npm ERR!|Unhandled|Error:|SETUP_[A-Z_]+)/i.test(output)) {
        reject(new Error("setup TUI emitted an error during startup/cancellation: " + output.slice(-2_000)));
      } else {
        resolveProbe(introOutputMs);
      }
    });
  });
}

export async function mcpDocsBaseline(
  workspace: AcceptanceWorkspace,
  root: string,
  task: string,
): Promise<{ chars: number; response: any }> {
  assertAcceptanceActive();
  return await new Promise((resolveBaseline, reject) => {
    const child = spawn("hy-workflow", [], {
      cwd: root,
      env: workspace.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    ACTIVE_CHILDREN.add(child);
    let stdout = "";
    let stderr = "";
    let consumed = 0;
    let finalized = false;
    let result: { chars: number; response: any } | null = null;
    let failure: Error | null = null;
    let shutdownTimer: NodeJS.Timeout | undefined;
    let closeDeadline: NodeJS.Timeout | undefined;
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    const cleanup = (): void => {
      clearTimeout(timer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (closeDeadline) clearTimeout(closeDeadline);
      ACTIVE_CHILDREN.delete(child);
    };
    const finish = (): void => {
      if (finalized) return;
      finalized = true;
      cleanup();
      if (result && !failure) resolveBaseline(result);
      else reject(failure ?? ACCEPTANCE_ABORT_REASON ?? new Error("MCP server exited before docs baseline: " + stderr.slice(-2_000)));
    };
    const stop = (error?: unknown): void => {
      if (finalized) return;
      if (error !== undefined) failure ??= error instanceof Error ? error : new Error(String(error));
      clearTimeout(timer);
      terminateTree(child, error === undefined ? "SIGTERM" : "SIGKILL");
      shutdownTimer ??= setTimeout(() => terminateTree(child, "SIGKILL"), 1_500);
      closeDeadline ??= setTimeout(() => {
        failure ??= new Error("MCP docs baseline process tree did not exit after cancellation");
        finish();
      }, 5_000);
    };
    const timer = setTimeout(() => stop(new Error("MCP docs baseline timed out: " + stderr.slice(-2_000))), 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      for (; consumed < lines.length - 1; consumed += 1) {
        const line = lines[consumed];
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
            send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hy_init", arguments: {} } });
          }
          if (message.id === 2) {
            if (message.error || message.result?.isError) throw new Error("hy_init failed: " + JSON.stringify(message));
            send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hy_read_docs", arguments: { stage: "before_plan", task } } });
          }
          if (message.id === 3) {
            if (message.error || message.result?.isError) {
              throw new Error("hy_read_docs failed: " + JSON.stringify(message));
            }
            const textBlocks = Array.isArray(message.result?.content)
              ? message.result.content.filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text)
              : [];
            if (!textBlocks.length) throw new Error("hy_read_docs returned no text content");
            let payload: any = null;
            for (const text of textBlocks) {
              try {
                const candidate = JSON.parse(text);
                if (candidate && typeof candidate === "object") { payload = candidate; break; }
              } catch {}
            }
            if (!payload) throw new Error("hy_read_docs returned no JSON payload");
            if (payload.error) throw new Error("hy_read_docs returned a structured error: " + JSON.stringify(payload.error));
            const snapshot = payload.snapshot;
            const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
            const facts = files.filter((file: any) => typeof file?.content === "string" && file.content.replace(/\s+/g, " ").trim().length >= 12);
            const findings = Array.isArray(snapshot?.findings) ? snapshot.findings.filter((finding: any) => typeof finding === "string" && finding.trim()) : [];
            if (!facts.length || !findings.length) {
              throw new Error("hy_read_docs returned no substantive document facts: " + JSON.stringify({ files: files.length, facts: facts.length, findings: findings.length }));
            }
            const chars = facts.reduce((total: number, file: any) => total + file.content.length, 0);
            result = { chars, response: payload };
            stop();
            return;
          }
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          stop(error);
          return;
        }
      }
    });
    child.once("error", error => stop(error));
    child.once("close", finish);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "hy-acceptance", version: "1" } } });
  });
}

function scanWorkspace(root: string): number {
  const boundary = resolve(root);
  let bytes = 0;
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      bytes += stat.size;
      if (stat.isSymbolicLink()) {
        const target = resolve(dirname(file), readlinkSync(file));
        if (target !== boundary && !target.startsWith(boundary + sep)) {
          throw new Error("Acceptance output symlink escapes workspace: " + file);
        }
        continue;
      }
      if (stat.isDirectory()) walk(file);
    }
  };
  walk(boundary);
  return bytes;
}

export function assertWorkspaceDiskBudget(workspace: AcceptanceWorkspace): number {
  const bytes = scanWorkspace(workspace.root);
  workspace.disk.currentBytes = bytes;
  workspace.disk.peakBytes = Math.max(workspace.disk.peakBytes, bytes);
  if (bytes > workspace.disk.limitBytes) {
    throw new Error(`Acceptance workspace uses ${bytes} bytes, above the ${workspace.disk.limitBytes}-byte limit`);
  }
  return bytes;
}

export function assertNoSymlinkEscape(root: string): void {
  scanWorkspace(root);
}
