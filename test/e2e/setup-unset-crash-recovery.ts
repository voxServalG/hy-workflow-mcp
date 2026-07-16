import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { readRegistry } from "../../src/runtime/deployment.js";
import { projectPaths, projectStoragePaths, userRoots } from "../../src/runtime/user-paths.js";
import { executeSetup } from "../../src/setup/operations.js";
import { withSetupTransaction } from "../../src/setup/transaction.js";
import type { SetupOptions } from "../../src/setup/types.js";
import { makeGitProject, useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const setupOptions: SetupOptions = {
  action: "setup",
  mode: "shared",
  clients: [],
  language: "en",
  yes: true,
  dryRun: false,
  json: true,
  removeGlobal: false,
  acceptCiCommands: true,
  ciCommands: ["npm ci", "npm run build", "npm run test"],
};

function tombstones(projectId: string): string[] {
  const roots = userRoots();
  return [roots.config, roots.state, roots.cache].flatMap(root => {
    const parent = path.join(root, "projects");
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent).filter(name => name.startsWith(`${projectId}.removing-`)).map(name => path.join(parent, name));
  });
}

if (process.platform !== "win32") {
  for (const phase of ["stage", "registry", "cleanup"] as const) {
    useRuntimeHome(`hy-unset-kill-${phase}-runtime-`);
    const root = makeGitProject(`hy-unset-kill-${phase}-`);
    await executeSetup(root, setupOptions, [], { inspectDirectTools: false });
    const paths = projectPaths(root);
    const storage = projectStoragePaths(paths.identity.id);
    assert(fs.existsSync(storage.deployment) && readRegistry(root).projects[paths.identity.id], `${phase}: fixture setup must be deployed`);

    const child = spawnSync(process.execPath, ["--import", "tsx", path.resolve("test/helpers/setup-crash-child.ts"), root, phase], {
      cwd: path.resolve("."),
      env: process.env,
      encoding: "utf-8",
      timeout: 20_000,
    });
    assert(child.signal === "SIGKILL", `${phase}: crash child must stop at the requested durable phase; status=${child.status} stderr=${child.stderr}`);
    assert(fs.existsSync(paths.setupJournal), `${phase}: SIGKILL must leave a durable setup journal`);

    await withSetupTransaction(root, "unset", () => undefined);
    assert(!fs.existsSync(paths.setupJournal) && !fs.existsSync(paths.setupLock), `${phase}: next invocation must consume journal and dead-process lock`);
    assert(tombstones(paths.identity.id).length === 0, `${phase}: recovery must leave no staged directory tombstones`);
    if (phase === "cleanup") {
      assert(!readRegistry(root).projects[paths.identity.id], "cleanup: committed registry removal must remain committed");
      assert(!fs.existsSync(storage.configDir) && !fs.existsSync(storage.stateDir) && !fs.existsSync(storage.cacheDir), "cleanup: committed project storage removal must finish");
    } else {
      assert(Boolean(readRegistry(root).projects[paths.identity.id]), `${phase}: uncommitted registry removal must roll back`);
      assert(fs.existsSync(storage.deployment), `${phase}: uncommitted external deployment must roll back`);
    }
  }
}

console.log("setup-unset-crash-recovery: SIGKILL stage/registry/cleanup recovery pass");
