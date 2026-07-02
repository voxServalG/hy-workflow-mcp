import * as fs from "node:fs";
import * as path from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const setupUrl = "https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup";
const bashCommand = `curl -fsSL ${setupUrl} | bash`;
const powershellCommand = `curl.exe -fsSL ${setupUrl} | bash`;

function read(file: string): string {
  return fs.readFileSync(path.join(root, file), "utf-8");
}

const readme = read("README.md");
const setupDoc = read("docs/setup.md");
const bootstrap = read("src/bootstrap.ts");
const setupPs1 = read("setup.ps1");
const setup = read("setup");
const workflow = read(".github/workflows/hy-workflow.yml");

assert(readme.includes(powershellCommand), "README should document the Windows PowerShell curl.exe setup command");
assert(readme.includes(bashCommand), "README should document the macOS/Linux/Git Bash setup command");
assert(!readme.includes("setup.ps1 | iex"), "README should not recommend setup.ps1 as the primary Windows setup path");

assert(setupDoc.includes(powershellCommand), "docs/setup.md should document the Windows PowerShell curl.exe setup command");
assert(setupDoc.includes(bashCommand), "docs/setup.md should document the bash setup command");
assert(setupDoc.includes("PowerShell must use `curl.exe`"), "docs/setup.md should explain why curl.exe is required");

assert(bootstrap.includes(`SETUP_COMMAND = "${bashCommand}"`), "bootstrap should expose the canonical bash setup command");
assert(bootstrap.includes(`WINDOWS_SETUP_COMMAND = "${powershellCommand}"`), "bootstrap should expose the Windows PowerShell setup command");

assert(setupPs1.includes(setupUrl), "setup.ps1 should download the canonical setup script");
assert(setupPs1.includes("curl.exe"), "setup.ps1 should use curl.exe, not the PowerShell curl alias");
assert(setupPs1.includes("bash"), "setup.ps1 should delegate execution to bash");
assert(!setupPs1.includes("hy-harness"), "setup.ps1 should not call hy-harness");
assert(!setupPs1.includes(".github/workflows/hy-workflow.yml"), "setup.ps1 should not embed bootstrap artifact generation");

assert(setup.includes('"setup.ps1"'), "setup-generated workflow should include setup.ps1 in path filters");
assert(workflow.includes('"setup.ps1"'), "checked-in workflow should include setup.ps1 in path filters");

console.log("setup-entrypoints: cross-platform setup entrypoints are consistent");

assert(setup.includes("hy-workflow-mcp#main"), "setup prompt should include the preferred GitHub npx #main MCP command");
