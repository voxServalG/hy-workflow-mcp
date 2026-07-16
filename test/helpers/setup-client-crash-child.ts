import { createOpenCodeAdapter } from "../../src/setup/clients/opencode.js";
import { executeSetup } from "../../src/setup/operations.js";
import { setSetupTestHooks } from "./setup-hooks.js";

const root = process.argv[2];
if (!root) process.exit(2);
setSetupTestHooks({
  skipHandshake: true,
  afterClientCommandBeforeJournal: (client, server) => {
    if (client !== "opencode" || server !== "hy-workflow") return;
    process.kill(process.pid, "SIGKILL");
  },
});
await executeSetup(root, {
  action: "setup",
  mode: "shared",
  clients: ["opencode"],
  language: "en",
  yes: true,
  dryRun: false,
  json: true,
  removeGlobal: false,
  acceptCiCommands: true,
  ciCommands: ["npm ci", "npm run build", "npm run test"],
}, [createOpenCodeAdapter(root)], { inspectDirectTools: false });
