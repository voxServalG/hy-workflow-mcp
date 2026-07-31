import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RUNTIME_CONFIG_SOURCE_ENV,
  RUNTIME_CONFIG_SOURCE_SCHEMA,
  projectRuntimeConfigSource,
  resolveRuntimeConfig,
} from "../../src/config.js";
import { configuredBaseBranch } from "../../src/runtime/project.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function config(baseBranch: string): Record<string, unknown> {
  return {
    project: { baseBranch, codeExt: [".ts"], codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLinesWarning: 300, maxLinesError: 500 },
    doclint: { maxLinesWarning: 200, maxLinesError: 500 },
    docsGardener: { catalogs: {} },
    policy: { profile: "standard" },
  };
}

useRuntimeHome("hy-runtime-config-authority-");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-runtime-config-authority-"));
git(root, ["init", "-b", "main"]);
git(root, ["config", "user.email", "test@example.com"]);
git(root, ["config", "user.name", "hy test"]);
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "app.ts"), "export const value = 1;\n");
fs.writeFileSync(path.join(root, "docs", "README.md"), "# Docs\n");
fs.writeFileSync(path.join(root, "hy-workflow.json"), "{ legacy root injection is invalid\n");
git(root, ["add", "."]);
git(root, ["commit", "-m", "initial"]);
git(root, ["branch", "external-main"]);

const external = projectPaths(root).config;
fs.mkdirSync(path.dirname(external), { recursive: true });
fs.writeFileSync(external, JSON.stringify(config("external-main"), null, 2) + "\n");
delete process.env[RUNTIME_CONFIG_SOURCE_ENV];
let resolved = resolveRuntimeConfig(root);
assert(resolved.authority.kind === "external" && resolved.issues.length === 0, "raw pre-existing external config must remain authoritative");
assert(configuredBaseBranch(root) === "external-main", "runtime consumers must use raw external legacy config first");

fs.writeFileSync(path.join(root, "hy-workflow.json"), JSON.stringify(config("main"), null, 2) + "\n");
fs.writeFileSync(external, JSON.stringify(projectRuntimeConfigSource(), null, 2) + "\n");
resolved = resolveRuntimeConfig(root);
assert(resolved.authority.kind === "project" && resolved.issues.length === 0, "exact external marker must authorize the new root config");
assert(configuredBaseBranch(root) === "main", "marker-authorized runtime consumer must use the project config");

fs.rmSync(external);
fs.writeFileSync(path.join(root, "hy-workflow.json"), "{ old invalid injection must stay unread\n");
resolved = resolveRuntimeConfig(root);
assert(resolved.authority.kind === "legacy-detected" && resolved.issues.length === 0, "absent external state must use read-only detection, not the root injection");
assert(resolved.config.codelint.maxLinesWarning === 300 && resolved.config.codelint.maxLinesError === 500, "detected fallback must retain historical code thresholds");
assert(configuredBaseBranch(root) === "main", "detected fallback must remain usable without migration");

fs.writeFileSync(path.join(root, "hy-workflow.json"), JSON.stringify(config("external-main"), null, 2) + "\n");
process.env[RUNTIME_CONFIG_SOURCE_ENV] = RUNTIME_CONFIG_SOURCE_SCHEMA;
resolved = resolveRuntimeConfig(root);
assert(resolved.authority.kind === "project" && configuredBaseBranch(root) === "external-main", "exact new-workflow signal must authorize project config on a clean runner");

process.env[RUNTIME_CONFIG_SOURCE_ENV] = "unknown-or-old-workflow";
fs.writeFileSync(path.join(root, "hy-workflow.json"), "{ mismatched signal must not authorize this\n");
resolved = resolveRuntimeConfig(root);
assert(resolved.authority.kind === "legacy-detected" && configuredBaseBranch(root) === "main", "unknown workflow signal must not authorize a legacy root injection");
delete process.env[RUNTIME_CONFIG_SOURCE_ENV];

console.log("runtime-config-source: external, marker, detected fallback, and exact CI signal precedence passes");
