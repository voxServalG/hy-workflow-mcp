import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { ACCEPTANCE_SKILL_NAMES, parseJsonOutput, run } from "./harness.js";

type PackageInput = {
  installSpec: string;
  source: "registry" | "tarball";
};

type OracleOptions = {
  legacy: PackageInput;
  candidate: PackageInput;
};

type OracleWorkspace = {
  root: string;
  project: string;
  home: string;
  prefix: string;
  bin: string;
  env: NodeJS.ProcessEnv;
};

type McpPending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PreservedState = {
  projectTree: string;
  git: string;
  files: Map<string, Buffer>;
};

const LEGACY_VERSION = "0.4.0";
const DOCS_GARDENER_SPEC = "@voxstudio/docs-gardener@1.0.0-next.0";
const CLIENTS = ["codex", "claude", "opencode"] as const;
const UNRELATED_SKILL = "oracle-unrelated";
const AUTHORITY_MARKER = {
  schema: "hy-workflow.runtime-config-source.v1",
  authority: "project",
  source: "hy-workflow.json",
};

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function usage(): string {
  return [
    "Public v0.4.0 migration oracle",
    "",
    "Usage:",
    "  node --import tsx test/acceptance/public-migration-oracle.ts --candidate <npm-spec|tgz> [--legacy <npm-spec|tgz>]",
    "",
    "Options:",
    "  --legacy <value>    Defaults to @voxstudio/hy-workflow@0.4.0",
    "  --candidate <value> Required unless HY_PUBLIC_MIGRATION_CANDIDATE is set",
    "  --help              Show this help",
    "",
    "Only @voxstudio/hy-workflow registry specs and existing local .tgz files are accepted.",
  ].join("\n");
}

function packageInput(raw: string, label: string): PackageInput {
  const value = raw.trim();
  assert(value.length > 0, `${label} package input is empty`);
  if (value.endsWith(".tgz")) {
    const requested = resolve(value);
    assert(existsSync(requested), `${label} tarball does not exist: ${requested}`);
    const archive = realpathSync(requested);
    assert(lstatSync(archive).isFile(), `${label} tarball must resolve to a regular file: ${archive}`);
    assert(archive.endsWith(".tgz"), `${label} tarball must retain the .tgz suffix after resolution`);
    return { installSpec: archive, source: "tarball" };
  }
  assert(
    /^@voxstudio\/hy-workflow@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
    `${label} must be an @voxstudio/hy-workflow registry version/tag or an existing local .tgz`,
  );
  return { installSpec: value, source: "registry" };
}

function parseArgs(argv: string[]): OracleOptions | null {
  let legacy = process.env.HY_PUBLIC_MIGRATION_LEGACY ?? "@voxstudio/hy-workflow@0.4.0";
  let candidate = process.env.HY_PUBLIC_MIGRATION_CANDIDATE ?? "";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(usage() + "\n");
      return null;
    }
    assert(flag === "--legacy" || flag === "--candidate", `Unknown option: ${flag}`);
    const value = argv[++index];
    assert(value !== undefined && !value.startsWith("--"), `${flag} requires one value`);
    if (flag === "--legacy") legacy = value;
    else candidate = value;
  }
  assert(candidate, "--candidate is required (or set HY_PUBLIC_MIGRATION_CANDIDATE)");
  return { legacy: packageInput(legacy, "legacy"), candidate: packageInput(candidate, "candidate") };
}

function writeJson(file: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode });
}

function createWorkspace(sourceRoot: string): OracleWorkspace {
  assert(process.platform !== "win32", "The public migration oracle currently requires a POSIX acceptance host");
  const root = mkdtempSync(join(tmpdir(), "hy-public-migration-oracle-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const prefix = join(root, "npm-prefix");
  const bin = join(root, "stub-bin");
  const xdgConfig = join(home, ".config");
  const xdgData = join(home, ".local", "share");
  const xdgState = join(home, ".local", "state");
  const xdgCache = join(home, ".cache");
  const codexHome = join(home, ".codex");
  const claudeHome = join(home, ".claude");
  const opencodeHome = join(xdgConfig, "opencode");
  const workflowConfig = join(home, "hy-config");
  const workflowState = join(home, "hy-state");
  const workflowCache = join(home, "hy-cache");
  for (const directory of [
    project, home, prefix, bin, xdgConfig, xdgData, xdgState, xdgCache,
    codexHome, claudeHome, opencodeHome, workflowConfig, workflowState, workflowCache,
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 });

  const stub = join(bin, "client-stub.mjs");
  copyFileSync(join(sourceRoot, "test", "acceptance", "client-stub.mjs"), stub);
  chmodSync(stub, 0o755);
  for (const name of [...CLIENTS, "gh"]) symlinkSync(stub, join(bin, name));

  const npmUserConfig = join(home, ".npmrc");
  writeFileSync(npmUserConfig, "", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USER: "hy-public-migration",
    LOGNAME: "hy-public-migration",
    SHELL: "/bin/sh",
    TERM: "dumb",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    CI: "1",
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    OPENCODE_CONFIG_DIR: opencodeHome,
    OPENCODE_CONFIG: join(opencodeHome, "opencode.json"),
    HY_WORKFLOW_CONFIG_HOME: workflowConfig,
    HY_WORKFLOW_STATE_HOME: workflowState,
    HY_WORKFLOW_CACHE_HOME: workflowCache,
    HY_ACCEPTANCE_CLIENT_STATE: join(root, "client-state.json"),
    HY_ACCEPTANCE_CLIENT_EVENTS: join(root, "client-events.ndjson"),
    HY_WORKFLOW_ACCEPTANCE: "1",
    npm_config_prefix: prefix,
    npm_config_cache: join(xdgCache, "npm"),
    npm_config_userconfig: npmUserConfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    PATH: [bin, join(prefix, "bin"), "/usr/bin", "/bin", "/usr/local/bin"].join(delimiter),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const credential of ["SSH_AUTH_SOCK", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) {
    assert(env[credential] === undefined, `isolated environment inherited forbidden credential: ${credential}`);
  }
  return { root, project, home, prefix, bin, env };
}

async function installGlobal(workspace: OracleWorkspace, specs: string[]): Promise<void> {
  await run("npm", [
    "install", "--global", ...specs, "--ignore-scripts", "--no-audit", "--no-fund",
    "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=10000", "--fetch-timeout=60000",
  ], { env: workspace.env, timeoutMs: 240_000 });
}

async function installedPackageRoot(workspace: OracleWorkspace): Promise<string> {
  const result = await run("npm", ["root", "--global"], { env: workspace.env, timeoutMs: 30_000 });
  const packageRoot = realpathSync(join(result.stdout.trim(), "@voxstudio", "hy-workflow"));
  assert(lstatSync(packageRoot).isDirectory(), "installed hy-workflow package root is not a directory");
  return packageRoot;
}

function installedPackage(packageRoot: string): any {
  return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
}

async function createFixture(workspace: OracleWorkspace): Promise<void> {
  const root = workspace.project;
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeJson(join(root, "package.json"), {
    name: "public-migration-oracle-fixture",
    private: true,
    type: "module",
    scripts: {
      build: "node --check src/index.js",
      lint: "node --check src/index.js",
      test: "node --test test/index.test.js",
    },
  }, 0o644);
  writeFileSync(join(root, "src", "index.js"), "export const workflowValue = 41;\n", "utf8");
  writeFileSync(join(root, "test", "index.test.js"), [
    "import assert from \"node:assert/strict\";",
    "import test from \"node:test\";",
    "import { workflowValue } from \"../src/index.js\";",
    "test(\"fixture behavior\", () => assert.equal(workflowValue, 41));",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "docs", "index.md"), [
    "# Public migration fixture",
    "",
    "## Purpose",
    "",
    "This fixture has one JavaScript module, one deterministic test, and one local documentation entry point. The migration must preserve the active workflow state, project-owned setup artifacts, Git branch, staged implementation change, and every unrelated Agent integration.",
    "",
    "## Verification contract",
    "",
    "The source file is syntax-checked with Node and the native test is executed with node:test. No dependency installation, remote service, credential, publication, push, pull request, or release operation is part of fixture verification.",
    "",
    "## Ownership boundary",
    "",
    "The legacy setup owns only its recorded hy-workflow and docs-gardener MCP entries. The candidate helper may retire exactly the owned hy-workflow entry. It must preserve docs-gardener, an unrelated MCP entry, an unrelated Skill, repository files, and existing external workflow evidence.",
    "",
  ].join("\n"), "utf8");

  await run("git", ["init", "-b", "main"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.email", "migration-oracle@example.invalid"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.name", "Migration Oracle"], { cwd: root, env: workspace.env });
  await run("git", ["remote", "add", "origin", "https://example.invalid/public-migration-oracle.git"], { cwd: root, env: workspace.env });
  await run("git", ["add", "."], { cwd: root, env: workspace.env });
  await run("git", ["commit", "-m", "create public migration fixture"], { cwd: root, env: workspace.env });
  await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root, env: workspace.env });
  await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: root, env: workspace.env });
}

function clientSkillRoots(workspace: OracleWorkspace): Record<(typeof CLIENTS)[number], string> {
  return {
    codex: join(workspace.env.CODEX_HOME!, "skills"),
    claude: join(workspace.env.CLAUDE_CONFIG_DIR!, "skills"),
    opencode: join(workspace.env.OPENCODE_CONFIG_DIR!, "skills"),
  };
}

function seedUnrelatedSkills(workspace: OracleWorkspace): Map<string, Buffer> {
  const seeded = new Map<string, Buffer>();
  for (const [client, skillsRoot] of Object.entries(clientSkillRoots(workspace))) {
    const manifest = join(skillsRoot, UNRELATED_SKILL, "SKILL.md");
    const content = Buffer.from([
      "---",
      `name: ${UNRELATED_SKILL}`,
      `description: Unowned sentinel Skill for ${client}.`,
      "---",
      "",
      "This Skill is outside hy-workflow ownership and must remain byte-for-byte unchanged.",
      "",
    ].join("\n"));
    mkdirSync(dirname(manifest), { recursive: true, mode: 0o700 });
    writeFileSync(manifest, content, { mode: 0o600 });
    seeded.set(manifest, content);
  }
  return seeded;
}

async function seedMcpEntries(workspace: OracleWorkspace): Promise<void> {
  for (const client of ["codex", "claude"] as const) {
    const scope = client === "claude" ? ["--scope", "user"] : [];
    await run(client, ["mcp", "add", ...scope, "docs-gardener", "--", "docs-gardener", "mcp"], {
      cwd: workspace.project,
      env: workspace.env,
    });
    await run(client, ["mcp", "add", ...scope, "unrelated", "--", "unrelated-command", "--flag"], {
      cwd: workspace.project,
      env: workspace.env,
    });
  }
  writeJson(workspace.env.OPENCODE_CONFIG!, {
    mcp: {
      "docs-gardener": { type: "local", command: ["docs-gardener", "mcp"], enabled: true },
      unrelated: { type: "local", command: ["unrelated-command", "--flag"], enabled: true },
    },
  });
}

function reviewedArtifactArgs(dryRun: any): string[] {
  const changes = Array.isArray(dryRun.artifactChanges)
    ? dryRun.artifactChanges.filter((item: any) => item?.requiresAcceptance === true)
    : [];
  if (!changes.length) return [];
  return [
    "--accept-artifact-changes",
    ...changes.flatMap((item: any) => {
      assert(typeof item.file === "string" && typeof item.afterHash === "string", "legacy dry-run returned invalid artifact evidence");
      const before = typeof item.beforeHash === "string" ? item.beforeHash : "absent";
      return ["--review-artifact", `${item.file}:${before}:${item.afterHash}`];
    }),
  ];
}

async function runLegacySetup(workspace: OracleWorkspace): Promise<any> {
  const base = [
    "setup", "--yes", "--clients", "codex,claude,opencode",
    "--ci-command", "npm test", "--json",
  ];
  const dryResult = await run("hy-workflow", [...base.slice(0, -1), "--dry-run", "--json"], {
    cwd: workspace.project,
    env: workspace.env,
    timeoutMs: 90_000,
  });
  const dry = parseJsonOutput(dryResult.stdout);
  assert(dry.ok === true, "public 0.4.0 setup dry-run did not succeed");
  const actualArgs = [...base.slice(0, -1), ...reviewedArtifactArgs(dry), "--json"];
  const result = await run("hy-workflow", actualArgs, {
    cwd: workspace.project,
    env: workspace.env,
    timeoutMs: 90_000,
  });
  const setup = parseJsonOutput(result.stdout);
  assert(setup.ok === true, "public 0.4.0 setup did not succeed");
  assert(Array.isArray(setup.projectFilesChanged) && setup.projectFilesChanged.length === 3, "public 0.4.0 setup did not create its three project surfaces");
  return setup;
}

class LegacyMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, McpPending>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closing = false;

  private constructor(executable: string, workspace: OracleWorkspace) {
    this.child = spawn(executable, [], {
      cwd: workspace.project,
      env: workspace.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.consume(String(chunk)));
    this.child.stderr.on("data", chunk => { this.stderr += String(chunk); });
    this.child.once("error", error => this.rejectAll(error));
    this.child.once("close", (status, signal) => {
      if (!this.closing) this.rejectAll(new Error(`legacy MCP exited ${status ?? signal}: ${this.stderr.slice(-4_000)}`));
    });
  }

  static async start(executable: string, workspace: OracleWorkspace): Promise<LegacyMcpClient> {
    const client = new LegacyMcpClient(executable, workspace);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "public-migration-oracle", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
    return client;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try { message = JSON.parse(line); }
      catch { this.rejectAll(new Error(`legacy MCP emitted invalid JSON: ${line.slice(0, 2_000)}`)); continue; }
      if (message.id === undefined || message.id === null) continue;
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(`legacy MCP JSON-RPC error: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`legacy MCP ${method} timed out: ${this.stderr.slice(-4_000)}`));
      }, 60_000);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await this.request("tools/call", { name, arguments: args });
    assert(result?.isError !== true, `${name} returned an MCP error: ${JSON.stringify(result)}`);
    const text = Array.isArray(result?.content)
      ? result.content.filter((item: any) => item?.type === "text" && typeof item.text === "string").map((item: any) => item.text).join("\n")
      : "";
    assert(text, `${name} returned no text result`);
    return parseJsonOutput(text);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.child.stdin.end();
    await new Promise<void>(resolveClose => {
      if (this.child.exitCode !== null) return resolveClose();
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolveClose();
      }, 2_000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }
}

function tail(value: string): string {
  return value.length > 4_096 ? value.slice(-4_096) : value;
}

function assertSafeExamCommand(command: string, expected: Set<string>): void {
  assert(expected.has(command), `legacy exam issued an unexpected command: ${command}`);
  assert(!/(?:^|\s)(?:git\s+push|gh\s+(?:pr|release|repo)|npm\s+(?:publish|unpublish|deprecate))(?:\s|$)/.test(command), `remote write command rejected: ${command}`);
}

async function createActiveLegacyWorkflow(workspace: OracleWorkspace, executable: string): Promise<any> {
  const task = "Preserve an active verified workflow while replacing the legacy MCP integration with CLI Skills.";
  const plan = {
    task,
    scope: { changes: ["src/index.js"], new_files: [], delete: [] },
    boundary: {
      dependency_dag: "src/index.js is the only changed runtime module; tests, documentation, package metadata, setup artifacts, client configuration, and external workflow storage remain outside the implementation change.",
      entry_points: ["node --check src/index.js", "node --test test/index.test.js"],
      no_new_external: true,
    },
    verify: {
      platform: { python_version: "not applicable", setup: ["node --version"] },
      smoke: [{ command: "node --check src/index.js", expected_exit: 0, description: "Syntax-check the changed JavaScript module." }],
      tests: [{ command: "node --test test/index.test.js", expected_exit: 0, description: "Run the deterministic fixture behavior test." }],
    },
    risks: [
      "A migration could overwrite staged implementation state; capture project and Git evidence before the candidate helper and compare it byte-for-byte afterward.",
      "A broad cleanup could remove unrelated Agent integrations; seed independent MCP and Skill entries and require exact preservation through install and removal.",
    ],
    discussion: "Use the public 0.4.0 MCP workflow itself to create approval, documentation, scope, and verification evidence. Directly fabricating JSON was considered but rejected because it would not prove compatibility with the published state producer.",
  };

  const client = await LegacyMcpClient.start(executable, workspace);
  try {
    const initialized = await client.tool("hy_init");
    assert(initialized.phase === "plan" || initialized.next === "plan", "public 0.4.0 hy_init did not enter plan");
    const beforePlan = await client.tool("hy_read_docs", { stage: "before_plan", task });
    assert(beforePlan.snapshot?.stage === "before_plan" || beforePlan.stage === "before_plan", "before_plan evidence was not created");
    const planned = await client.tool("hy_plan", { task, plan });
    assert(planned.requires_user === true && planned.phase === "approve", "public 0.4.0 plan did not form an approval gate");
    const beforeApprove = await client.tool("hy_read_docs", { stage: "before_approve" });
    assert(beforeApprove.snapshot?.stage === "before_approve" || beforeApprove.stage === "before_approve", "before_approve evidence was not created");
    const approved = await client.tool("hy_approve", {
      approved: "approve",
      note: "Explicit approval simulated inside the isolated public migration oracle",
    });
    assert(approved.approved === true && approved.phase === "branch", "public 0.4.0 approval did not advance to branch");
    const branched = await client.tool("hy_branch", { category: "test", topic: "public-migration-oracle" });
    assert(branched.branch === "test/public-migration-oracle", "public 0.4.0 did not create the expected branch");
    const edited = await client.tool("hy_edit");
    assert(edited.phase === "edit", "public 0.4.0 did not lock edit scope");

    writeFileSync(join(workspace.project, "src", "index.js"), "export const workflowValue = 41;\nexport const migrationEvidence = true;\n", "utf8");
    await run("git", ["add", "src/index.js"], { cwd: workspace.project, env: workspace.env });

    const afterEdit = await client.tool("hy_read_docs", { stage: "after_edit" });
    assert(afterEdit.snapshot?.stage === "after_edit" || afterEdit.stage === "after_edit", "after_edit evidence was not created");
    const synced = await client.tool("hy_sync_docs");
    assert(synced.synced === true, "public 0.4.0 documentation sync evidence was not created");
    const exam = await client.tool("hy_exam_plan");
    assert(typeof exam.examId === "string" && Array.isArray(exam.checks) && exam.checks.length >= 5, "public 0.4.0 exam was not issued");
    const expected = new Set([
      "git diff --name-status",
      "test -f package.json && echo ok || echo no-package",
      "node --version",
      "node --check src/index.js",
      "node --test test/index.test.js",
    ]);
    const results = [];
    for (const check of exam.checks) {
      assert(typeof check.command === "string" && typeof check.nonce === "string" && typeof check.id === "string", "public 0.4.0 exam check shape drifted");
      assertSafeExamCommand(check.command, expected);
      const result = await run("/bin/sh", ["-c", check.command], {
        cwd: workspace.project,
        env: workspace.env,
        timeoutMs: typeof check.timeoutMs === "number" ? Math.min(check.timeoutMs, 120_000) : 120_000,
        allowFailure: true,
      });
      results.push({
        id: check.id,
        command: check.command,
        nonce: check.nonce,
        exitCode: result.status,
        durationMs: result.durationMs,
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
      });
    }
    const submitted = await client.tool("hy_exam_submit", { examId: exam.examId, results });
    assert(submitted.passed === true && typeof submitted.verifyHash === "string", "public 0.4.0 exam did not create verification evidence");
    return { examId: exam.examId, checkCount: exam.checks.length, verifyHash: submitted.verifyHash };
  } finally {
    await client.close();
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function treeDigest(root: string, omitGit = false): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (omitGit && directory === root && name === ".git") continue;
      const file = join(directory, name);
      const relative = file.slice(root.length + 1).replaceAll("\\", "/");
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) hash.update(`l:${relative}:${readlinkSync(file)}\n`);
      else if (stat.isDirectory()) { hash.update(`d:${relative}\n`); walk(file); }
      else if (stat.isFile()) { hash.update(`f:${relative}:${stat.mode}:`); hash.update(readFileSync(file)); hash.update("\n"); }
      else throw new Error(`special file found in oracle tree: ${file}`);
    }
  };
  walk(root);
  return hash.digest("hex");
}

async function gitEvidence(workspace: OracleWorkspace): Promise<string> {
  const values = await Promise.all([
    run("git", ["status", "--porcelain=v1", "-uall"], { cwd: workspace.project, env: workspace.env }),
    run("git", ["rev-parse", "HEAD"], { cwd: workspace.project, env: workspace.env }),
    run("git", ["branch", "--show-current"], { cwd: workspace.project, env: workspace.env }),
    run("git", ["for-each-ref", "--format=%(refname):%(objectname)", "refs/remotes"], { cwd: workspace.project, env: workspace.env }),
  ]);
  return JSON.stringify(values.map(value => value.stdout));
}

async function capturePreserved(workspace: OracleWorkspace, files: string[]): Promise<PreservedState> {
  return {
    projectTree: treeDigest(workspace.project, true),
    git: await gitEvidence(workspace),
    files: new Map(files.map(file => {
      assert(existsSync(file), `preserved file is missing before migration: ${file}`);
      return [file, readFileSync(file)];
    })),
  };
}

async function assertPreserved(workspace: OracleWorkspace, expected: PreservedState, context: string): Promise<void> {
  assert(treeDigest(workspace.project, true) === expected.projectTree, `${context} changed the project tree`);
  assert(await gitEvidence(workspace) === expected.git, `${context} changed Git status, branch, HEAD, or remote refs`);
  for (const [file, bytes] of expected.files) {
    assert(existsSync(file) && readFileSync(file).equals(bytes), `${context} changed preserved bytes: ${file}`);
  }
}

function projectExternalPaths(workspace: OracleWorkspace): {
  projectId: string;
  registry: string;
  deployment: string;
  workflow: string;
  scope: string;
  config: string;
  clientOwnership: string;
  stateDir: string;
} {
  const registry = join(workspace.env.HY_WORKFLOW_CONFIG_HOME!, "registry.json");
  const value = JSON.parse(readFileSync(registry, "utf8"));
  const ids = Object.keys(value.projects ?? {});
  assert(ids.length === 1 && /^[a-f0-9]{24}$/.test(ids[0]), "legacy registry did not contain one valid project identity");
  const projectId = ids[0];
  const stateDir = join(workspace.env.HY_WORKFLOW_STATE_HOME!, "projects", projectId);
  return {
    projectId,
    registry,
    deployment: join(stateDir, "deployment.json"),
    workflow: join(stateDir, "workflow.json"),
    scope: join(stateDir, "scope.json"),
    config: join(workspace.env.HY_WORKFLOW_CONFIG_HOME!, "projects", projectId, "config.json"),
    clientOwnership: join(workspace.env.HY_WORKFLOW_STATE_HOME!, "client-ownership.json"),
    stateDir,
  };
}

function normalizeOpencodeDefinition(value: any): { command: string; args: string[] } | null {
  const command = value?.command;
  if (!Array.isArray(command) || typeof command[0] !== "string") return null;
  return { command: command[0], args: command.slice(1) };
}

function clientDefinitions(workspace: OracleWorkspace): Record<string, Record<string, { command: string; args: string[] }>> {
  const stub = existsSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!)
    ? JSON.parse(readFileSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!, "utf8"))
    : {};
  const openConfig = JSON.parse(readFileSync(workspace.env.OPENCODE_CONFIG!, "utf8"));
  const opencode = Object.fromEntries(Object.entries(openConfig.mcp ?? {}).flatMap(([name, value]) => {
    const normalized = normalizeOpencodeDefinition(value);
    return normalized ? [[name, normalized]] : [];
  }));
  return { codex: stub.codex ?? {}, claude: stub.claude ?? {}, opencode };
}

function assertExpectedMcp(workspace: OracleWorkspace, includeWorkflow: boolean): void {
  const definitions = clientDefinitions(workspace);
  const expectedNames = [...(includeWorkflow ? ["hy-workflow"] : []), "docs-gardener", "unrelated"].sort();
  for (const client of CLIENTS) {
    const actual = Object.keys(definitions[client] ?? {}).sort();
    assert(JSON.stringify(actual) === JSON.stringify(expectedNames), `${client} MCP names drifted: ${actual.join(",")}`);
    assert(JSON.stringify(definitions[client]["docs-gardener"]) === JSON.stringify({ command: "docs-gardener", args: ["mcp"] }), `${client} docs-gardener definition changed`);
    assert(JSON.stringify(definitions[client].unrelated) === JSON.stringify({ command: "unrelated-command", args: ["--flag"] }), `${client} unrelated MCP definition changed`);
    if (includeWorkflow) {
      assert(JSON.stringify(definitions[client]["hy-workflow"]) === JSON.stringify({ command: "hy-workflow", args: [] }), `${client} legacy hy-workflow definition is missing`);
    }
  }
}

function assertHelperEnvelope(value: any, command: string): void {
  assert(value?.schema === "hy-workflow.helper.v1" && value.version === 1, `${command} helper schema drifted`);
  assert(value.command === command && value.ok === true && value.status === "completed", `${command} helper command failed`);
  assert(Array.isArray(value.projectFilesChanged) && value.projectFilesChanged.length === 0, `${command} helper changed project files`);
}

function assertSkillProjection(workspace: OracleWorkspace, installed: boolean, sentinels: Map<string, Buffer>): void {
  const names = [...ACCEPTANCE_SKILL_NAMES].sort();
  for (const skillsRoot of Object.values(clientSkillRoots(workspace))) {
    for (const name of names) {
      const manifest = join(skillsRoot, name, "SKILL.md");
      assert(existsSync(manifest) === installed, `${installed ? "missing" : "left"} managed Skill projection: ${manifest}`);
    }
    const actualManaged = existsSync(skillsRoot)
      ? readdirSync(skillsRoot).filter(name => (ACCEPTANCE_SKILL_NAMES as readonly string[]).includes(name)).sort()
      : [];
    assert(JSON.stringify(actualManaged) === JSON.stringify(installed ? names : []), "managed Skill projection count drifted");
  }
  for (const [file, content] of sentinels) {
    assert(existsSync(file) && readFileSync(file).equals(content), `unrelated Skill changed: ${file}`);
  }
}

function helperOperationalDigest(workspace: OracleWorkspace, paths: ReturnType<typeof projectExternalPaths>): string {
  const hash = createHash("sha256");
  const files = [
    paths.config,
    paths.deployment,
    paths.registry,
    paths.workflow,
    paths.scope,
    paths.clientOwnership,
    workspace.env.HY_ACCEPTANCE_CLIENT_STATE!,
    join(workspace.env.CODEX_HOME!, "config.toml"),
    workspace.env.OPENCODE_CONFIG!,
    join(workspace.env.XDG_STATE_HOME!, "hy-workflow", "skill-ownership.json"),
  ];
  for (const file of files) {
    hash.update(file + "\0");
    hash.update(existsSync(file) ? readFileSync(file) : Buffer.from("absent"));
    hash.update("\0");
  }
  const canonical = join(workspace.env.XDG_DATA_HOME!, "hy-workflow", "skills");
  hash.update(existsSync(canonical) ? treeDigest(canonical) : "absent");
  for (const skillsRoot of Object.values(clientSkillRoots(workspace))) hash.update(treeDigest(skillsRoot));
  return hash.digest("hex");
}

function assertNoRemoteWriteEvent(workspace: OracleWorkspace): void {
  const file = workspace.env.HY_ACCEPTANCE_CLIENT_EVENTS!;
  if (!existsSync(file)) return;
  const events = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert(!events.some(event => event.action === "remote-write-attempt"), "an Agent client observed a remote write attempt");
}

async function runOracle(options: OracleOptions, sourceRoot: string): Promise<Record<string, unknown>> {
  const workspace = createWorkspace(sourceRoot);
  try {
    await createFixture(workspace);
    const unrelatedSkills = seedUnrelatedSkills(workspace);
    await seedMcpEntries(workspace);

    await installGlobal(workspace, [options.legacy.installSpec, DOCS_GARDENER_SPEC]);
    const legacyRoot = await installedPackageRoot(workspace);
    const legacyPackage = installedPackage(legacyRoot);
    assert(legacyPackage.name === "@voxstudio/hy-workflow" && legacyPackage.version === LEGACY_VERSION, `legacy input installed ${legacyPackage.name}@${legacyPackage.version}, expected public 0.4.0`);
    assert(legacyPackage.bin?.["hy-workflow"] === "dist/server.js", "legacy input is not the public MCP-shaped 0.4.0 package");
    const legacyExecutable = realpathSync(join(workspace.prefix, "bin", "hy-workflow"));

    await runLegacySetup(workspace);
    assertExpectedMcp(workspace, true);
    const paths = projectExternalPaths(workspace);
    assert(!existsSync(paths.config), "public 0.4.0 unexpectedly created the candidate external authority marker");
    const deployment = JSON.parse(readFileSync(paths.deployment, "utf8"));
    assert(deployment.schemaVersion === "3", "public 0.4.0 did not create schema 3 deployment state");
    assert(JSON.stringify([...deployment.clients].sort()) === JSON.stringify([...CLIENTS].sort()), "public 0.4.0 did not own all three selected clients");
    assert(deployment.tools?.["hy-workflow"]?.version === LEGACY_VERSION, "deployment does not prove the public 0.4.0 producer");
    const oldOwnership = JSON.parse(readFileSync(paths.clientOwnership, "utf8"));
    for (const client of CLIENTS) {
      assert(oldOwnership.clients?.[client]?.["hy-workflow"] && oldOwnership.clients?.[client]?.["docs-gardener"], `public 0.4.0 ownership is incomplete for ${client}`);
    }

    await run("git", ["add", "."], { cwd: workspace.project, env: workspace.env });
    await run("git", ["commit", "-m", "install public 0.4.0 workflow"], { cwd: workspace.project, env: workspace.env });
    await run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: workspace.project, env: workspace.env });
    const workflowEvidence = await createActiveLegacyWorkflow(workspace, legacyExecutable);
    const workflow = JSON.parse(readFileSync(paths.workflow, "utf8"));
    const scope = JSON.parse(readFileSync(paths.scope, "utf8"));
    assert(workflow.phase === "commit" && workflow.approval?.time && workflow.verifyHash, "legacy workflow lacks active approval or verification evidence");
    assert(workflow.documentReads?.beforePlan && workflow.documentReads?.beforeApprove && workflow.documentReads?.afterEdit && workflow.syncDocs, "legacy workflow lacks complete documentation evidence");
    assert(scope.scope?.changes?.includes("src/index.js"), "legacy scope evidence is empty");
    const examFiles = readdirSync(join(paths.stateDir, "exams")).map(name => join(paths.stateDir, "exams", name));
    assert(examFiles.length === 1, "legacy workflow did not retain one exam evidence file");

    const preservedFiles = [
      join(workspace.project, "hy-workflow.json"),
      join(workspace.project, ".github", "workflows", "hy-workflow.yml"),
      join(workspace.project, "AGENTS.md"),
      paths.deployment,
      paths.registry,
      paths.workflow,
      paths.scope,
      ...examFiles,
    ];
    const preserved = await capturePreserved(workspace, preservedFiles);
    const docsOwnership = Object.fromEntries(CLIENTS.map(client => [client, oldOwnership.clients[client]["docs-gardener"]]));

    await installGlobal(workspace, [options.candidate.installSpec]);
    const candidateRoot = await installedPackageRoot(workspace);
    const candidatePackage = installedPackage(candidateRoot);
    assert(candidatePackage.name === "@voxstudio/hy-workflow", "candidate installed the wrong npm package");
    assert(candidatePackage.version !== LEGACY_VERSION, "candidate did not replace public 0.4.0");
    assert(candidatePackage.bin?.["hy-workflow"] === "dist/main.js" && existsSync(join(candidateRoot, "dist", "main.js")), "candidate is not the CLI+Skill package");
    assert(!existsSync(join(candidateRoot, "dist", "server.js")), "candidate still ships the retired MCP server entrypoint");
    const candidateVersion = (await run("hy-workflow", ["--version"], { env: workspace.env })).stdout.trim();
    assert(candidateVersion === candidatePackage.version, "candidate executable version disagrees with package.json");

    const installResult = await run("hy-workflow", ["helper", "install", "--json"], {
      cwd: workspace.project,
      env: workspace.env,
      timeoutMs: 90_000,
    });
    const installed = parseJsonOutput(installResult.stdout);
    assertHelperEnvelope(installed, "install");
    assert(installed.layers?.skills?.status === "installed" && installed.layers.skills.skillCount === 12 && installed.layers.skills.targets?.length === 3, "candidate did not install the 3 x 12 Skill projection");
    assert(JSON.stringify([...installed.clients].sort()) === JSON.stringify([...CLIENTS].sort()), "parameter-free helper install did not derive all three legacy/detected clients");
    assert(installed.layers?.project?.status === "preserved", "candidate rewrote the legacy deployment");
    assert(JSON.stringify(installed.layers.project.localFilesChanged) === JSON.stringify([paths.config]), "candidate project layer created more than the authority marker");
    assert(installed.layers?.mcp?.status === "retired" && installed.layers.mcp.remainingWorkflowMcpClients?.length === 0, "candidate did not retire all exactly owned hy-workflow MCP entries");
    assert(JSON.stringify(JSON.parse(readFileSync(paths.config, "utf8"))) === JSON.stringify(AUTHORITY_MARKER), "candidate did not create the exact project-authority marker");
    await assertPreserved(workspace, preserved, "candidate helper install");
    assertExpectedMcp(workspace, false);
    assertSkillProjection(workspace, true, unrelatedSkills);
    const migratedOwnership = JSON.parse(readFileSync(paths.clientOwnership, "utf8"));
    for (const client of CLIENTS) {
      assert(!migratedOwnership.clients?.[client]?.["hy-workflow"], `candidate left ${client} hy-workflow ownership`);
      assert(JSON.stringify(migratedOwnership.clients?.[client]?.["docs-gardener"]) === JSON.stringify(docsOwnership[client]), `candidate changed ${client} docs-gardener ownership`);
    }

    const skillManifestPath = join(workspace.env.XDG_STATE_HOME!, "hy-workflow", "skill-ownership.json");
    const skillManifest = JSON.parse(readFileSync(skillManifestPath, "utf8"));
    assert(skillManifest.skills?.length === 12 && skillManifest.targets?.length === 3, "Skill ownership manifest is not 3 x 12");
    assert(skillManifest.skills.every((skill: any) => skill.projections?.length === 3), "a managed Skill lacks one of the three projections");
    assert(skillManifest.targets.every((target: any) => target.preference === "auto"), "parameter-free helper install did not persist automatic projection preference");

    const stableInstalledDigest = helperOperationalDigest(workspace, paths);
    const status = parseJsonOutput((await run("hy-workflow", ["helper", "status", "--json"], {
      cwd: workspace.project,
      env: workspace.env,
    })).stdout);
    assertHelperEnvelope(status, "status");
    assert(status.layers?.skills?.status === "healthy" && status.layers?.project?.status === "registered", "candidate helper status is not healthy after migration");
    assert(helperOperationalDigest(workspace, paths) === stableInstalledDigest, "helper status mutated migrated state");

    const repeatedInstall = parseJsonOutput((await run("hy-workflow", ["helper", "install", "--json"], {
      cwd: workspace.project,
      env: workspace.env,
      timeoutMs: 90_000,
    })).stdout);
    assertHelperEnvelope(repeatedInstall, "install");
    assert(repeatedInstall.layers?.skills?.status === "unchanged" && repeatedInstall.layers?.project?.status === "preserved" && repeatedInstall.layers?.mcp?.status === "unchanged", "repeated helper install was not a no-op");
    assert(helperOperationalDigest(workspace, paths) === stableInstalledDigest, "repeated helper install changed migrated state");
    await assertPreserved(workspace, preserved, "repeated helper install");

    const markerBytes = readFileSync(paths.config);
    const postMigrationMcpDigest = sha256(Buffer.concat([
      readFileSync(paths.clientOwnership),
      readFileSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!),
      readFileSync(join(workspace.env.CODEX_HOME!, "config.toml")),
      readFileSync(workspace.env.OPENCODE_CONFIG!),
    ]));
    const removed = parseJsonOutput((await run("hy-workflow", ["helper", "remove", "--json"], {
      cwd: workspace.project,
      env: workspace.env,
      timeoutMs: 90_000,
    })).stdout);
    assertHelperEnvelope(removed, "remove");
    assert(removed.layers?.skills?.status === "removed" && removed.layers?.project?.status === "preserved" && removed.layers?.mcp?.status === "preserved", "helper remove crossed its ownership boundary");
    assertSkillProjection(workspace, false, unrelatedSkills);
    assert(!existsSync(skillManifestPath), "helper remove left Skill ownership state");
    assert(readFileSync(paths.config).equals(markerBytes), "helper remove changed the authority marker");
    assertExpectedMcp(workspace, false);
    assert(postMigrationMcpDigest === sha256(Buffer.concat([
      readFileSync(paths.clientOwnership),
      readFileSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!),
      readFileSync(join(workspace.env.CODEX_HOME!, "config.toml")),
      readFileSync(workspace.env.OPENCODE_CONFIG!),
    ])), "helper remove changed MCP state after retirement");
    await assertPreserved(workspace, preserved, "helper remove");

    const stableRemovedDigest = helperOperationalDigest(workspace, paths);
    const repeatedRemove = parseJsonOutput((await run("hy-workflow", ["helper", "remove", "--json"], {
      cwd: workspace.project,
      env: workspace.env,
      timeoutMs: 90_000,
    })).stdout);
    assertHelperEnvelope(repeatedRemove, "remove");
    assert(repeatedRemove.layers?.skills?.status === "unchanged" && repeatedRemove.layers?.project?.status === "preserved" && repeatedRemove.layers?.mcp?.status === "preserved", "repeated helper remove was not a no-op");
    assert(helperOperationalDigest(workspace, paths) === stableRemovedDigest, "repeated helper remove changed state");
    await assertPreserved(workspace, preserved, "repeated helper remove");
    assertNoRemoteWriteEvent(workspace);

    return {
      schema: "hy-workflow.public-migration-oracle.v1",
      ok: true,
      legacyVersion: legacyPackage.version,
      candidateVersion: candidatePackage.version,
      legacySource: options.legacy.source,
      candidateSource: options.candidate.source,
      deploymentSchema: deployment.schemaVersion,
      workflowEvidence,
      preserved: ["project", "deployment", "registry", "workflow", "scope", "exam"],
      retiredMcpClients: [...CLIENTS],
      skillProjections: CLIENTS.length * ACCEPTANCE_SKILL_NAMES.length,
      repeatedInstall: "no-op",
      removeBoundary: "preserved",
      repeatedRemove: "no-op",
      remoteWrites: 0,
    };
  } finally {
    const canonical = realpathSync(workspace.root);
    assert(dirname(canonical) === realpathSync(tmpdir()) && basename(canonical).startsWith("hy-public-migration-oracle-"), `refusing unsafe oracle cleanup: ${canonical}`);
    rmSync(canonical, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
if (options) {
  const sourceRoot = resolve(process.cwd());
  const report = await runOracle(options, sourceRoot);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
