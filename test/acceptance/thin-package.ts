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

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
};

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(!result.error, `${command} failed to start: ${result.error?.message ?? "unknown error"}`);
  assert(result.status !== null, `${command} terminated without an exit code`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runOk(command: string, args: string[], options: RunOptions = {}): RunResult {
  const result = run(command, args, options);
  assert(result.status === 0, `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  return result;
}

function npmInvocation(): { command: string; prefix: string[] } {
  const npmExecPath = process.env.npm_execpath;
  assert(npmExecPath && existsSync(npmExecPath), "npm_execpath is required; run thin acceptance through npm");
  return { command: process.execPath, prefix: [npmExecPath] };
}

function parseArchiveArgument(argv: string[]): string | null {
  let archive: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      process.stdout.write("Usage: npm run test:acceptance:thin -- [--package-archive <candidate.tgz>]\n");
      process.exit(0);
    }
    assert(option === "--package-archive", `Unknown option: ${option}`);
    assert(archive === null, "--package-archive may be provided only once");
    const value = argv[++index];
    assert(value && !value.startsWith("--"), "--package-archive requires one .tgz path");
    const requested = resolve(value);
    assert(existsSync(requested), `package archive does not exist: ${requested}`);
    archive = realpathSync(requested);
    assert(lstatSync(archive).isFile() && archive.endsWith(".tgz"), `package archive must resolve to a regular .tgz file: ${archive}`);
  }
  return archive;
}

function sha512(file: string): string {
  return createHash("sha512").update(readFileSync(file)).digest("hex");
}

function directorySnapshot(root: string): string {
  const values: Array<[string, string]> = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && entry.name === ".git") continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile()) values.push([name, createHash("sha256").update(readFileSync(file)).digest("hex")]);
      else values.push([name, `<${entry.isSymbolicLink() ? "symlink" : "special"}>`]);
    }
  };
  visit(root);
  return JSON.stringify(values);
}

function isolatedEnvironment(workspace: string, prefix: string): NodeJS.ProcessEnv {
  const home = join(workspace, "home");
  const npmConfig = join(home, ".npmrc");
  mkdirSync(home, { recursive: true });
  writeFileSync(npmConfig, "", "utf8");
  const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    npm_config_prefix: prefix,
    npm_config_cache: join(home, ".npm-cache"),
    npm_config_userconfig: npmConfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    GIT_TERMINAL_PROMPT: "0",
    PATH: [bin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    CI: "1",
  };
  for (const secret of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"]) delete env[secret];
  return env;
}

const sourceRoot = process.cwd();
const requestedArchive = parseArchiveArgument(process.argv.slice(2));
const workspace = mkdtempSync(join(tmpdir(), "hy-thin-package-"));
try {
  const packDirectory = join(workspace, "pack");
  const installRoot = join(workspace, "install");
  const npmPrefix = join(workspace, "npm-prefix");
  const project = join(workspace, "project");
  for (const directory of [packDirectory, installRoot, npmPrefix, project]) mkdirSync(directory, { recursive: true });
  const env = isolatedEnvironment(workspace, npmPrefix);
  const npm = npmInvocation();

  let archive = requestedArchive;
  if (!archive) {
    const packed = runOk(npm.command, [...npm.prefix, "pack", "--json", "--pack-destination", packDirectory], {
      cwd: sourceRoot,
      env,
      timeout: 180_000,
    });
    const report = JSON.parse(packed.stdout);
    assert(Array.isArray(report) && report.length === 1 && typeof report[0]?.filename === "string", "npm pack must produce exactly one candidate tarball");
    archive = realpathSync(join(packDirectory, report[0].filename));
  }
  const archiveDigest = sha512(archive);

  runOk(npm.command, [
    ...npm.prefix,
    "install",
    "--prefix", installRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--fetch-retries=2",
    "--fetch-retry-mintimeout=1000",
    "--fetch-retry-maxtimeout=10000",
    "--fetch-timeout=60000",
    archive,
  ], { cwd: workspace, env, timeout: 240_000 });

  const packageRoot = join(installRoot, "node_modules", "@voxstudio", "hy-workflow");
  const installedPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const main = join(packageRoot, "dist", "main.js");
  assert(installedPackage.name === "@voxstudio/hy-workflow" && installedPackage.bin?.["hy-workflow"] === "dist/main.js", "installed tarball has the wrong package identity or bin");
  assert(existsSync(main) && !existsSync(join(packageRoot, "dist", "server.js")), "installed tarball must expose main.js without the retired MCP server");
  const skills = readdirSync(join(packageRoot, "skills"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert(JSON.stringify(skills) === JSON.stringify(["hy-capture", "hy-init", "hy-verify"]), `installed tarball must contain exactly three Skills, got ${skills.join(", ")}`);

  const version = runOk(process.execPath, [main, "--version"], { cwd: workspace, env });
  assert(version.stdout.trim() === installedPackage.version, "installed CLI version disagrees with its package.json");
  const help = runOk(process.execPath, [main, "--help"], { cwd: workspace, env });
  assert(help.stdout.includes("hy-workflow inspect --json") && help.stdout.includes("hy-workflow verify --input-file"), "installed CLI help does not expose inspect and verify");

  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "thin-acceptance-fixture", private: true, type: "module" }, null, 2)}\n`, "utf8");
  writeFileSync(join(project, "src", "index.js"), "export const answer = 41;\n", "utf8");
  writeFileSync(join(project, "docs", "invariant.md"), "# Runtime invariant\n\nThe changed JavaScript module must remain syntactically valid.\n", "utf8");
  writeFileSync(join(project, "hy-workflow.yml"), [
    "schema: hy-workflow.protocol.v1",
    "obligations:",
    "  - id: INV-SYNTAX-01",
    "    kind: invariant",
    "    status: active",
    "    statement: Changed JavaScript modules remain syntactically valid.",
    "    sources:",
    "      - docs/invariant.md",
    "    applies_to:",
    "      paths:",
    "        - src/**",
    "    verification:",
    "      scale: small",
    "      commands:",
    "        - argv:",
    "            - node",
    "            - --check",
    "            - src/index.js",
    "          expected_exit_code: 0",
    "",
  ].join("\n"), "utf8");
  runOk("git", ["init", "-b", "main"], { cwd: project, env });
  runOk("git", ["config", "user.email", "thin-acceptance@example.invalid"], { cwd: project, env });
  runOk("git", ["config", "user.name", "Thin Acceptance"], { cwd: project, env });
  runOk("git", ["add", "."], { cwd: project, env });
  runOk("git", ["commit", "-m", "create thin acceptance fixture"], { cwd: project, env });
  writeFileSync(join(project, "src", "index.js"), "export const answer = 42;\n", "utf8");
  const projectBefore = directorySnapshot(project);

  const inspectionResult = runOk(process.execPath, [main, "inspect", "--json"], { cwd: project, env });
  const inspection = JSON.parse(inspectionResult.stdout);
  assert(inspection.schema === "hy-workflow.inspect.v1" && inspection.status === "issued" && inspection.ok === true, "installed inspect did not issue a thin protocol obligation");
  assert(inspection.obligations?.length === 1 && inspection.commands?.length === 1 && inspection.binding, "installed inspect did not bind exactly one obligation and command");
  assert(JSON.stringify(inspection.commands[0].argv) === JSON.stringify(["node", "--check", "src/index.js"]), "inspect changed the project-native argv boundary");

  const issued = inspection.commands[0];
  const startedAt = new Date().toISOString();
  const execution = run(issued.argv[0], issued.argv.slice(1), { cwd: project, env });
  const completedAt = new Date().toISOString();
  const evidence = {
    schema: "hy-workflow.evidence.v1",
    binding: inspection.binding,
    results: [{
      commandId: issued.commandId,
      argv: issued.argv,
      startedAt,
      completedAt,
      exitCode: execution.status,
      stdout: execution.stdout,
      stderr: execution.stderr,
    }],
  };
  const evidenceFile = join(workspace, "evidence.json");
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const verifiedResult = runOk(process.execPath, [main, "verify", "--input-file", evidenceFile, "--json"], { cwd: project, env });
  const verified = JSON.parse(verifiedResult.stdout);
  assert(verified.schema === "hy-workflow.verify.v1" && verified.status === "verified" && verified.binding?.matches === true, "installed verify did not accept exact bound evidence");
  assert(verified.summary?.expected === 1 && verified.summary?.passed === 1 && verified.summary?.failed === 0, "installed verify returned the wrong evidence summary");
  assert(directorySnapshot(project) === projectBefore, "inspect or verify mutated the fixture worktree");
  assert(sha512(archive) === archiveDigest, "thin acceptance modified the candidate tarball");

  process.stdout.write(`${JSON.stringify({
    schema: "hy-workflow.thin-acceptance.v1",
    ok: true,
    packageVersion: installedPackage.version,
    archive: basename(archive),
    archiveSha512: archiveDigest,
    skills,
    obligations: inspection.obligations.length,
    commands: inspection.commands.length,
    verification: verified.status,
  })}\n`);
} finally {
  const canonical = realpathSync(workspace);
  assert(dirname(canonical) === realpathSync(tmpdir()) && basename(canonical).startsWith("hy-thin-package-"), `refusing unsafe acceptance cleanup: ${canonical}`);
  rmSync(canonical, { recursive: true, force: true });
}
