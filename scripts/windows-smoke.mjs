import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourceRoot = realpathSync(new URL("..", import.meta.url));
const npmExecPath = process.env.npm_execpath;
assert(npmExecPath && existsSync(npmExecPath), "Windows smoke must run through npm so npm_execpath identifies npm-cli.js");
const npmCommand = process.execPath;
const npmPrefix = [npmExecPath];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? sourceRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(!result.error, `${command} failed to start: ${result.error?.message ?? "unknown error"}`);
  assert(result.status === 0, `${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function json(command, args, options = {}) {
  const output = run(command, args, options);
  try {
    return JSON.parse(output.trim());
  } catch {
    throw new Error(`${command} returned invalid JSON:\n${output.slice(-8_000)}`);
  }
}

function helperSkills(envelope) {
  return envelope?.skills ?? envelope?.layers?.skills;
}

function treeBytes(root) {
  if (!existsSync(root)) return "<absent>";
  const values = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!prefix && entry.name === ".git") continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file, name);
      else if (entry.isFile()) values.push([name, readFileSync(file).toString("base64")]);
      else values.push([name, entry.isSymbolicLink() ? "symlink" : "special"]);
    }
  };
  visit(root);
  return JSON.stringify(values);
}

const workspace = mkdtempSync(join(tmpdir(), "hy-windows-installed-smoke-"));
try {
  const home = join(workspace, "home");
  const packDirectory = join(workspace, "pack");
  const installRoot = join(workspace, "install");
  const project = join(workspace, "project");
  const codexHome = join(home, ".codex");
  const npmConfig = join(home, ".npmrc");
  for (const directory of [home, packDirectory, installRoot, project, codexHome]) mkdirSync(directory, { recursive: true });
  writeFileSync(npmConfig, "", "utf8");
  const installBin = join(installRoot, "node_modules", ".bin");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: codexHome,
    HY_WORKFLOW_CONFIG_HOME: join(home, "hy-workflow-config"),
    HY_WORKFLOW_STATE_HOME: join(home, "hy-workflow-state"),
    HY_WORKFLOW_CACHE_HOME: join(home, "hy-workflow-cache"),
    npm_config_cache: join(home, ".npm-cache"),
    npm_config_userconfig: npmConfig,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    GIT_TERMINAL_PROMPT: "0",
    PATH: [installBin, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
    CI: "1",
  };
  for (const secret of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"]) delete env[secret];

  const report = json(npmCommand, [...npmPrefix, "pack", "--json", "--pack-destination", packDirectory], {
    cwd: sourceRoot,
    env,
    timeout: 180_000,
  });
  assert(Array.isArray(report) && report.length === 1 && typeof report[0]?.filename === "string", "npm pack must produce exactly one tarball");
  const archive = realpathSync(join(packDirectory, report[0].filename));
  const archiveSha512 = createHash("sha512").update(readFileSync(archive)).digest("hex");
  run(npmCommand, [
    ...npmPrefix,
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
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const main = join(packageRoot, "dist", "main.js");
  const shim = join(installBin, process.platform === "win32" ? "hy-workflow.cmd" : "hy-workflow");
  assert(pkg.name === "@voxstudio/hy-workflow" && pkg.bin?.["hy-workflow"] === "dist/main.js", "installed package identity or bin mapping drifted");
  assert(existsSync(main) && existsSync(shim), "npm install did not expose the compiled CLI and platform bin shim");
  assert(!existsSync(join(packageRoot, "dist", "server.js")), "installed package contains the retired MCP server");
  const packagedSkills = readdirSync(join(packageRoot, "skills"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert(JSON.stringify(packagedSkills) === JSON.stringify(["hy-capture", "hy-init", "hy-verify"]), "installed package must contain exactly three Skills");
  assert(run(process.execPath, [main, "--version"], { cwd: workspace, env }).trim() === pkg.version, "installed --version disagrees with package.json");
  const help = run(process.execPath, [main, "--help"], { cwd: workspace, env });
  assert(help.includes("hy-workflow inspect --json") && help.includes("hy-workflow verify --input-file"), "installed CLI help is missing the thin protocol commands");

  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "windows-installed-smoke", private: true, type: "module" }, null, 2)}\n`, "utf8");
  writeFileSync(join(project, "src", "index.js"), "export const windowsSmoke = true;\n", "utf8");
  run("git", ["init", "-b", "main"], { cwd: project, env });
  run("git", ["config", "user.email", "windows-smoke@example.invalid"], { cwd: project, env });
  run("git", ["config", "user.name", "Windows Smoke"], { cwd: project, env });
  run("git", ["add", "."], { cwd: project, env });
  run("git", ["commit", "-m", "create Windows smoke fixture"], { cwd: project, env });
  const projectBefore = treeBytes(project);

  const foreign = join(codexHome, "skills", "team-owned-sentinel", "SKILL.md");
  const foreignBytes = Buffer.from("---\nname: team-owned-sentinel\ndescription: Foreign Windows Skill.\n---\n\nPreserve byte-for-byte.\r\n", "utf8");
  mkdirSync(dirname(foreign), { recursive: true });
  writeFileSync(foreign, foreignBytes);
  const install = json(process.execPath, [main, "helper", "install", "--clients", "codex", "--mode", "copy", "--json"], {
    cwd: project,
    env,
    timeout: 120_000,
  });
  assert(install.schema === "hy-workflow.helper.v2" && install.ok === true && install.command === "install", "installed helper install did not return a successful v2 envelope");
  assert(helperSkills(install)?.skillCount === 3, "installed helper did not project exactly three Skills");
  for (const skill of packagedSkills) assert(existsSync(join(codexHome, "skills", skill, "SKILL.md")), `installed helper omitted ${skill}`);
  assert(readFileSync(foreign).equals(foreignBytes), "helper install changed a foreign Skill");
  assert(treeBytes(project) === projectBefore, "helper install changed the Git project");

  const status = json(process.execPath, [main, "helper", "status", "--json"], { cwd: project, env, timeout: 60_000 });
  assert(status.schema === "hy-workflow.helper.v2" && status.ok === true && helperSkills(status)?.status === "healthy", "installed helper status is not healthy");
  assert(readFileSync(foreign).equals(foreignBytes) && treeBytes(project) === projectBefore, "helper status was not read-only");

  const remove = json(process.execPath, [main, "helper", "remove", "--json"], { cwd: project, env, timeout: 120_000 });
  assert(remove.schema === "hy-workflow.helper.v2" && remove.ok === true && helperSkills(remove)?.status === "removed", "installed helper remove did not remove its owned projection");
  for (const skill of packagedSkills) assert(!existsSync(join(codexHome, "skills", skill)), `helper remove left owned Skill ${skill}`);
  assert(readFileSync(foreign).equals(foreignBytes), "helper remove changed a foreign Skill");
  assert(treeBytes(project) === projectBefore, "helper remove changed the Git project");
  assert(createHash("sha512").update(readFileSync(archive)).digest("hex") === archiveSha512, "Windows smoke modified the tested tarball");

  process.stdout.write(`windows-smoke: installed ${pkg.name}@${pkg.version}, native shim, three-Skill helper lifecycle, and foreign/project preservation pass on ${process.platform}\n`);
} finally {
  const canonical = realpathSync(workspace);
  assert(dirname(canonical) === realpathSync(tmpdir()) && basename(canonical).startsWith("hy-windows-installed-smoke-"), `refusing unsafe Windows smoke cleanup: ${canonical}`);
  rmSync(canonical, { recursive: true, force: true });
}
