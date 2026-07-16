import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMMAND_NAMES } from "../../src/commands/catalog.js";
import { PACKAGE_VERSION } from "../../src/package-meta.js";
import { runSetupPreflight } from "../../src/setup/preflight.js";
import type { ClientAdapter, ClientServerSnapshot, McpDefinition, ServerName, SetupOptions } from "../../src/setup/types.js";
import { makeGitProject } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Client implements ClientAdapter {
  name = "codex" as const;
  installed = true;
  detect() { return { name: this.name, installed: this.installed, executable: this.installed ? "codex" : null, version: "test", configured: [] }; }
  inspect(_server: ServerName): ClientServerSnapshot { return { definition: null }; }
  install(_server: ServerName, _definition: McpDefinition): ClientServerSnapshot { return { definition: null }; }
  remove() {}
}

if (process.platform !== "win32") {
  const root = makeGitProject("hy-preflight-");
  const options: SetupOptions = { action: "setup", mode: "shared", clients: ["codex"], language: "en", yes: true, dryRun: true, json: true, removeGlobal: false };
  const client = new Client();
  const originalPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  let missingCode = "";
  try { await runSetupPreflight(root, options, [client], {}, true); } catch (error: any) { missingCode = error?.code; }
  assert(missingCode === "SETUP_BINARY_MISSING", "missing direct npm binary must fail preflight");

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-preflight-bin-"));
  for (const command of ["hy-workflow", "docs-gardener"]) {
    fs.writeFileSync(path.join(bin, command), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo test-version; exit 0; fi\nexit 0\n", { mode: 0o755 });
  }
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  let handshakeCode = "";
  try { await runSetupPreflight(root, options, [client], {}, true); } catch (error: any) { handshakeCode = error?.code; }
  assert(handshakeCode === "SETUP_HANDSHAKE_FAILED", "a binary that cannot speak MCP must fail handshake preflight");

  const fakeServer = path.resolve("test/helpers/fake-mcp-server.mjs");
  const catalogBin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-preflight-catalog-bin-"));
  for (const command of ["hy-workflow", "docs-gardener"]) {
    fs.writeFileSync(path.join(catalogBin, command), [
      "#!/bin/sh",
      `if [ \"$1\" = \"--version\" ]; then echo ${PACKAGE_VERSION}; exit 0; fi`,
      `FAKE_MCP_TOOLS='[\"wrong-tool\"]' exec '${process.execPath}' '${fakeServer}'`,
      "",
    ].join("\n"), { mode: 0o755 });
  }
  process.env.PATH = `${catalogBin}:/usr/bin:/bin`;
  let catalogCode = "";
  try { await runSetupPreflight(root, options, [client], {}, true); } catch (error: any) { catalogCode = error?.code; }
  assert(catalogCode === "SETUP_HANDSHAKE_FAILED", "an MCP server with an incompatible tool catalog must fail preflight");

  const versionBin = fs.mkdtempSync(path.join(os.tmpdir(), "hy-preflight-version-bin-"));
  const completeCatalog = JSON.stringify(COMMAND_NAMES);
  fs.writeFileSync(path.join(versionBin, "hy-workflow"), [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo 0.0.0-old; exit 0; fi',
    `FAKE_MCP_TOOLS='${completeCatalog}' exec '${process.execPath}' '${fakeServer}'`,
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(versionBin, "docs-gardener"), fs.readFileSync(path.join(catalogBin, "docs-gardener")), { mode: 0o755 });
  process.env.PATH = `${versionBin}:/usr/bin:/bin`;
  let versionCode = "";
  try { await runSetupPreflight(root, options, [client], {}, true); } catch (error: any) { versionCode = error?.code; }
  assert(versionCode === "SETUP_BINARY_VERSION_MISMATCH", "an old hy-workflow binary must not configure clients for a newer setup runtime");

  client.installed = false;
  let clientCode = "";
  try { await runSetupPreflight(root, options, [client], {}, false); } catch (error: any) { clientCode = error?.code; }
  assert(clientCode === "SETUP_CLIENT_NOT_INSTALLED", "missing selected client must fail before writes");
  process.env.PATH = originalPath;
}

console.log("setup-preflight: direct binary, handshake, and selected-client gates pass");
