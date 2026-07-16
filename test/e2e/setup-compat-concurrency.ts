import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readRegistry } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { recoverRuntimeCompatConfigs, withRuntimeCompatConfigs } from "../../src/config.js";
import { executeSetup } from "../../src/setup/operations.js";
import type { SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";
import { setSetupTestHooks } from "../helpers/setup-hooks.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.platform !== "win32") {
  useRuntimeHome("hy-compat-unset-runtime-");
  const root = makeGitProject("hy-compat-unset-");
  const options: SetupOptions = { action: "setup", mode: "shared", clients: [], language: "en", yes: true, dryRun: false, json: true, removeGlobal: false, acceptCiCommands: true, ciCommands: ["npm ci", "npm run build", "npm run test"] };
  await executeSetup(root, options, [], { inspectDirectTools: false });
  const coordination = fs.mkdtempSync(path.join(os.tmpdir(), "hy-compat-unset-signals-"));
  const ready = path.join(coordination, "ready");
  const release = path.join(coordination, "release");
  const child = spawn(process.execPath, ["--import", "tsx", path.resolve("test/helpers/setup-compat-child.ts"), root, ready, release], {
    cwd: path.resolve("."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(ready) && Date.now() < deadline && child.exitCode === null) Atomics.wait(waitArray, 0, 0, 20);
  assert(fs.existsSync(ready), "compatibility fixture must hold its durable lock");
  for (const file of ["codelint.json", "doclint.json", "docs-gardener.json"]) assert(fs.existsSync(path.join(root, file)), `compatibility fixture must materialize ${file}`);

  let blockedCode = "";
  try { await executeSetup(root, { ...options, action: "unset" }, [], { inspectDirectTools: false }); }
  catch (error: any) { blockedCode = error?.code; }
  const paths = projectPaths(root);
  assert(blockedCode === "SETUP_CONCURRENT_OPERATION", "unset must fail closed while runtime compatibility artifacts are active");
  assert(fs.existsSync(paths.deployment) && Boolean(readRegistry(root).projects[paths.identity.id]), "blocked unset must preserve deployment and registry evidence");
  assert(!fs.existsSync(paths.setupJournal), "blocked unset must not begin its own transaction");

  fs.writeFileSync(release, "release\n");
  const childExit = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
  assert(childExit === 0, "compatibility operation must restore cleanly after release");
  for (const file of ["codelint.json", "doclint.json", "docs-gardener.json"]) assert(!fs.existsSync(path.join(root, file)), `${file} must be restored to its exact absent state`);
  const removed = await executeSetup(root, { ...options, action: "unset" }, [], { inspectDirectTools: false });
  assert(removed.ok && removed.removed && !readRegistry(root).projects[paths.identity.id], "unset must complete after compatibility coordination is released");

  useRuntimeHome("hy-compat-cas-runtime-");
  const casRoot = makeGitProject("hy-compat-cas-");
  await executeSetup(casRoot, options, [], { inspectDirectTools: false });
  const conflictFile = path.join(casRoot, "doclint.json");
  const restoreCasHook = setSetupTestHooks({ beforeCompatWrite: file => {
    if (file === conflictFile) fs.writeFileSync(file, '{"external":true}\n');
  } });
  let casFailed = false;
  try { withRuntimeCompatConfigs(casRoot, () => undefined); }
  catch { casFailed = true; }
  finally { restoreCasHook(); }
  assert(casFailed && fs.readFileSync(conflictFile, "utf-8") === '{"external":true}\n', "compat pre-write CAS must preserve the concurrent edit");
  assert(!fs.existsSync(path.join(casRoot, "codelint.json")) && !fs.existsSync(path.join(casRoot, "docs-gardener.json")), "compat CAS recovery must restore only artifacts it safely wrote");
  assert(fs.existsSync(path.join(projectPaths(casRoot).stateDir, "compat-journal.json")), "compat CAS conflict must retain durable manual recovery evidence");
  fs.rmSync(conflictFile);
  assert(recoverRuntimeCompatConfigs(casRoot).recovered, "compat recovery must complete after the external conflict is explicitly reconciled");
}

console.log("setup-compat-concurrency: unset exclusion and per-file compatibility CAS pass");
