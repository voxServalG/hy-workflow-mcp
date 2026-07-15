import * as path from "node:path";
import { makeGitProject } from "../helpers/runtime-home.js";
import { projectPaths, resolveProjectIdentity, userRoots } from "../../src/runtime/user-paths.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const linux = userRoots({ platform: "linux", home: "/home/demo", env: {} });
assert(linux.config === path.join("/home/demo", ".config", "hy-workflow"), "Linux config should follow XDG defaults");
const windows = userRoots({ platform: "win32", home: "C:\\Users\\demo", env: { APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local" } });
assert(windows.config.includes("Roaming") && windows.state.includes("Local"), "Windows roots should use roaming config and local state");
const mac = userRoots({ platform: "darwin", home: "/Users/demo", env: {} });
assert(mac.config.includes("Application Support") && mac.cache.includes("Library"), "macOS roots should use Library directories");
const overridden = userRoots({ env: { HY_WORKFLOW_CONFIG_HOME: "/tmp/c", HY_WORKFLOW_STATE_HOME: "/tmp/s", HY_WORKFLOW_CACHE_HOME: "/tmp/k" } });
assert(overridden.config === "/tmp/c" && overridden.state === "/tmp/s" && overridden.cache === "/tmp/k", "explicit runtime roots should win");

const root = makeGitProject("hy-user-paths-");
const identity = resolveProjectIdentity(root);
assert(identity.id === resolveProjectIdentity(root).id, "project identity should be stable");
const paths = projectPaths(root, { config: "/tmp/hy-c", state: "/tmp/hy-s", cache: "/tmp/hy-k" });
assert(paths.config.startsWith("/tmp/hy-c/") && paths.workflowState.startsWith("/tmp/hy-s/") && paths.docsGraph.startsWith("/tmp/hy-k/"), "project artifacts should be partitioned by user roots");
assert(!Object.values(paths).filter(value => typeof value === "string").some(value => value.startsWith(root)), "runtime artifact paths must stay outside the project root");
