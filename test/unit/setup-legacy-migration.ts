import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { scanLegacyClientConfigs, migrateLegacyClientConfigs } from "../../src/setup/legacy-migration.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const originalCwd = cwd();
const root = mkdtempSync(join(tmpdir(), "hy-legacy-"));
const stateHome = join(root, ".local", "state");
mkdirSync(stateHome, { recursive: true });
mkdirSync(join(root, ".config"), { recursive: true });
mkdirSync(join(root, ".cache"), { recursive: true });
process.env.HY_WORKFLOW_STATE_HOME = stateHome;
process.env.HY_WORKFLOW_CONFIG_HOME = join(root, ".config");
process.env.HY_WORKFLOW_CACHE_HOME = join(root, ".cache");

try {
  chdir(root);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/example/test.git\n");
  mkdirSync(join(root, ".opencode"));
  writeFileSync(join(root, ".opencode", "opencode.json"), JSON.stringify({
    mcp: {
      "hy-workflow": { command: "npx", args: ["-y", "--prefer-online", "github:voxServalG/hy-workflow-mcp"] },
      "docs-gardener": { command: "npx", args: ["-y", "github:voxServalG/docs-gardener", "mcp"] },
      "other-server": { command: "something" },
    },
  }, null, 2));
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "config.toml"), "[mcp_servers.hy-workflow]\ncommand = \"npx\"\nargs = [\"-y\", \"github:voxServalG/hy-workflow-mcp\"]\n");

  const findings = scanLegacyClientConfigs(root);
  assert(findings.some(f => f.source === ".opencode/opencode.json" && f.server === "hy-workflow"), "should find opencode hy-workflow");
  assert(findings.some(f => f.source === ".codex/config.toml" && f.server === "hy-workflow"), "should find codex hy-workflow");

  // Before migration, files exist
  assert(existsSync(join(root, ".opencode", "opencode.json")), ".opencode should exist pre-migration");

  // Migrate with no adapters (user-scope install skipped; only backup+moves run)
  const report = migrateLegacyClientConfigs(root, []);
  assert(report.moved.includes(".opencode/opencode.json"), ".opencode/opencode.json should be moved");
  assert(report.moved.includes(".codex/config.toml"), ".codex/config.toml should be moved");
  assert(!existsSync(join(root, ".opencode", "opencode.json")), ".opencode/opencode.json should be gone after migration");
  assert(!existsSync(join(root, ".codex", "config.toml")), ".codex/config.toml should be gone after migration");
  assert(existsSync(join(root, ".hy-cleanup-backup")), ".hy-cleanup-backup dir should exist");

  console.log("setup-legacy-migration: scan and backup-move paths pass");
} finally {
  chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}
