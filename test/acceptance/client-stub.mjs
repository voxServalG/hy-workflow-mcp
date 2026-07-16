#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const client = basename(process.argv[1]).replace(/\.(?:cmd|exe)$/i, "");
const args = process.argv.slice(2);
const stateFile = process.env.HY_ACCEPTANCE_CLIENT_STATE;
const eventFile = process.env.HY_ACCEPTANCE_CLIENT_EVENTS;
if (!stateFile) throw new Error("HY_ACCEPTANCE_CLIENT_STATE is required");

const readState = () => {
  if (!existsSync(stateFile)) return {};
  return JSON.parse(readFileSync(stateFile, "utf8"));
};
const writeState = value => {
  const hasDefinitions = Object.values(value).some(definitions =>
    definitions && typeof definitions === "object" && Object.keys(definitions).length > 0,
  );
  if (!hasDefinitions) {
    rmSync(stateFile, { force: true });
    return;
  }
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = stateFile + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, stateFile);
};
const event = (action, server) => {
  if (eventFile) {
    mkdirSync(dirname(eventFile), { recursive: true });
    appendFileSync(eventFile, JSON.stringify({ client, action, server, args, at: Date.now() }) + "\n");
  }
  const fault = process.env.HY_ACCEPTANCE_CLIENT_FAIL;
  if (fault && [client, action, server].filter(Boolean).join(":") === fault) {
    process.stderr.write("acceptance injected client failure: " + fault + "\n");
    process.exit(73);
  }
};
const definitionFrom = commandArgs => {
  const separator = commandArgs.indexOf("--");
  if (separator < 0 || !commandArgs[separator + 1]) throw new Error("missing MCP command after --");
  const env = {};
  for (let index = 0; index < separator; index += 1) {
    if ((commandArgs[index] === "--env" || commandArgs[index] === "-e") && commandArgs[index + 1]) {
      const pair = commandArgs[++index];
      const split = pair.indexOf("=");
      if (split > 0) env[pair.slice(0, split)] = pair.slice(split + 1);
    }
  }
  return {
    command: commandArgs[separator + 1],
    args: commandArgs.slice(separator + 2),
    ...(Object.keys(env).length ? { env } : {}),
  };
};

if (args.includes("--version") || args[0] === "version") {
  process.stdout.write(client + " acceptance-stub 1.0.0\n");
  process.exit(0);
}
if (client === "gh") {
  const remoteWrite = ["pr", "release", "repo"].includes(args[0]);
  event(remoteWrite ? "remote-write-attempt" : "unavailable", args[0]);
  process.stderr.write("gh is unavailable inside hy-workflow acceptance\n");
  process.exit(77);
}

const state = readState();
state[client] ??= {};
const writeCodexConfig = definitions => {
  const home = process.env.CODEX_HOME;
  if (!home) throw new Error("CODEX_HOME is required");
  mkdirSync(home, { recursive: true });
  const text = Object.entries(definitions).map(([name, definition]) => [
    `[mcp_servers.${JSON.stringify(name)}]`,
    `command = ${JSON.stringify(definition.command)}`,
    `args = ${JSON.stringify(definition.args)}`,
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 300",
    "",
  ].join("\n")).join("\n");
  writeFileSync(join(home, "config.toml"), text, { mode: 0o600 });
};
if (client === "opencode" && args[0] === "debug" && args[1] === "config") {
  event("debug-config");
  const userFile = process.env.OPENCODE_CONFIG;
  const projectFile = join(process.cwd(), ".opencode", "opencode.json");
  const parse = file => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const user = parse(userFile);
  const project = parse(projectFile);
  process.stdout.write(JSON.stringify({ ...user, ...project, mcp: { ...(user.mcp || {}), ...(project.mcp || {}) } }) + "\n");
  process.exit(0);
}
if (client === "opencode") {
  event("noop");
  process.exit(0);
}

if (args[0] !== "mcp") {
  event("unsupported");
  process.stderr.write("unsupported acceptance stub command\n");
  process.exit(64);
}
const action = args[1];
const server = action === "list" ? undefined : args.find((value, index) => index >= 2 && !value.startsWith("-") && args[index - 1] !== "--env" && args[index - 1] !== "-e" && value !== "user");
event(action, server);

if (action === "list") {
  process.stdout.write(JSON.stringify(state[client]) + "\n");
  process.exit(0);
}
if (action === "get") {
  const definition = state[client][server];
  if (!definition) {
    process.stderr.write("MCP server not found: " + server + "\n");
    process.exit(1);
  }
  if (client === "codex") {
    process.stdout.write(JSON.stringify({
      transport: definition,
      enabled: true,
      startup_timeout_sec: 60,
      tool_timeout_sec: 300,
    }) + "\n");
  } else {
    process.stdout.write(server + ":\n");
    process.stdout.write("  Scope: User config (available in all your projects)\n");
    process.stdout.write("  Status: connected\n");
    process.stdout.write("  Type: stdio\n");
    process.stdout.write("  Command: " + definition.command + "\n");
    process.stdout.write("  Args: " + (definition.args.length ? JSON.stringify(definition.args) : "") + "\n");
    process.stdout.write("  Environment:\n");
  }
  process.exit(0);
}
if (action === "add") {
  const separator = args.indexOf("--");
  const candidateNames = args.slice(2, separator < 0 ? args.length : separator)
    .filter((value, index, values) => !value.startsWith("-") && values[index - 1] !== "--env" && values[index - 1] !== "-e" && value !== "user");
  const addServer = candidateNames.at(-1);
  if (!addServer) throw new Error("missing server name");
  state[client][addServer] = definitionFrom(args.slice(2));
  writeState(state);
  if (client === "codex") writeCodexConfig(state[client]);
  process.exit(0);
}
if (action === "remove") {
  const removeServer = args.at(-1);
  delete state[client][removeServer];
  writeState(state);
  if (client === "codex") writeCodexConfig(state[client]);
  process.exit(0);
}

process.stderr.write("unsupported MCP action: " + action + "\n");
process.exit(64);
