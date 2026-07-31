import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCodexAdapter } from "../../src/setup/clients/codex.js";
import { createOpenCodeAdapter } from "../../src/setup/clients/opencode.js";
import { executeSetup } from "../../src/setup/operations.js";
import type { SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.platform !== "win32") {
  useRuntimeHome("hy-effective-runtime-");
  const root = makeGitProject("hy-effective-");
  const toolHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-effective-bin-"));
  const executable = path.join(toolHome, "opencode");
  fs.writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo opencode-test; fi\n", { mode: 0o755 });
  process.env.PATH = `${toolHome}:${process.env.PATH ?? ""}`;
  const userConfig = path.join(toolHome, "opencode.json");
  process.env.OPENCODE_CONFIG = userConfig;
  fs.writeFileSync(userConfig, "{}\n");
  fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
  const projectConfig = path.join(root, ".opencode", "opencode.json");
  fs.writeFileSync(projectConfig, JSON.stringify({ mcp: { "hy-workflow": { type: "local", command: ["npx", "github:legacy/hy-workflow"], enabled: true } } }, null, 2));
  const options: SetupOptions = { action: "setup", mode: "shared", clients: ["opencode"], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };
  const projectOpenCodeBefore = fs.readFileSync(projectConfig, "utf-8");
  fs.chmodSync(projectConfig, 0o000);
  const openCodeSetup = await executeSetup(root, options, [createOpenCodeAdapter(root)]);
  fs.chmodSync(projectConfig, 0o644);
  assert(openCodeSetup.ok && fs.existsSync(path.join(root, "hy-workflow.json")), "project OpenCode injection must not block the canonical user-scope setup");
  assert(fs.readFileSync(projectConfig, "utf-8") === projectOpenCodeBefore, "setup must leave ignored project OpenCode config byte-for-byte unchanged");
  assert(JSON.parse(fs.readFileSync(userConfig, "utf-8")).mcp["hy-workflow"].command.join(" ") === "hy-workflow", "setup must install the direct command only in user config");

  fs.writeFileSync(userConfig, JSON.stringify({ mcp: { "hy-workflow": { type: "local", command: ["hy-workflow"], enabled: false } } }, null, 2));
  let disabledCode = "";
  try { await executeSetup(root, options, [createOpenCodeAdapter(root)]); } catch (error: any) { disabledCode = error?.code; }
  assert(disabledCode === "SETUP_CLIENT_CONFIG_UNSAFE", "disabled effective OpenCode entry must block setup");

  const codexExecutable = path.join(toolHome, "codex");
  fs.writeFileSync(codexExecutable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo codex-test; exit 0; fi\nexit 1\n", { mode: 0o755 });
  const codexHome = path.join(toolHome, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  const userCodexConfig = path.join(codexHome, "config.toml");
  fs.writeFileSync(userCodexConfig, [
    "[mcp_servers.hy-workflow]", 'command = "hy-workflow"', "startup_timeout_sec = 60", "tool_timeout_sec = 300", "",
    "[mcp_servers.docs-gardener]", 'command = "docs-gardener"', 'args = ["mcp"]', "startup_timeout_sec = 60", "tool_timeout_sec = 300", "",
  ].join("\n"));
  const projectCodexDir = path.join(root, ".codex");
  fs.mkdirSync(projectCodexDir, { recursive: true });
  const projectCodexConfig = path.join(projectCodexDir, "config.toml");
  const projectCodexBefore = '[mcp_servers.hy-workflow]\ncommand = "npx"\nargs = ["-y", "github:voxServalG/hy-workflow-mcp#main"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 300\n';
  fs.writeFileSync(projectCodexConfig, projectCodexBefore);
  const userCodexBefore = fs.readFileSync(userCodexConfig, "utf-8");
  const codexOptions: SetupOptions = { ...options, clients: ["codex"] };
  fs.chmodSync(projectCodexConfig, 0o000);
  const codexSetup = await executeSetup(root, codexOptions, [createCodexAdapter(root)]);
  fs.chmodSync(projectCodexConfig, 0o644);
  assert(codexSetup.ok, "legacy project Codex definition must not block user-scope setup");
  assert(fs.readFileSync(projectCodexConfig, "utf-8") === projectCodexBefore, "Codex setup must not read or rewrite project .codex/config.toml");
  assert(fs.readFileSync(userCodexConfig, "utf-8") === userCodexBefore, "already-current user Codex config must remain byte-for-byte stable");

  process.env.CODEX_HOME = projectCodexDir;
  fs.chmodSync(projectCodexConfig, 0o000);
  let codexEnvCode = "";
  try { await executeSetup(root, codexOptions, [createCodexAdapter(root)]); } catch (error: any) { codexEnvCode = error?.code; }
  fs.chmodSync(projectCodexConfig, 0o644);
  assert(codexEnvCode === "SETUP_CLIENT_CONFIG_UNSAFE", "CODEX_HOME pointing at project .codex must be rejected by path without reading it");
  assert(fs.readFileSync(projectCodexConfig, "utf-8") === projectCodexBefore, "project-scoped CODEX_HOME must not be rewritten");

  fs.writeFileSync(projectConfig, "{}\n");
  process.env.OPENCODE_CONFIG = projectConfig;
  let openCodeEnvCode = "";
  try { await executeSetup(root, options, [createOpenCodeAdapter(root)]); } catch (error: any) { openCodeEnvCode = error?.code; }
  assert(openCodeEnvCode === "SETUP_CLIENT_CONFIG_UNSAFE", "OPENCODE_CONFIG pointing into .opencode must be rejected by path without reading it");
  assert(fs.readFileSync(projectConfig, "utf-8") === "{}\n", "project-scoped OPENCODE_CONFIG must not be rewritten");

  const arbitraryCodexHome = path.join(root, ".client-state", "codex");
  fs.mkdirSync(arbitraryCodexHome, { recursive: true });
  process.env.CODEX_HOME = arbitraryCodexHome;
  let arbitraryCodexCode = "";
  try { await executeSetup(root, codexOptions, [createCodexAdapter(root)]); } catch (error: any) { arbitraryCodexCode = error?.code; }
  assert(arbitraryCodexCode === "SETUP_CLIENT_CONFIG_UNSAFE", "any CODEX_HOME inside the repository must fail closed without reading it");
  assert(!fs.existsSync(path.join(arbitraryCodexHome, "config.toml")), "repository-local CODEX_HOME must not create a third project artifact");

  const arbitraryOpenCode = path.join(root, ".client-state", "opencode.json");
  process.env.OPENCODE_CONFIG = arbitraryOpenCode;
  let arbitraryOpenCodeCode = "";
  try { await executeSetup(root, options, [createOpenCodeAdapter(root)]); } catch (error: any) { arbitraryOpenCodeCode = error?.code; }
  assert(arbitraryOpenCodeCode === "SETUP_CLIENT_CONFIG_UNSAFE", "any OPENCODE_CONFIG inside the repository must fail closed without reading it");
  assert(!fs.existsSync(arbitraryOpenCode), "repository-local OPENCODE_CONFIG must not create a third project artifact");
}

console.log("setup-effective-config: project injections are ignored and only explicit user paths are managed");
