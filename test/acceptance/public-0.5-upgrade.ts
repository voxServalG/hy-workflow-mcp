import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

type PackageInput = {
  installSpec: string;
  source: "registry" | "tarball";
  sha512: string | null;
};

type Options = {
  legacy: PackageInput;
  candidate: PackageInput;
};

type ParsedOptions = {
  legacy: PackageInput;
  candidate: PackageInput | null;
};

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

const LEGACY_VERSION = "0.5.0";
const LEGACY_SKILLS = [
  "hy-init",
  "hy-status",
  "hy-read-docs",
  "hy-plan",
  "hy-approve",
  "hy-branch",
  "hy-edit",
  "hy-sync-docs",
  "hy-verify",
  "hy-commit",
  "hy-merge",
  "hy-reset",
] as const;
const CURRENT_SKILLS = ["hy-capture", "hy-init", "hy-verify"] as const;
const RETIRED_SKILLS = LEGACY_SKILLS.filter(name => !(CURRENT_SKILLS as readonly string[]).includes(name));
const CLIENTS = ["codex", "claude", "opencode"] as const;
const FOREIGN_SKILL = "team-owned-sentinel";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha512(file: string): string {
  return createHash("sha512").update(readFileSync(file)).digest("hex");
}

function packageInput(raw: string, label: string): PackageInput {
  const value = raw.trim();
  assert(value, `${label} package input is empty`);
  if (value.endsWith(".tgz")) {
    const requested = resolve(value);
    assert(existsSync(requested), `${label} tarball does not exist: ${requested}`);
    const archive = realpathSync(requested);
    assert(lstatSync(archive).isFile() && archive.endsWith(".tgz"), `${label} tarball must resolve to a regular .tgz file: ${archive}`);
    return { installSpec: archive, source: "tarball", sha512: sha512(archive) };
  }
  assert(/^@voxstudio\/hy-workflow@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), `${label} must be an @voxstudio/hy-workflow registry version or an existing local .tgz`);
  return { installSpec: value, source: "registry", sha512: null };
}

function parseOptions(argv: string[]): ParsedOptions | null {
  let legacy = "@voxstudio/hy-workflow@0.5.0";
  let candidate = "";
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      process.stdout.write([
        "Public v0.5.0 to v0.6 Skill ownership migration oracle",
        "",
        "Usage:",
        "  npm run test:acceptance:migration -- [--legacy @voxstudio/hy-workflow@0.5.0] [--candidate <candidate.tgz>]",
        "",
        "Without --candidate, the oracle packs the current checkout. The legacy input defaults to the public v0.5.0 package.",
      ].join("\n") + "\n");
      return null;
    }
    assert(option === "--legacy" || option === "--candidate", `Unknown option: ${option}`);
    assert(!seen.has(option), `${option} may be provided only once`);
    seen.add(option);
    const value = argv[++index];
    assert(value && !value.startsWith("--"), `${option} requires one value`);
    if (option === "--legacy") legacy = value;
    else candidate = value;
  }
  return {
    legacy: packageInput(legacy, "legacy"),
    candidate: candidate ? packageInput(candidate, "candidate") : null,
  };
}

function npmInvocation(): { command: string; prefix: string[] } {
  const npmExecPath = process.env.npm_execpath;
  assert(npmExecPath && existsSync(npmExecPath), "npm_execpath is required; run migration acceptance through npm");
  return { command: process.execPath, prefix: [npmExecPath] };
}

function run(command: string, args: string[], options: RunOptions = {}): { stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(!result.error, `${command} failed to start: ${result.error?.message ?? "unknown error"}`);
  assert(result.status === 0, `${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.stderr || result.stdout}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function materializeCandidate(parsed: ParsedOptions): { options: Options; cleanup: (() => void) | null } {
  if (parsed.candidate) return { options: { legacy: parsed.legacy, candidate: parsed.candidate }, cleanup: null };

  const packDirectory = mkdtempSync(join(tmpdir(), "hy-migration-candidate-"));
  const cleanup = (): void => {
    const canonical = realpathSync(packDirectory);
    assert(
      dirname(canonical) === realpathSync(tmpdir()) && basename(canonical).startsWith("hy-migration-candidate-"),
      `refusing unsafe candidate cleanup: ${canonical}`,
    );
    rmSync(canonical, { recursive: true, force: true });
  };
  try {
    const npm = npmInvocation();
    const packed = run(npm.command, [
      ...npm.prefix,
      "pack",
      "--json",
      "--pack-destination",
      packDirectory,
    ], { cwd: process.cwd(), timeout: 180_000 });
    const report = JSON.parse(packed.stdout);
    assert(
      Array.isArray(report) && report.length === 1 && typeof report[0]?.filename === "string",
      "npm pack must produce exactly one candidate tarball",
    );
    const archive = realpathSync(join(packDirectory, report[0].filename));
    return {
      options: { legacy: parsed.legacy, candidate: packageInput(archive, "candidate") },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function parseJsonOutput(output: string, label: string): any {
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} returned invalid JSON:\n${output.slice(-8_000)}`);
  }
}

function helperSkills(envelope: any): any {
  return envelope?.skills ?? envelope?.layers?.skills;
}

function assertHelperSuccess(envelope: any, schema: string, command: string): void {
  assert(envelope?.schema === schema, `${command} returned ${String(envelope?.schema)}, expected ${schema}`);
  assert(envelope.command === command && envelope.ok === true && envelope.status === "completed", `${command} helper command did not complete successfully`);
  const skills = helperSkills(envelope);
  assert(skills && typeof skills.status === "string", `${command} helper output omitted Skill layer facts`);
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function treeBytes(root: string): string {
  if (!existsSync(root)) return "<absent>";
  const values: Array<[string, string]> = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && entry.name === ".git") continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        values.push([`${name}/`, "directory"]);
        visit(file, name);
      } else if (entry.isFile()) {
        values.push([name, readFileSync(file).toString("base64")]);
      } else {
        values.push([name, entry.isSymbolicLink() ? `symlink:${realpathSync(file)}` : "special"]);
      }
    }
  };
  visit(root);
  return JSON.stringify(values);
}

function gitEvidence(project: string, env: NodeJS.ProcessEnv): string {
  return JSON.stringify([
    run("git", ["status", "--porcelain=v1", "-uall"], { cwd: project, env }).stdout,
    run("git", ["rev-parse", "HEAD"], { cwd: project, env }).stdout,
    run("git", ["branch", "--show-current"], { cwd: project, env }).stdout,
  ]);
}

function isolatedEnvironment(workspace: string): NodeJS.ProcessEnv {
  const home = join(workspace, "home");
  const prefix = join(workspace, "npm-prefix");
  const xdgConfig = join(home, ".config");
  const xdgData = join(home, ".local", "share");
  const xdgState = join(home, ".local", "state");
  const xdgCache = join(home, ".cache");
  const npmConfig = join(home, ".npmrc");
  const workflowConfig = join(home, "hy-workflow-config");
  const workflowState = join(home, "hy-workflow-state");
  const workflowCache = join(home, "hy-workflow-cache");
  for (const directory of [
    home,
    prefix,
    xdgConfig,
    xdgData,
    xdgState,
    xdgCache,
    workflowConfig,
    workflowState,
    workflowCache,
    join(home, ".codex"),
    join(home, ".claude"),
    join(xdgConfig, "opencode"),
  ]) mkdirSync(directory, { recursive: true });
  writeFileSync(npmConfig, "", "utf8");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USER: "hy-migration-oracle",
    LOGNAME: "hy-migration-oracle",
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
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    OPENCODE_CONFIG_DIR: join(xdgConfig, "opencode"),
    OPENCODE_CONFIG: join(xdgConfig, "opencode", "opencode.json"),
    HY_WORKFLOW_CONFIG_HOME: workflowConfig,
    HY_WORKFLOW_STATE_HOME: workflowState,
    HY_WORKFLOW_CACHE_HOME: workflowCache,
    npm_config_prefix: prefix,
    npm_config_cache: join(xdgCache, "npm"),
    npm_config_userconfig: npmConfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: [join(prefix, "bin"), "/usr/bin", "/bin", "/usr/local/bin"].join(delimiter),
  };
  for (const credential of ["SSH_AUTH_SOCK", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) {
    assert(env[credential] === undefined, `isolated migration environment inherited ${credential}`);
  }
  return env;
}

function skillRoots(env: NodeJS.ProcessEnv): Record<(typeof CLIENTS)[number], string> {
  return {
    codex: join(env.CODEX_HOME!, "skills"),
    claude: join(env.CLAUDE_CONFIG_DIR!, "skills"),
    opencode: join(env.OPENCODE_CONFIG_DIR!, "skills"),
  };
}

function seedForeignSkills(env: NodeJS.ProcessEnv): Map<string, Buffer> {
  const sentinels = new Map<string, Buffer>();
  for (const [client, root] of Object.entries(skillRoots(env))) {
    const file = join(root, FOREIGN_SKILL, "SKILL.md");
    const bytes = Buffer.from(`---\nname: ${FOREIGN_SKILL}\ndescription: Foreign ${client} Skill.\n---\n\nOwned by the fixture team; preserve these bytes.\r\n`, "utf8");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    sentinels.set(file, bytes);
  }
  return sentinels;
}

function assertForeignSkills(sentinels: Map<string, Buffer>, context: string): void {
  for (const [file, bytes] of sentinels) {
    assert(existsSync(file) && readFileSync(file).equals(bytes), `${context} changed foreign Skill bytes: ${file}`);
  }
}

function installGlobal(spec: PackageInput, env: NodeJS.ProcessEnv, npm: ReturnType<typeof npmInvocation>): void {
  run(npm.command, [
    ...npm.prefix,
    "install",
    "--global",
    spec.installSpec,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--fetch-retries=2",
    "--fetch-retry-mintimeout=1000",
    "--fetch-retry-maxtimeout=10000",
    "--fetch-timeout=60000",
  ], { env, timeout: 240_000 });
}

function installedPackageRoot(env: NodeJS.ProcessEnv, npm: ReturnType<typeof npmInvocation>): string {
  const globalRoot = run(npm.command, [...npm.prefix, "root", "--global"], { env }).stdout.trim();
  const root = realpathSync(join(globalRoot, "@voxstudio", "hy-workflow"));
  assert(lstatSync(root).isDirectory(), "installed hy-workflow package root is not a directory");
  return root;
}

function managedNames(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    .filter(name => (LEGACY_SKILLS as readonly string[]).includes(name) || (CURRENT_SKILLS as readonly string[]).includes(name))
    .sort();
}

function verifyLegacyProjection(manifest: any, env: NodeJS.ProcessEnv): void {
  assert(manifest.schemaVersion === "1", "public v0.5.0 did not produce a v1 Skill ownership manifest");
  assert(manifest.package?.version === LEGACY_VERSION, "legacy ownership manifest was not produced by v0.5.0");
  assert(JSON.stringify(manifest.skills.map((skill: any) => skill.name).sort()) === JSON.stringify([...LEGACY_SKILLS].sort()), "legacy ownership manifest is not the exact twelve-Skill catalog");
  assert(manifest.targets?.length === CLIENTS.length && manifest.skills.every((skill: any) => skill.projections?.length === CLIENTS.length), "legacy ownership manifest is not a 3 x 12 projection");
  for (const root of Object.values(skillRoots(env))) {
    assert(JSON.stringify(managedNames(root)) === JSON.stringify([...LEGACY_SKILLS].sort()), `legacy target did not contain exactly twelve managed Skills: ${root}`);
  }
}

function verifyCurrentProjection(manifest: any, env: NodeJS.ProcessEnv): void {
  assert(manifest.schemaVersion === "2", "candidate did not upgrade the ownership manifest to v2");
  assert(JSON.stringify(manifest.skills.map((skill: any) => skill.name).sort()) === JSON.stringify([...CURRENT_SKILLS].sort()), "candidate ownership manifest must contain exactly init, verify, and capture");
  assert(manifest.targets?.length === CLIENTS.length && manifest.skills.every((skill: any) => skill.projections?.length === CLIENTS.length), "candidate ownership manifest is not a 3 x 3 projection");
  assert(!manifest.skills.some((skill: any) => skill.retired === true), "retired v0.5 Skills must be removed from ownership rather than retained as inert records");
  for (const root of Object.values(skillRoots(env))) {
    assert(JSON.stringify(managedNames(root)) === JSON.stringify([...CURRENT_SKILLS].sort()), `candidate target did not converge to exactly three managed Skills: ${root}`);
    for (const retired of RETIRED_SKILLS) assert(!existsSync(join(root, retired)), `candidate left retired Skill projection: ${join(root, retired)}`);
  }
}

function seedLegacyState(env: NodeJS.ProcessEnv): { projectId: string; roots: string[] } {
  const configRoot = env.HY_WORKFLOW_CONFIG_HOME!;
  const stateRoot = env.HY_WORKFLOW_STATE_HOME!;
  const cacheRoot = env.HY_WORKFLOW_CACHE_HOME!;
  const registry = JSON.parse(readFileSync(join(configRoot, "registry.json"), "utf8"));
  const ids = Object.keys(registry.projects ?? {});
  assert(ids.length === 1 && /^[a-f0-9]{24}$/.test(ids[0]), "legacy helper did not register exactly one project identity");
  const projectId = ids[0];
  const stateDirectory = join(stateRoot, "projects", projectId);
  const cacheDirectory = join(cacheRoot, "projects", projectId);
  const deployment = join(stateDirectory, "deployment.json");
  const config = join(configRoot, "projects", projectId, "config.json");
  assert(existsSync(deployment) && existsSync(config), "legacy helper did not produce real external config and deployment state");
  writeJson(join(stateDirectory, "workflow.json"), {
    schema: "hy-workflow.state.v2",
    oracle: "legacy-workflow-byte-sentinel",
    payload: "approval and verification evidence must remain opaque to Skill migration",
  });
  writeJson(join(stateDirectory, "scope.json"), {
    schema: "hy-workflow.scope.v1",
    oracle: "legacy-scope-byte-sentinel",
    files: ["src/index.js"],
  });
  writeJson(join(cacheDirectory, "docs-graph.json"), {
    schema: "hy-workflow.docs-graph.v1",
    oracle: "legacy-cache-byte-sentinel",
  });
  return { projectId, roots: [configRoot, stateRoot, cacheRoot] };
}

function createProject(project: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "docs"), { recursive: true });
  writeJson(join(project, "package.json"), {
    name: "public-0.5-upgrade-fixture",
    private: true,
    type: "module",
    scripts: {
      build: "node --check src/index.js",
      test: "node --check src/index.js",
    },
  });
  writeFileSync(join(project, "src", "index.js"), "export const migrationFixture = true;\n", "utf8");
  writeFileSync(join(project, "docs", "index.md"), "# Migration fixture\n\nThis project state must remain byte-for-byte unchanged during Skill ownership migration.\n", "utf8");
  run("git", ["init", "-b", "main"], { cwd: project, env });
  run("git", ["config", "user.email", "migration-oracle@example.invalid"], { cwd: project, env });
  run("git", ["config", "user.name", "Migration Oracle"], { cwd: project, env });
  run("git", ["add", "."], { cwd: project, env });
  run("git", ["commit", "-m", "create migration fixture"], { cwd: project, env });
}

function runOracle(options: Options): Record<string, unknown> {
  assert(process.platform !== "win32", "public v0.5.0 migration acceptance runs only on the Linux release host");
  const workspace = mkdtempSync(join(tmpdir(), "hy-public-0.5-upgrade-"));
  try {
    const env = isolatedEnvironment(workspace);
    const npm = npmInvocation();
    const project = join(workspace, "project");
    mkdirSync(project, { recursive: true });
    createProject(project, env);
    const foreignSkills = seedForeignSkills(env);

    installGlobal(options.legacy, env, npm);
    const legacyRoot = installedPackageRoot(env, npm);
    const legacyPackage = JSON.parse(readFileSync(join(legacyRoot, "package.json"), "utf8"));
    const legacyMain = join(legacyRoot, "dist", "main.js");
    assert(legacyPackage.name === "@voxstudio/hy-workflow" && legacyPackage.version === LEGACY_VERSION, `legacy input installed ${String(legacyPackage.name)}@${String(legacyPackage.version)}, expected public v0.5.0`);
    assert(existsSync(legacyMain), "public v0.5.0 package does not expose dist/main.js");
    const legacyInstall = parseJsonOutput(run(process.execPath, [
      legacyMain,
      "helper",
      "install",
      "--clients", "codex,claude,opencode",
      "--mode", "copy",
      "--json",
    ], { cwd: project, env, timeout: 120_000 }).stdout, "v0.5 helper install");
    assertHelperSuccess(legacyInstall, "hy-workflow.helper.v1", "install");
    assert(helperSkills(legacyInstall).skillCount === LEGACY_SKILLS.length, "public v0.5.0 helper did not install twelve Skills");

    const manifestPath = join(env.XDG_STATE_HOME!, "hy-workflow", "skill-ownership.json");
    const canonicalRoot = join(env.XDG_DATA_HOME!, "hy-workflow", "skills");
    const legacyManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    verifyLegacyProjection(legacyManifest, env);
    assert(JSON.stringify(managedNames(canonicalRoot)) === JSON.stringify([...LEGACY_SKILLS].sort()), "legacy canonical bundle is not exactly twelve Skills");
    assertForeignSkills(foreignSkills, "legacy helper install");

    const legacyState = seedLegacyState(env);
    const preservedState = legacyState.roots.map(root => [root, treeBytes(root)] as const);
    const preservedProject = treeBytes(project);
    const preservedGit = gitEvidence(project, env);

    installGlobal(options.candidate, env, npm);
    const candidateRoot = installedPackageRoot(env, npm);
    const candidatePackage = JSON.parse(readFileSync(join(candidateRoot, "package.json"), "utf8"));
    const candidateMain = join(candidateRoot, "dist", "main.js");
    assert(candidatePackage.name === "@voxstudio/hy-workflow" && candidatePackage.version !== LEGACY_VERSION, "candidate did not replace the public v0.5.0 package");
    assert(candidatePackage.bin?.["hy-workflow"] === "dist/main.js" && existsSync(candidateMain), "candidate does not expose the thin CLI entrypoint");
    assert(!existsSync(join(candidateRoot, "dist", "server.js")), "candidate still exposes the retired MCP server");
    const packagedSkills = readdirSync(join(candidateRoot, "skills"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    assert(JSON.stringify(packagedSkills) === JSON.stringify([...CURRENT_SKILLS].sort()), "candidate package does not contain exactly three Skills");

    const update = parseJsonOutput(run(process.execPath, [candidateMain, "helper", "update", "--json"], {
      cwd: project,
      env,
      timeout: 120_000,
    }).stdout, "candidate helper update");
    assertHelperSuccess(update, "hy-workflow.helper.v2", "update");
    assert(helperSkills(update).skillCount === CURRENT_SKILLS.length, "candidate helper did not report exactly three managed Skills");
    const currentManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    verifyCurrentProjection(currentManifest, env);
    assert(JSON.stringify(managedNames(canonicalRoot)) === JSON.stringify([...CURRENT_SKILLS].sort()), "candidate canonical bundle did not converge to exactly three Skills");
    assertForeignSkills(foreignSkills, "candidate helper update");
    for (const [root, bytes] of preservedState) assert(treeBytes(root) === bytes, `candidate changed legacy project state bytes under ${root}`);
    assert(treeBytes(project) === preservedProject && gitEvidence(project, env) === preservedGit, "candidate changed the Git project while migrating user-level Skills");

    const repeated = parseJsonOutput(run(process.execPath, [candidateMain, "helper", "update", "--json"], {
      cwd: project,
      env,
      timeout: 120_000,
    }).stdout, "repeated candidate helper update");
    assertHelperSuccess(repeated, "hy-workflow.helper.v2", "update");
    assert(helperSkills(repeated).status === "unchanged", "repeated candidate helper update must be a no-op");
    const status = parseJsonOutput(run(process.execPath, [candidateMain, "helper", "status", "--json"], {
      cwd: project,
      env,
      timeout: 60_000,
    }).stdout, "candidate helper status");
    assertHelperSuccess(status, "hy-workflow.helper.v2", "status");
    assert(helperSkills(status).status === "healthy", "candidate helper status must be healthy after migration");
    assertForeignSkills(foreignSkills, "repeated update and status");
    for (const [root, bytes] of preservedState) assert(treeBytes(root) === bytes, `repeated update or status changed legacy project state bytes under ${root}`);
    assert(treeBytes(project) === preservedProject && gitEvidence(project, env) === preservedGit, "repeated update or status changed the Git project");
    if (options.candidate.sha512) assert(sha512(options.candidate.installSpec) === options.candidate.sha512, "migration oracle modified the candidate tarball");

    return {
      schema: "hy-workflow.public-0.5-upgrade.v1",
      ok: true,
      legacyVersion: legacyPackage.version,
      candidateVersion: candidatePackage.version,
      legacySource: options.legacy.source,
      candidateSource: options.candidate.source,
      ownership: { fromSchema: "1", toSchema: "2", fromSkills: LEGACY_SKILLS.length, toSkills: CURRENT_SKILLS.length },
      targets: CLIENTS.length,
      retiredSkills: RETIRED_SKILLS.length,
      foreignSkillsPreserved: foreignSkills.size,
      projectStateRootsPreserved: legacyState.roots.length,
      projectId: legacyState.projectId,
      repeatedUpdate: "unchanged",
      status: "healthy",
    };
  } finally {
    const canonical = realpathSync(workspace);
    assert(dirname(canonical) === realpathSync(tmpdir()) && basename(canonical).startsWith("hy-public-0.5-upgrade-"), `refusing unsafe migration cleanup: ${canonical}`);
    rmSync(canonical, { recursive: true, force: true });
  }
}

const parsed = parseOptions(process.argv.slice(2));
if (parsed) {
  const candidate = materializeCandidate(parsed);
  try {
    process.stdout.write(`${JSON.stringify(runOracle(candidate.options), null, 2)}\n`);
  } finally {
    candidate.cleanup?.();
  }
}
