import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runCheckCommand } from "../dist/checks.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const npmExecPath = process.env.npm_execpath;
if (!npmExecPath || !existsSync(npmExecPath)) {
  throw new Error("Windows smoke must be run via npm run test:windows so npm_execpath resolves npm-cli.js");
}
const npmCommand = process.execPath;
const npmCommandPrefix = [npmExecPath];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(label, command, args, options = {}) {
  const result = runCheckCommand(
    { file: command, args },
    options.cwd ?? sourceRoot,
    options.timeout ?? 180_000,
    options.env ?? process.env,
  );
  if (!result.ok) {
    throw new Error(`${label} failed (${result.timedOut ? `timeout after ${result.timeoutMs}ms` : result.status === null ? "unknown exit" : `exit ${result.status}`}):\n${(result.stderr || result.stdout || "").slice(-8_000)}`);
  }
  return result.stdout.trim();
}

function runJson(label, command, args, options = {}) {
  const output = run(label, command, args, options);
  try { return JSON.parse(output); }
  catch { throw new Error(`${label} returned invalid JSON:\n${output.slice(-8_000)}`); }
}

function treeBytes(root) {
  if (!existsSync(root)) return "<absent>";
  const snapshot = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!prefix && entry.name === ".git") continue;
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push([name + "/", null]);
        visit(file, name);
      } else if (entry.isFile()) snapshot.push([name, readFileSync(file).toString("base64")]);
      else snapshot.push([name, "<" + (entry.isSymbolicLink() ? "symlink" : "special") + ">"]);
    }
  };
  visit(root);
  return JSON.stringify(snapshot);
}

function pathInside(base, target) {
  const suffix = relative(resolve(base), resolve(target));
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

const npmVersion = run("npm CLI", npmCommand, [...npmCommandPrefix, "--version"], { timeout: 30_000 });
assert(/^\d+\.\d+\.\d+/.test(npmVersion), `npm CLI returned an invalid version: ${npmVersion}`);

for (const test of [
  "test/unit/compile-lint-checks.ts",
  "test/unit/project-profile.ts",
  "test/unit/lint-cli.ts",
  "test/unit/helper-cli.ts",
  "test/unit/skills-cli.ts",
  "test/contract/npm-release-provenance.ts",
]) {
  run(`focused test ${test}`, process.execPath, [tsxCli, test], { timeout: 180_000 });
}

const workspace = mkdtempSync(join(tmpdir(), "hy-workflow-windows-smoke-"));
try {
  const packDir = join(workspace, "pack");
  const prefix = join(workspace, "npm-prefix");
  const home = join(workspace, "home");
  const project = join(workspace, "project");
  const prefixBin = process.platform === "win32" ? prefix : join(prefix, "bin");
  for (const directory of [packDir, prefix, home, project]) mkdirSync(directory, { recursive: true });

  const npmUserConfig = join(home, ".npmrc");
  writeFileSync(npmUserConfig, "", "utf8");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: join(home, ".codex"),
    OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.json"),
    HY_WORKFLOW_CONFIG_HOME: join(home, "hy-workflow-config"),
    HY_WORKFLOW_STATE_HOME: join(home, "hy-workflow-state"),
    HY_WORKFLOW_CACHE_HOME: join(home, "hy-workflow-cache"),
    npm_config_prefix: prefix,
    npm_config_cache: join(home, ".npm-cache"),
    npm_config_userconfig: npmUserConfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    GIT_TERMINAL_PROMPT: "0",
    PATH: [prefixBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    CI: "1",
  };
  for (const secret of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"]) delete env[secret];

  const packReport = runJson("npm pack", npmCommand, [...npmCommandPrefix, "pack", "--json", "--pack-destination", packDir], { env, timeout: 300_000 });
  assert(Array.isArray(packReport) && packReport.length === 1 && typeof packReport[0]?.filename === "string", "npm pack must produce exactly one tarball");
  const archive = join(packDir, packReport[0].filename);
  assert(existsSync(archive), "npm pack report points to a missing tarball");
  run("global tarball install", npmCommand, [
    ...npmCommandPrefix, "install", "--global", archive, "@voxstudio/docs-gardener@1.0.0-next.0", "--no-audit", "--no-fund",
  ], { env, timeout: 300_000 });
  const globalRoot = run("npm global root", npmCommand, [...npmCommandPrefix, "root", "--global"], { env, timeout: 30_000 });
  const installedPackage = join(globalRoot, "@voxstudio", "hy-workflow");
  const installedMain = join(installedPackage, "dist", "main.js");
  const installedSkill = join(installedPackage, "skills", "hy-init", "SKILL.md");
  const installedBin = process.platform === "win32" ? join(prefix, "hy-workflow.cmd") : join(prefix, "bin", "hy-workflow");
  assert(existsSync(installedMain) && existsSync(installedBin), "global tarball install did not expose the compiled CLI and bin");
  assert(existsSync(installedSkill), "global tarball install did not include skills/hy-init/SKILL.md");
  const expectedVersion = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version;
  assert(run("installed version", process.execPath, [installedMain, "--version"], { env, timeout: 30_000 }) === expectedVersion, "installed CLI version drifted from package.json");

  const installedSkills = runJson("installed skills list", process.execPath, [installedMain, "skills", "list", "--json"], { cwd: workspace, env, timeout: 30_000 });
  assert(installedSkills.schema === "hy-workflow.skills.v1" && installedSkills.package?.version === expectedVersion, "installed skills list did not identify the versioned running package");
  assert(installedSkills.count === 12 && /^[a-f0-9]{64}$/.test(installedSkills.package?.bundleHash ?? ""), "installed skills list did not expose the exact twelve-Skill bundle and its hash");
  const installedStatusSkillPath = join(installedPackage, "skills", "hy-status", "SKILL.md");
  const expectedStatusSkill = readFileSync(installedStatusSkillPath, "utf8").trim();
  const installedStatusSkill = run("installed skills read", process.execPath, [installedMain, "skills", "read", "hy-status"], { cwd: workspace, env, timeout: 30_000 });
  assert(installedStatusSkill === expectedStatusSkill, "installed raw skills read drifted from the packaged hy-status/SKILL.md content");
  const installedStatusSkillJson = runJson("installed skills JSON read", process.execPath, [installedMain, "skills", "read", "hy-status", "SKILL.md", "--json"], { cwd: workspace, env, timeout: 30_000 });
  assert(installedStatusSkillJson.schema === "hy-workflow.skills.v1" && installedStatusSkillJson.package?.version === expectedVersion && installedStatusSkillJson.package?.bundleHash === installedSkills.package.bundleHash, "installed JSON skills read did not identify the same package and bundle");
  assert(installedStatusSkillJson.skill === "hy-status" && installedStatusSkillJson.path === "SKILL.md" && installedStatusSkillJson.content?.trim() === expectedStatusSkill, "installed JSON skills read did not return the packaged hy-status Skill");

  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(join(project, "src", "index.js"), "export const value = 1;\n", "utf8");
  writeFileSync(join(project, "docs", "index.md"), "# Windows smoke\n\nThe installed helper must project Skills without changing this project.\n", "utf8");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "windows-smoke-fixture", private: true, type: "module" }, null, 2) + "\n", "utf8");
  run("git init", "git", ["init", "-b", "main"], { cwd: project, env, timeout: 30_000 });
  run("git email", "git", ["config", "user.email", "windows-smoke@example.invalid"], { cwd: project, env, timeout: 30_000 });
  run("git name", "git", ["config", "user.name", "Windows Smoke"], { cwd: project, env, timeout: 30_000 });
  run("git add", "git", ["add", "."], { cwd: project, env, timeout: 30_000 });
  run("git commit", "git", ["commit", "-m", "fixture"], { cwd: project, env, timeout: 30_000 });

  const lint = runJson("installed lint", process.execPath, [installedMain, "lint", "--json"], { cwd: project, env, timeout: 120_000 });
  assert(lint.schema === "hy-workflow.lint.v1" && lint.counts?.checks === 10 && lint.counts?.errors === 0 && lint.counts?.docs > 0, "installed tarball lint did not return the clean ten-rule report");

  const projectBeforeHelper = treeBytes(project);
  const gitBeforeHelper = run("git status before helper", "git", ["status", "--porcelain"], { cwd: project, env, timeout: 30_000 });
  const helperArgs = [installedMain, "helper", "install", "--clients", "codex", "--mode", "copy", "--json"];
  const install = runJson("installed helper install", process.execPath, helperArgs, { cwd: project, env, timeout: 120_000 });
  assert(install.schema === "hy-workflow.helper.v1" && install.command === "install" && install.ok === true && install.status === "completed", "installed helper did not return a successful versioned envelope");
  assert(Object.keys(install.layers ?? {}).sort().join(",") === "mcp,project,skills", "helper install must report exactly the skills, project, and mcp layers");
  assert(install.layers.skills?.status === "installed" && install.layers.skills?.skillCount === 12, "helper install did not project the exact twelve-Skill bundle");
  assert(install.layers.project?.status === "registered" && install.layers.mcp?.status === "unchanged", "helper install did not register external project state and report the clean MCP retirement layer");
  assert(Array.isArray(install.projectFilesChanged) && install.projectFilesChanged.length === 0 && install.layers.project?.projectFilesChanged?.length === 0, "helper install must report projectFilesChanged=[] at both envelope and project layer");
  assert(install.layers.project?.projectFiles?.length === 0, "helper deployment must own no project files");
  assert(treeBytes(project) === projectBeforeHelper && run("git status after helper", "git", ["status", "--porcelain"], { cwd: project, env, timeout: 30_000 }) === gitBeforeHelper, "helper install changed the Git worktree");
  assert(!existsSync(join(project, "hy-workflow.json")) && !existsSync(join(project, ".github", "workflows", "hy-workflow.yml")), "helper install injected project configuration or a GitHub workflow");

  const targetRoot = install.layers.skills.targets?.[0]?.skillsDir;
  const skillManifest = install.layers.skills.changedPaths?.find(file => file.endsWith("skill-ownership.json"));
  const canonicalRoot = install.layers.skills.changedPaths?.[0];
  assert(typeof targetRoot === "string" && existsSync(join(targetRoot, "hy-init", "SKILL.md")), "helper install did not expose hy-init in the selected global Agent Skill directory");
  assert(typeof skillManifest === "string" && existsSync(skillManifest), "helper install did not create its external Skill ownership manifest");
  assert(typeof canonicalRoot === "string" && existsSync(join(canonicalRoot, "hy-init", "SKILL.md")), "helper install did not create its external canonical Skill bundle");

  const repeated = runJson("repeated installed helper install", process.execPath, helperArgs, { cwd: project, env, timeout: 120_000 });
  assert(repeated.ok === true && repeated.layers.skills?.status === "unchanged" && repeated.layers.project?.status === "preserved" && repeated.layers.mcp?.status === "unchanged", "repeated helper install was not idempotent");
  assert(repeated.projectFilesChanged?.length === 0 && treeBytes(project) === projectBeforeHelper, "repeated helper install changed project bytes");

  const homeBeforeStatus = treeBytes(home);
  const status = runJson("installed helper status", process.execPath, [installedMain, "helper", "status", "--json"], { cwd: project, env, timeout: 120_000 });
  assert(status.schema === "hy-workflow.helper.v1" && status.command === "status" && status.ok === true && status.status === "completed", "helper status did not return a healthy versioned envelope");
  assert(status.layers.skills?.status === "healthy" && status.layers.project?.status === "registered" && status.layers.mcp?.status === "unchanged", "helper status did not report healthy Skill, project, and MCP layers");
  assert(status.projectFilesChanged?.length === 0 && treeBytes(home) === homeBeforeStatus && treeBytes(project) === projectBeforeHelper, "helper status was not read-only");

  const projectRegistrationFiles = (install.layers.project.localFilesChanged ?? []).filter(file => existsSync(file));
  const projectRegistrationBytes = new Map(projectRegistrationFiles.map(file => [file, readFileSync(file).toString("base64")]));
  const remove = runJson("installed helper remove", process.execPath, [installedMain, "helper", "remove", "--json"], { cwd: project, env, timeout: 120_000 });
  assert(remove.schema === "hy-workflow.helper.v1" && remove.command === "remove" && remove.ok === true && remove.status === "completed", "helper remove did not return a successful versioned envelope");
  assert(remove.layers.skills?.status === "removed" && remove.layers.project?.status === "preserved" && remove.layers.mcp?.status === "preserved", "helper remove did not limit itself to the owned Skill layer");
  assert(remove.projectFilesChanged?.length === 0 && remove.layers.project?.projectFilesChanged?.length === 0, "helper remove must report projectFilesChanged=[]");
  assert(!existsSync(join(targetRoot, "hy-init")) && !existsSync(canonicalRoot) && !existsSync(skillManifest), "helper remove left an owned Skill projection, canonical bundle, or ownership manifest");
  assert(existsSync(installedSkill), "helper remove deleted the immutable Skill source inside the installed npm package");
  assert((remove.layers.skills.changedPaths ?? []).every(file => file === skillManifest || file === canonicalRoot || pathInside(targetRoot, file)), "helper remove reported a mutation outside its owned Skill projection resources");
  for (const [file, bytes] of projectRegistrationBytes) assert(existsSync(file) && readFileSync(file).toString("base64") === bytes, "helper remove changed external project registration bytes: " + file);
  assert(treeBytes(project) === projectBeforeHelper && run("git status after helper remove", "git", ["status", "--porcelain"], { cwd: project, env, timeout: 30_000 }) === gitBeforeHelper, "helper remove changed project bytes");
  for (const forbidden of [".hy", ".codex", ".opencode", ".mcp.json", "codelint.json", "doclint.json", "docs-gardener.json"]) {
    assert(!existsSync(join(project, forbidden)), "helper lifecycle left project-local runtime artifact " + forbidden);
  }
  assert(readdirSync(packDir).filter(name => name.endsWith(".tgz")).length === 1, "Windows smoke must test one concrete tarball");
  process.stdout.write("windows-smoke: focused tests, installed Skill self-inspection, lint, and helper install/status/remove pass\n");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
