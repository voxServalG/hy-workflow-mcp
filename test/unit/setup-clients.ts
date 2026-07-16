import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCodexAdapter } from "../../src/setup/clients/codex.js";
import { createOpenCodeAdapter } from "../../src/setup/clients/opencode.js";
import { createClaudeAdapter, parseClaudeGet, parseClaudeScope } from "../../src/setup/clients/claude.js";
import { definitionEquals, executableInvocation, normalizeDefinition } from "../../src/setup/clients/index.js";
import { MCP_DEFINITIONS } from "../../src/setup/types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

assert(definitionEquals(normalizeDefinition({ transport: { command: "x", args: ["a"], env: { B: "2", A: "1" } } }), { command: "x", args: ["a"], env: { A: "1", B: "2" } }), "definition normalization should ignore env key order");
assert(definitionEquals(parseClaudeGet("Command: hy-workflow\nArgs:\nEnvironment:\n  NONE"), MCP_DEFINITIONS["hy-workflow"]), "Claude empty Args must not consume the Environment label");
assert(definitionEquals(
  parseClaudeGet('hy-workflow:\n  Scope: User config (available in all your projects)\n  Status: ✓ Connected\n  Type: stdio\n  Command: hy-workflow\n  Args:\n  Environment:\n\nTo remove this server, run: claude mcp remove "hy-workflow" -s user'),
  MCP_DEFINITIONS["hy-workflow"],
), "Claude's unindented removal footer must terminate an empty Environment block");
assert(definitionEquals(
  parseClaudeGet("Command: legacy\nArgs: [\"serve\"]\nEnvironment:\n  API_TOKEN=secret-value\n  REGION: us-east-1"),
  { command: "legacy", args: ["serve"], env: { API_TOKEN: "secret-value", REGION: "us-east-1" } },
), "Claude environment must survive snapshot and restoration");
assert(parseClaudeGet("Command: legacy\nArgs:\nEnvironment:\n  API_TOKEN=********") === null, "redacted Claude environment must fail closed");
assert(parseClaudeScope("Scope: User config (available in all your projects)") === "user", "Claude's real user scope label must not be misclassified by the word projects");
assert(parseClaudeScope("Scope: Project config (private to this project)") === "project", "Claude project scope must remain fail-closed");
assert(parseClaudeScope("Command: hy-workflow\nArgs:") === "unknown", "Claude output without a recognized Scope label must never be assumed user-owned");

const windowsShim = executableInvocation("C:\\Users\\test\\AppData\\Roaming\\npm\\hy-workflow.cmd", ["--version"], "win32");
assert(windowsShim.command === (process.env.ComSpec ?? "cmd.exe"), "Windows .cmd shims must run through cmd.exe");
assert(windowsShim.args.join("|") === "/d|/s|/c|C:\\Users\\test\\AppData\\Roaming\\npm\\hy-workflow.cmd|--version", "Windows .cmd shims must preserve the executable and arguments");

if (process.platform !== "win32") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-opencode-client-"));
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-opencode-user-"));
  const bin = path.join(userRoot, "bin");
  fs.mkdirSync(bin);
  const executable = path.join(bin, "opencode");
  fs.writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo opencode-test; fi\n", { mode: 0o755 });
  const config = path.join(userRoot, "opencode.json");
  fs.writeFileSync(config, '{\n  // preserve this comment\n  "theme": "dark",\n  "mcp": { "other": { "type": "remote", "url": "https://example.test" } }\n}\n');
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.OPENCODE_CONFIG = config;
  const adapter = createOpenCodeAdapter(root);
  const previous = adapter.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
  assert(previous.definition === null, "new OpenCode MCP should have no previous definition");
  assert(definitionEquals(adapter.inspect("hy-workflow").definition, MCP_DEFINITIONS["hy-workflow"]), "OpenCode adapter should install the direct command");
  adapter.remove("hy-workflow", MCP_DEFINITIONS["hy-workflow"], previous);
  const restored = fs.readFileSync(config, "utf-8");
  assert(restored.includes("// preserve this comment") && restored.includes('"theme": "dark"') && restored.includes('"other"'), "OpenCode JSONC edits must preserve comments and unrelated fields");
  assert(!adapter.inspect("hy-workflow").definition, "OpenCode unset should remove only the owned entry");

  const commentedEntry = '{\n  "mcp": {\n    "hy-workflow": {\n      // preserve target comment\n      "type": "local",\n      "command": ["legacy", "serve"],\n      "enabled": true\n    },\n    "other": { "type": "remote", "url": "https://example.test" }\n  }\n}\n';
  fs.writeFileSync(config, commentedEntry, { mode: 0o640 });
  fs.chmodSync(config, 0o640);
  const commentedAdapter = createOpenCodeAdapter(root);
  const commentedPrevious = commentedAdapter.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
  const commentedCurrent = commentedAdapter.inspect("hy-workflow");
  commentedAdapter.remove("hy-workflow", MCP_DEFINITIONS["hy-workflow"], commentedPrevious, commentedCurrent);
  assert(fs.readFileSync(config, "utf-8").includes("// preserve target comment"), "OpenCode unset must restore comments inside the previous target entry");
  assert((fs.statSync(config).mode & 0o777) === 0o640, "OpenCode setup/unset must preserve config mode");

  fs.writeFileSync(config, JSON.stringify({ mcp: { "hy-workflow": { type: "local", command: ["hy-workflow"], enabled: false } } }, null, 2));
  const disabled = createOpenCodeAdapter(root);
  assert(disabled.inspect("hy-workflow").state === "disabled", "OpenCode enabled=false must be reported as disabled, never kept");
  let disabledCode = "";
  try { disabled.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]); } catch (error: any) { disabledCode = error?.code; }
  assert(disabledCode === "SETUP_CLIENT_CONFIG_UNSAFE", `disabled OpenCode entries require explicit migration, got ${disabledCode || "no error"}`);

  fs.writeFileSync(config, "{}\n");
  fs.mkdirSync(path.join(root, ".opencode"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opencode", "opencode.json"), JSON.stringify({ mcp: { "hy-workflow": { type: "local", command: ["npx", "github:legacy/hy-workflow"], enabled: true } } }, null, 2));
  const shadowed = createOpenCodeAdapter(root);
  assert(shadowed.inspect("hy-workflow").state === "shadowed" && shadowed.inspect("hy-workflow").scope === "project", "project OpenCode config must be the effective source");
  let shadowCode = "";
  try { shadowed.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]); } catch (error: any) { shadowCode = error?.code; }
  assert(shadowCode === "SETUP_EFFECTIVE_CONFIG_SHADOWED", "setup must fail closed instead of deleting project-owned OpenCode config");

  const codexRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-codex-client-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-codex-user-"));
  const codexProjectDir = path.join(codexRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(codexProjectDir, { recursive: true });
  const codexExecutable = path.join(bin, "codex");
  fs.writeFileSync(codexExecutable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo codex-test; exit 0; fi\nexit 1\n", { mode: 0o755 });
  process.env.CODEX_HOME = codexHome;
  const userCodexConfig = path.join(codexHome, "config.toml");
  fs.writeFileSync(userCodexConfig, '[mcp_servers."hy-workflow"]\ncommand = "hy-workflow"\nargs = []\nenabled = true\nstartup_timeout_sec = 60\ntool_timeout_sec = 300\n');
  const projectCodexConfig = path.join(codexProjectDir, "config.toml");
  const legacyCodex = '[mcp_servers.hy-workflow]\ncommand = "npx"\nargs = ["-y", "github:voxServalG/hy-workflow-mcp#main"]\nenabled = true\nstartup_timeout_sec = 15\ntool_timeout_sec = 45\n';
  fs.writeFileSync(projectCodexConfig, legacyCodex);
  const codex = createCodexAdapter(codexRoot);
  const codexSnapshot = codex.inspect("hy-workflow");
  assert(codexSnapshot.state === "shadowed" && codexSnapshot.scope === "project", "project Codex config must be reported as the effective shadow source");
  assert(codexSnapshot.source === projectCodexConfig, "Codex shadow must name the actual project config file");
  assert(codexSnapshot.definition?.command === "npx" && codexSnapshot.definition.args[1] === "github:voxServalG/hy-workflow-mcp#main", "Codex shadow must expose the legacy command and args");
  assert(codexSnapshot.enabled === true && (codexSnapshot.raw as any)?.present === true, "Codex shadow must expose presence and enabled state");
  assert((codexSnapshot.raw as any)?.startup_timeout_sec === 15 && (codexSnapshot.raw as any)?.tool_timeout_sec === 45, "Codex shadow must expose both timeout values");
  assert(codexSnapshot.sources?.some(source => source.scope === "user" && source.source === userCodexConfig) === true, "Codex inspect must retain the owned user source beside the project shadow");
  let codexShadowCode = "";
  try { codex.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]); } catch (error: any) { codexShadowCode = error?.code; }
  assert(codexShadowCode === "SETUP_EFFECTIVE_CONFIG_SHADOWED", "Codex install must fail closed on project shadow");
  assert(fs.readFileSync(projectCodexConfig, "utf-8") === legacyCodex, "Codex install must never rewrite project config");

  fs.writeFileSync(projectCodexConfig, '[mcp_servers.hy-workflow]\ncommand = "npx"\nenabled = "maybe"\n');
  const unreadableCodex = createCodexAdapter(codexRoot).inspect("hy-workflow");
  assert(unreadableCodex.scope === "project" && unreadableCodex.state === "unreadable", "unsafe project Codex values must fail closed as unreadable");

  fs.rmSync(projectCodexConfig);
  const crlfCodex = '[mcp_servers."hy-workflow"]\r\ncommand = "hy-workflow"\r\nargs = []\r\nenabled = true\r\nstartup_timeout_sec = 7.0 # keep timeout note\r\ntool_timeout_sec = 9.00\r\n\r\n[unrelated]\r\nvalue = "untouched"';
  fs.writeFileSync(userCodexConfig, crlfCodex);
  const crlfAdapter = createCodexAdapter(codexRoot);
  crlfAdapter.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
  const crlfUpdated = fs.readFileSync(userCodexConfig, "utf-8");
  assert(crlfUpdated === crlfCodex.replace("startup_timeout_sec = 7.0", "startup_timeout_sec = 60").replace("tool_timeout_sec = 9.00", "tool_timeout_sec = 300"), "Codex timeout updates must accept CLI-normalized whole-number floats while preserving CRLF, comments, unrelated bytes, and missing final newline");
  const integerTimeoutSnapshot = crlfAdapter.inspect("hy-workflow");
  fs.writeFileSync(userCodexConfig, crlfUpdated.replace("startup_timeout_sec = 60", "startup_timeout_sec = 60.0").replace("tool_timeout_sec = 300", "tool_timeout_sec = 300.0"));
  const floatTimeoutSnapshot = crlfAdapter.inspect("hy-workflow");
  assert(
    (integerTimeoutSnapshot.raw as any)?.sectionFingerprint === (floatTimeoutSnapshot.raw as any)?.sectionFingerprint,
    "Codex ownership fingerprints must ignore only CLI whole-number timeout normalization across sibling writes",
  );

  fs.writeFileSync(codexExecutable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-test"); process.exit(0); }
const file = path.join(process.env.CODEX_HOME, "config.toml");
const remove = server => {
  const input = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = input.match(/.*(?:\\r?\\n|$)/g).filter(Boolean);
  let dropping = false;
  const output = [];
  for (const line of lines) {
    const match = /^\\s*\\[([^\\]]+)\\]/.exec(line);
    if (match) {
      const header = match[1].replace(/[\\s"']/g, "");
      dropping = header === \`mcp_servers.\${server}\` || header === \`mcp_servers.\${server}.env\`;
    }
    if (!dropping) output.push(line);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, output.join(""));
};
if (args[0] !== "mcp") process.exit(1);
if (args[1] === "get") { console.error("MCP server not found"); process.exit(1); }
if (args[1] === "remove") { remove(args[2]); process.exit(0); }
if (args[1] === "add") {
  let index = 2;
  const env = {};
  while (args[index] === "--env") { const [key, ...value] = args[index + 1].split("="); env[key] = value.join("="); index += 2; }
  const server = args[index++];
  if (args[index++] !== "--") process.exit(2);
  remove(server);
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text && !text.endsWith("\\n")) text += "\\n";
  text += \`[mcp_servers."\${server}"]\\ncommand = \${JSON.stringify(args[index++])}\\nargs = \${JSON.stringify(args.slice(index))}\\nenabled = true\\n\`;
  if (Object.keys(env).length) text += \`env = \${JSON.stringify(env)}\\n\`;
  fs.writeFileSync(file, text);
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  fs.rmSync(userCodexConfig, { force: true });
  const absentCodexAdapter = createCodexAdapter(codexRoot);
  const absentHyBaseline = absentCodexAdapter.inspect("hy-workflow");
  const absentDocsBaseline = absentCodexAdapter.inspect("docs-gardener");
  assert((absentHyBaseline.raw as any)?.configFileExisted === false && (absentDocsBaseline.raw as any)?.configFileExisted === false, "Codex ownership baselines must be captured before any shared config mutation");
  absentCodexAdapter.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"], absentHyBaseline);
  const docsTransactionPrevious = absentCodexAdapter.install("docs-gardener", MCP_DEFINITIONS["docs-gardener"], absentDocsBaseline);
  assert((docsTransactionPrevious.raw as any)?.configFileExisted === true, "Codex transaction rollback must retain the actual sibling-created file state");
  const absentHyCurrent = absentCodexAdapter.inspect("hy-workflow");
  absentCodexAdapter.remove("hy-workflow", MCP_DEFINITIONS["hy-workflow"], absentHyBaseline, absentHyCurrent);
  assert(fs.existsSync(userCodexConfig) && Boolean(absentCodexAdapter.inspect("docs-gardener").definition), "Codex unset must keep a shared config file while a sibling managed MCP remains");
  const absentDocsCurrent = absentCodexAdapter.inspect("docs-gardener");
  absentCodexAdapter.remove("docs-gardener", MCP_DEFINITIONS["docs-gardener"], absentDocsBaseline, absentDocsCurrent);
  assert(!fs.existsSync(userCodexConfig), "Codex unset must remove a shared config file that did not exist before setup after its last managed MCP is removed");

  const roundTripOriginal = '# retain target comment\n[mcp_servers."hy-workflow"]\n# retain inner comment\ncommand = "legacy-command"\nargs = ["serve"]\nenabled = true\nstartup_timeout_sec = 7\ntool_timeout_sec = 9\n\n[unrelated]\nvalue = "before"\n';
  fs.writeFileSync(userCodexConfig, roundTripOriginal, { mode: 0o640 });
  fs.chmodSync(userCodexConfig, 0o640);
  const roundTripAdapter = createCodexAdapter(codexRoot);
  const previousCodex = roundTripAdapter.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]);
  const installedCodex = roundTripAdapter.inspect("hy-workflow");
  assert(definitionEquals(installedCodex.definition, MCP_DEFINITIONS["hy-workflow"]), "Codex setup must install the desired direct command");
  assert((installedCodex.raw as any)?.startup_timeout_sec === 60 && (installedCodex.raw as any)?.tool_timeout_sec === 300, "Codex setup must install required timeouts");
  fs.appendFileSync(userCodexConfig, '\n[concurrent_unrelated]\nkept = true\n');
  const beforeUnsetCodex = roundTripAdapter.inspect("hy-workflow");
  assert((installedCodex.raw as any)?.sectionFingerprint === (beforeUnsetCodex.raw as any)?.sectionFingerprint, "Codex ownership fingerprint must ignore only the separator newline added before an unrelated table");
  roundTripAdapter.remove("hy-workflow", MCP_DEFINITIONS["hy-workflow"], previousCodex, beforeUnsetCodex);
  const restoredCodex = fs.readFileSync(userCodexConfig, "utf-8");
  assert(restoredCodex.includes("# retain inner comment") && restoredCodex.includes('command = "legacy-command"'), "Codex unset must restore the exact previous target section");
  assert(restoredCodex.includes("[concurrent_unrelated]\nkept = true"), "Codex unset must preserve unrelated edits made after setup");
  assert((fs.statSync(userCodexConfig).mode & 0o777) === 0o640, "Codex setup/unset must preserve the original config mode");

  fs.writeFileSync(userCodexConfig, '[mcp_servers.hy-workflow]\ncommand = "legacy"\ncwd = "/tmp"\n');
  assert(createCodexAdapter(codexRoot).inspect("hy-workflow").state === "unreadable", "unsupported Codex target keys must fail closed instead of being lost");
  const symlinkHome = fs.mkdtempSync(path.join(os.tmpdir(), "hy-codex-symlink-"));
  const symlinkTarget = path.join(symlinkHome, "target.toml");
  fs.writeFileSync(symlinkTarget, '[mcp_servers.hy-workflow]\ncommand = "legacy"\n');
  fs.symlinkSync(symlinkTarget, path.join(symlinkHome, "config.toml"));
  process.env.CODEX_HOME = symlinkHome;
  const symlinkCodex = createCodexAdapter(codexRoot);
  assert(symlinkCodex.inspect("hy-workflow").state === "unreadable", "Codex user config symlinks must fail closed");

  const openCodeSymlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hy-opencode-symlink-"));
  const openCodeSymlinkTarget = path.join(openCodeSymlinkRoot, "target.json");
  const openCodeSymlinkConfig = path.join(openCodeSymlinkRoot, "opencode.json");
  fs.writeFileSync(openCodeSymlinkTarget, '{}\n');
  fs.symlinkSync(openCodeSymlinkTarget, openCodeSymlinkConfig);
  process.env.OPENCODE_CONFIG = openCodeSymlinkConfig;
  const symlinkOpenCode = createOpenCodeAdapter(root);
  assert(symlinkOpenCode.inspect("hy-workflow").state === "unreadable", "OpenCode user config symlinks must fail closed");
  let symlinkOpenCodeFailure = "";
  try { symlinkOpenCode.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]); } catch (error: any) { symlinkOpenCodeFailure = error?.code; }
  assert(symlinkOpenCodeFailure === "SETUP_CLIENT_CONFIG_UNSAFE", "OpenCode setup must not replace a user config symlink");
  assert(fs.lstatSync(openCodeSymlinkConfig).isSymbolicLink(), "OpenCode config symlink must remain intact after rejected setup");

  const claudeExecutable = path.join(bin, "claude");
  fs.writeFileSync(claudeExecutable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo claude-test; exit 0; fi\necho "not found" >&2\nexit 1\n', { mode: 0o755 });
  const originalHome = process.env.HOME;
  process.env.HOME = root;
  const unsafeClaude = createClaudeAdapter(root);
  assert(unsafeClaude.inspect("hy-workflow").state === "unreadable", "Claude HOME inside the project must fail closed");
  let unsafeClaudeCode = "";
  try { unsafeClaude.install("hy-workflow", MCP_DEFINITIONS["hy-workflow"]); } catch (error: any) { unsafeClaudeCode = error?.code; }
  assert(unsafeClaudeCode === "SETUP_CLIENT_CONFIG_UNSAFE", "Claude setup must not write through a project-local HOME");
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}
