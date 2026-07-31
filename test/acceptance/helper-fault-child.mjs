import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, point, action] = process.argv.slice(2);
if (!packageRoot || !point || !action) throw new Error("usage: helper-fault-child <package-root> <point> <fail|kill|converge|remove>");

const moduleUrl = pathToFileURL(join(packageRoot, "dist", "helper", "skills.js")).href;
const {
  removeHelperSkills,
  updateHelperSkills,
} = await import(moduleUrl);
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const originalBundle = join(packageRoot, "skills");

if (action === "remove") {
  const result = removeHelperSkills({});
  process.stdout.write(JSON.stringify({ ok: true, action: result.action }) + "\n");
  process.exit(0);
}

if (action === "converge") {
  const result = updateHelperSkills({
    bundleRoot: originalBundle,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    repair: true,
  });
  process.stdout.write(JSON.stringify({ ok: true, action: result.action, point }) + "\n");
  process.exit(0);
}

if (action !== "fail" && action !== "kill") throw new Error("unknown helper fault action: " + action);
const temporary = mkdtempSync(join(tmpdir(), "hy-helper-fault-bundle-"));
const mutatedBundle = join(temporary, "skills");
cpSync(originalBundle, mutatedBundle, { recursive: true });
appendFileSync(join(mutatedBundle, "hy-status", "SKILL.md"), "\nFault bundle marker: " + point + "\n");

const injected = new Error("acceptance injected helper fault: " + point);
const injectFault = () => {
  if (action === "kill") process.kill(process.pid, "SIGKILL");
  throw injected;
};

const hooks = {
  afterMutation(_destination, index) {
    if (point === "after-mutation-" + index) injectFault();
  },
  beforeManifestWrite() {
    if (point === "before-manifest") injectFault();
  },
};

try {
  updateHelperSkills({
    bundleRoot: mutatedBundle,
    packageName: packageJson.name,
    packageVersion: packageJson.version + "-fault",
    hooks,
  });
  throw new Error("fault point was not reached: " + point);
} catch (error) {
  if (error !== injected) throw error;
  process.stdout.write(JSON.stringify({ ok: true, injected: point, rolledBack: true }) + "\n");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
