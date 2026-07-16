import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [failAt, ...setupArgs] = process.argv.slice(2);
const packageRoot = process.env.HY_ACCEPTANCE_PACKAGE_ROOT;
if (!failAt || failAt.startsWith("--")) throw new Error("test-only setup child requires one failpoint");
if (!packageRoot) throw new Error("HY_ACCEPTANCE_PACKAGE_ROOT is required");

const setupCli = join(realpathSync(packageRoot), "dist", "setup-cli.js");
if (!existsSync(setupCli)) throw new Error("installed acceptance package is missing dist/setup-cli.js");

const hookKey = Symbol.for("@voxstudio/hy-workflow/internal-setup-test-hooks");
globalThis[hookKey] = { failAt };
try {
  const { runSetupCli } = await import(pathToFileURL(setupCli).href);
  process.exitCode = await runSetupCli(setupArgs, "setup", process.cwd());
} finally {
  delete globalThis[hookKey];
}
