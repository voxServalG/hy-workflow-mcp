import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeSetup } from "../../src/setup/operations.js";
import type { SetupOptions } from "../../src/setup/types.js";
import { gitStatus, makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const options: SetupOptions = { action: "setup", mode: "shared", clients: [], language: "en", yes: true, dryRun: true, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };

const insideRoot = makeGitProject("hy-runtime-inside-");
process.env.HY_WORKFLOW_CONFIG_HOME = path.join(insideRoot, ".local", "config");
process.env.HY_WORKFLOW_STATE_HOME = path.join(insideRoot, ".local", "state");
process.env.HY_WORKFLOW_CACHE_HOME = path.join(insideRoot, ".local", "cache");
const insideBefore = gitStatus(insideRoot);
let insideCode = "";
try { await executeSetup(insideRoot, options, [], { inspectDirectTools: false }); }
catch (error: any) { insideCode = error?.code; }
assert(insideCode === "SETUP_RUNTIME_ROOT_UNSAFE", "runtime roots inside the repository must fail before dry-run/setup writes");
assert(gitStatus(insideRoot) === insideBefore && !fs.existsSync(path.join(insideRoot, ".local")), "unsafe in-project runtime roots must remain completely unwritten");

if (process.platform !== "win32") {
  const linkedRoot = makeGitProject("hy-runtime-linked-");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "hy-runtime-link-parent-"));
  const link = path.join(outside, "project-link");
  fs.symlinkSync(linkedRoot, link, "dir");
  process.env.HY_WORKFLOW_CONFIG_HOME = path.join(link, ".external-config");
  process.env.HY_WORKFLOW_STATE_HOME = path.join(outside, "state");
  process.env.HY_WORKFLOW_CACHE_HOME = path.join(outside, "cache");
  const linkedBefore = gitStatus(linkedRoot);
  let linkedCode = "";
  try { await executeSetup(linkedRoot, options, [], { inspectDirectTools: false }); }
  catch (error: any) { linkedCode = error?.code; }
  assert(linkedCode === "SETUP_RUNTIME_ROOT_UNSAFE", "a runtime root symlink resolving into the repository must fail closed");
  assert(gitStatus(linkedRoot) === linkedBefore && !fs.existsSync(path.join(linkedRoot, ".external-config")), "symlinked unsafe roots must remain unwritten");
}

useRuntimeHome("hy-runtime-boundary-reset-");
console.log("setup-runtime-boundary: direct and symlinked in-project user roots fail before writes");
