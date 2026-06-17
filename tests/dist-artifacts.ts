import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function readDist(relativePath: string): string {
  return readFileSync(join(cwd(), "dist", relativePath), "utf-8");
}

const init = readDist("tools/init.js");
const server = readDist("server.js");
const readDocs = readDist("tools/read_docs.js");

assert(!init.includes("npx --yes github:voxServalG/hy-harness"), "dist init must not execute hy-harness");
assert(!init.includes("stdio: \"inherit\""), "dist init must not inherit stdio");
assert(!init.includes("Harness deployed"), "dist init must not report harness deployment");
assert(init.includes("harnessArtifactStatus"), "dist init should verify harness artifacts");
assert(init.includes("harness_missing"), "dist init should expose structured missing-harness recovery");

assert(!server.includes("初始化项目：部署 hy-harness"), "dist server description must not claim hy_init deploys hy-harness");
assert(server.includes("不会在 MCP 内启动交互式 harness"), "dist server description should describe non-interactive init");

assert(server.includes("hy_read_docs"), "dist server should register hy_read_docs");
assert(readDocs.includes("before_plan"), "dist read_docs should implement before_plan stage");
assert(readDocs.includes("before_approve"), "dist read_docs should implement before_approve stage");
