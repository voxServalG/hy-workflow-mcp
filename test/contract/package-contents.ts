import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackFile = { path?: unknown };
type PackEntry = { files?: unknown };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function npmPackDryRun(root: string): string[] {
  const npmExecPath = process.env.npm_execpath;
  assert(npmExecPath && existsSync(npmExecPath), "npm_execpath is required; run this contract through npm");
  const result = spawnSync(process.execPath, [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
  });
  assert(!result.error, `npm pack failed to start: ${result.error?.message ?? "unknown error"}`);
  assert(result.status === 0, `npm pack --dry-run failed (${String(result.status)}):\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const entries: PackEntry[] = Array.isArray(report)
    ? report
    : report && typeof report === "object"
      ? Object.values(report)
      : [];
  return entries.flatMap(entry => Array.isArray(entry?.files)
    ? (entry.files as PackFile[]).flatMap(file => typeof file?.path === "string" ? [file.path] : [])
    : []).sort();
}

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert(pkg.name === "@voxstudio/hy-workflow", "package name drifted");
assert(pkg.version === "0.6.0", "this release contract is for v0.6.0");
assert(pkg.publishConfig?.access === "public", "scoped package must publish publicly");
assert(pkg.engines?.node === ">=18", "package must retain the Node 18 runtime floor");
assert(pkg.main === "dist/main.js" && pkg.bin?.["hy-workflow"] === "dist/main.js", "main and bin must share the thin CLI entrypoint");
assert(pkg.scripts?.clean === "node scripts/clean-dist.mjs", "clean must use the cross-platform dist cleaner");
assert(pkg.scripts?.build === "npm run clean && tsc", "build must start from an empty dist directory");
assert(pkg.scripts?.prepack === "npm run build", "prepack must build from clean source");
assert(pkg.scripts?.prepublishOnly === "npm run verify", "direct npm publication must retain the verify gate");
for (const lifecycle of ["prepare", "install", "postinstall"]) {
  assert(pkg.scripts?.[lifecycle] === undefined, `${lifecycle} must not execute code during package installation`);
}
for (const script of ["test:contract", "test:acceptance:thin", "test:acceptance:migration", "test:windows", "verify"]) {
  assert(typeof pkg.scripts?.[script] === "string", `missing release-facing npm script: ${script}`);
}

const expectedFiles = ["dist", "schemas", "templates", "skills", "LICENSE", "README.md"].sort();
assert(JSON.stringify([...(pkg.files ?? [])].sort()) === JSON.stringify(expectedFiles), "package files allowlist must contain only the thin runtime, protocol assets, Skills, and legal/readme files");

const files = npmPackDryRun(root);
for (const required of [
  "dist/main.js",
  "LICENSE",
  "README.md",
  "schemas/hy-workflow.evidence.schema.json",
  "schemas/hy-workflow.protocol.schema.json",
  "templates/hy-workflow.yml",
  "skills/hy-init/SKILL.md",
  "skills/hy-verify/SKILL.md",
  "skills/hy-capture/SKILL.md",
]) {
  assert(files.includes(required), `npm package is missing ${required}`);
}

const skillNames = [...new Set(files.flatMap(file => {
  const match = /^skills\/([^/]+)\//.exec(file);
  return match ? [match[1]] : [];
}))].sort();
assert(JSON.stringify(skillNames) === JSON.stringify(["hy-capture", "hy-init", "hy-verify"]), `npm package must contain exactly three Skills, got ${skillNames.join(", ")}`);
const schemas = files.filter(file => file.startsWith("schemas/"));
assert(JSON.stringify(schemas) === JSON.stringify(["schemas/hy-workflow.evidence.schema.json", "schemas/hy-workflow.protocol.schema.json"]), "npm package must expose exactly the two thin protocol schemas");
const templates = files.filter(file => file.startsWith("templates/"));
assert(JSON.stringify(templates) === JSON.stringify(["templates/hy-workflow.yml"]), "npm package must expose only the thin Git protocol template");

const retiredPrefixes = ["docs/", "src/", "test/", "scripts/", ".github/", ".codex/", ".opencode/"];
for (const file of files) {
  assert(!retiredPrefixes.some(prefix => file.startsWith(prefix)), `npm package exposes repository-only or retired surface: ${file}`);
  assert(!/\.(?:orig|rej)$/.test(file), `npm package contains patch residue: ${file}`);
}
for (const retired of [
  "dist/server.js",
  "schemas/hy-workflow.schema.json",
  "templates/lint/index.mjs",
  "AGENTS.md",
  "hy-workflow.json",
  "skills/hy-plan/SKILL.md",
  "skills/hy-status/SKILL.md",
  "skills/hy-commit/SKILL.md",
]) {
  assert(!files.includes(retired), `npm package still exposes retired surface: ${retired}`);
}

const tracked = spawnSync("git", ["ls-files", "--", "dist"], { cwd: root, encoding: "utf8", shell: false, timeout: 30_000 });
assert(!tracked.error && tracked.status === 0, `git ls-files failed: ${tracked.stderr}`);
assert(tracked.stdout.trim() === "", "compiled dist files must not be tracked by Git");

process.stdout.write(`package-contents: ${files.length} packed files satisfy the thin allowlist and retired-surface exclusions\n`);
