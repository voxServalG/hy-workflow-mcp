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
  let shadowCode = "";
  try { await executeSetup(root, options, [createOpenCodeAdapter(root)]); } catch (error: any) { shadowCode = error?.code; }
  assert(shadowCode === "SETUP_EFFECTIVE_CONFIG_SHADOWED", "project OpenCode override must block setup");
  assert(fs.existsSync(projectConfig) && !fs.existsSync(path.join(root, "hy-workflow.json")), "blocked setup must not delete legacy config or create team artifacts");

  fs.rmSync(projectConfig);
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
  fs.writeFileSync(userCodexConfig, '[mcp_servers.hy-workflow]\ncommand = "hy-workflow"\nstartup_timeout_sec = 60\ntool_timeout_sec = 300\n');
  const projectCodexDir = path.join(root, ".codex");
  fs.mkdirSync(projectCodexDir, { recursive: true });
  const projectCodexConfig = path.join(projectCodexDir, "config.toml");
  const projectCodexBefore = '[mcp_servers.hy-workflow]\ncommand = "npx"\nargs = ["-y", "github:voxServalG/hy-workflow-mcp#main"]\nstartup_timeout_sec = 60\ntool_timeout_sec = 300\n';
  fs.writeFileSync(projectCodexConfig, projectCodexBefore);
  const userCodexBefore = fs.readFileSync(userCodexConfig, "utf-8");
  const codexOptions: SetupOptions = { ...options, clients: ["codex"] };
  let codexShadowCode = "";
  try { await executeSetup(root, codexOptions, [createCodexAdapter(root)]); } catch (error: any) { codexShadowCode = error?.code; }
  assert(codexShadowCode === "SETUP_EFFECTIVE_CONFIG_SHADOWED", "real legacy project Codex npx/GitHub definition must block setup");
  assert(fs.readFileSync(projectCodexConfig, "utf-8") === projectCodexBefore, "blocked Codex setup must not rewrite project .codex/config.toml");
  assert(fs.readFileSync(userCodexConfig, "utf-8") === userCodexBefore, "blocked Codex setup must not mutate the user Codex config");

  process.env.CODEX_HOME = projectCodexDir;
  let codexEnvCode = "";
  try { await executeSetup(root, codexOptions, [createCodexAdapter(root)]); } catch (error: any) { codexEnvCode = error?.code; }
  assert(codexEnvCode === "SETUP_EFFECTIVE_CONFIG_SHADOWED", "CODEX_HOME pointing at project .codex must never masquerade as user scope");
  assert(fs.readFileSync(projectCodexConfig, "utf-8") === projectCodexBefore, "project-scoped CODEX_HOME must not be rewritten");

  fs.writeFileSync(projectConfig, "{}\n");
  process.env.OPENCODE_CONFIG = projectConfig;
  let openCodeEnvCode = "";
  try { await executeSetup(root, options, [createOpenCodeAdapter(root)]); } catch (error: any) { openCodeEnvCode = error?.code; }
  assert(openCodeEnvCode === "SETUP_EFFECTIVE_CONFIG_SHADOWED", "OPENCODE_CONFIG pointing into .opencode must never masquerade as user scope");
  assert(fs.readFileSync(projectConfig, "utf-8") === "{}\n", "project-scoped OPENCODE_CONFIG must not be rewritten");

  const arbitraryCodexHome = path.join(root, ".client-state", "codex");
  fs.mkdirSync(arbitraryCodexHome, { recursive: true });
  process.env.CODEX_HOME = arbitraryCodexHome;
  let arbitraryCodexCode = "";
  try { await executeSetup(root, codexOptions, [createCodexAdapter(root)]); } catch (error: any) { arbitraryCodexCode = error?.code; }
  assert(arbitraryCodexCode === "SETUP_EFFECTIVE_CONFIG_SHADOWED", "any CODEX_HOME inside the repository must fail closed");
  assert(!fs.existsSync(path.join(arbitraryCodexHome, "config.toml")), "repository-local CODEX_HOME must not create a third project artifact");

  const arbitraryOpenCode = path.join(root, ".client-state", "opencode.json");
  process.env.OPENCODE_CONFIG = arbitraryOpenCode;
  let arbitraryOpenCodeCode = "";
  try { await executeSetup(root, options, [createOpenCodeAdapter(root)]); } catch (error: any) { arbitraryOpenCodeCode = error?.code; }
  assert(arbitraryOpenCodeCode === "SETUP_EFFECTIVE_CONFIG_SHADOWED", "any OPENCODE_CONFIG inside the repository must fail closed");
  assert(!fs.existsSync(arbitraryOpenCode), "repository-local OPENCODE_CONFIG must not create a third project artifact");
}

console.log("setup-effective-config: OpenCode and Codex project shadows fail closed");
