import * as fs from "node:fs";
import * as path from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const installCommand = "npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest";
const mirrorInstallCommand = `${installCommand} --registry=https://registry.npmmirror.com`;
const setupCommand = "hy-workflow setup";

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf-8");
}

const readme = read("README.md");
const setupDoc = read("docs/setup.md");
const bootstrap = read("src/bootstrap.ts");
const setupPs1 = read("setup.ps1");
const setup = read("setup");
const workflow = read(".github/workflows/hy-workflow.yml");

assert(readme.includes(installCommand), "README should document the scoped npm install command");
assert(readme.includes(setupCommand), "README should document the installed setup command");
assert(readme.includes("command = \"hy-workflow\""), "README should configure Codex with the direct hy-workflow command");
assert(readme.includes("command = \"docs-gardener\""), "README should configure Codex with the direct docs-gardener command");

assert(setupDoc.includes(installCommand), "docs/setup.md should document the scoped npm install command");
assert(setupDoc.includes(mirrorInstallCommand), "docs/setup.md should document the optional mainland mirror");
assert(setupDoc.includes(setupCommand), "docs/setup.md should document hy-workflow setup");

assert(bootstrap.includes(installCommand), "bootstrap should tell outdated downstreams to update both npm packages");
assert(bootstrap.includes(setupCommand), "bootstrap should tell outdated downstreams to rerun setup");

assert(setupPs1.includes(setupCommand), "setup.ps1 should delegate to the installed npm CLI");
assert(setupPs1.includes("@voxstudio/hy-workflow@latest"), "setup.ps1 should explain how to install the npm CLI");
assert(!setupPs1.includes("raw.githubusercontent.com"), "setup.ps1 should not download runtime code from GitHub");
assert(!setupPs1.includes("hy-harness"), "setup.ps1 should not call hy-harness");
assert(!setupPs1.includes(".github/workflows/hy-workflow.yml"), "setup.ps1 should not embed bootstrap artifact generation");

assert(setup.includes('"setup.ps1"'), "setup-generated workflow should include setup.ps1 in path filters");
assert(workflow.includes('"setup.ps1"'), "checked-in workflow should include setup.ps1 in path filters");
assert(setup.includes('".github/workflows/**"'), "setup-generated CI should validate workflow-only changes");
assert(workflow.includes('".github/workflows/**"'), "checked-in CI should validate workflow-only changes");

assert(setup.includes(installCommand), "setup prompt should install both scoped npm packages");
assert(setup.includes(mirrorInstallCommand), "setup prompt should offer the optional mainland mirror");
assert(setup.includes("hy-workflow: command = hy-workflow，无 args"), "setup prompt should use the direct hy-workflow command");
assert(setup.includes("docs-gardener: command = docs-gardener，args = [mcp]"), "setup prompt should use the direct docs-gardener command");
assert(!setup.includes("git+https://github.com/voxServalG/hy-workflow-mcp.git"), "setup prompt should not install hy-workflow from GitHub");
assert(!setup.includes("git+https://github.com/voxServalG/docs-gardener.git"), "setup prompt should not install docs-gardener from GitHub");

console.log("setup-entrypoints: npm install and direct MCP commands are consistent");
