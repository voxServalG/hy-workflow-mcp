import * as fs from "node:fs";
import * as path from "node:path";
import { setupHelp } from "../../src/setup-cli.js";
import { MCP_DEFINITIONS } from "../../src/setup/types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf-8");
const installCommand = "npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest";
const help = setupHelp();
const pkg = JSON.parse(read("package.json"));

assert(!fs.existsSync(path.join(root, "setup")), "legacy Bash setup entrypoint must be removed");
assert(!fs.existsSync(path.join(root, "setup.ps1")), "legacy PowerShell setup entrypoint must be removed");
assert(pkg.files.includes("templates") && !pkg.files.includes("setup") && !pkg.files.includes("setup.ps1"), "npm files must package templates, not platform scripts");

for (const token of ["hy-workflow setup", "hy-workflow unset", "--clients", "--yes", "--json", "--dry-run", "--shared", "--remove-global"]) {
  assert(help.includes(token), `setup help should include ${token}`);
}
assert(MCP_DEFINITIONS["hy-workflow"].command === "hy-workflow" && MCP_DEFINITIONS["hy-workflow"].args.length === 0, "hy-workflow MCP should use the installed binary directly");
assert(MCP_DEFINITIONS["docs-gardener"].command === "docs-gardener" && MCP_DEFINITIONS["docs-gardener"].args.join(" ") === "mcp", "docs-gardener MCP should use the installed binary directly");

const template = read("templates/hy-workflow.yml");
const workflow = read(".github/workflows/hy-workflow.yml");
assert(template === workflow, "checked-in shared workflow must match the packaged template exactly");
assert(!template.includes('"setup"') && !template.includes('"setup.ps1"'), "shared workflow must not reference removed installers");

for (const file of ["README.md", "docs/setup.md"]) {
  const content = read(file);
  assert(content.includes(installCommand), `${file} should document npm installation`);
  assert(content.includes("hy-workflow setup"), `${file} should document the setup TUI`);
  assert(content.includes("hy-workflow unset"), `${file} should document reversible project removal`);
}

console.log("setup-entrypoints: one Node CLI, direct MCP commands, and packaged template are consistent");
