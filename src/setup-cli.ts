import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runSetupCli(): number {
  const setupPath = fileURLToPath(new URL("../setup", import.meta.url));
  const bash = process.env.HY_WORKFLOW_BASH || "bash";
  const result = spawnSync(bash, [setupPath], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`hy-workflow setup failed: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
