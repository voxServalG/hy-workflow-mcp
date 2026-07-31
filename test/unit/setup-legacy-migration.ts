import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrateLegacyClientConfigs, scanLegacyClientConfigs } from "../../src/setup/legacy-migration.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-legacy-inert-"));
const files = new Map<string, string>([
  [".mcp.json", JSON.stringify({ mcpServers: { "hy-workflow": { command: "old" } } }) + "\n"],
  [path.join(".opencode", "opencode.json"), JSON.stringify({ mcp: { "docs-gardener": { command: "old" } } }) + "\n"],
  [path.join(".codex", "config.toml"), "[mcp_servers.hy-workflow]\ncommand = 'old'\n"],
]);
for (const [relative, content] of files) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

assert(scanLegacyClientConfigs(root).length === 0, "retired scanner must not inspect project-local injections");
const report = migrateLegacyClientConfigs(root, []);
assert(report.backupDir === "" && report.moved.length === 0 && report.installedUserScope.length === 0, "retired migration must be a no-op");
for (const [relative, content] of files) {
  assert(fs.readFileSync(path.join(root, relative), "utf-8") === content, `legacy migration touched ${relative}`);
}
assert(!fs.existsSync(path.join(root, ".hy-cleanup-backup")), "retired migration must not create a backup or dirty the worktree");

console.log("setup-legacy-migration: historical client injections are untouched and ignored");
