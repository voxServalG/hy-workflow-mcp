import { executeSetup } from "../../src/setup/operations.js";
import { setSetupTestHooks } from "./setup-hooks.js";

const [root, phase] = process.argv.slice(2);
if (!root || !phase) process.exit(2);
const kill = (): never => {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the process");
};
let staged = false;
setSetupTestHooks({
  afterDirectoryStage: phase === "stage" ? () => { if (!staged) { staged = true; kill(); } } : undefined,
  afterUnsetRegistryWrite: phase === "registry" ? kill : undefined,
  beforeDirectoryCleanup: phase === "cleanup" ? kill : undefined,
});
await executeSetup(root, {
  action: "unset",
  mode: "shared",
  clients: [],
  language: "en",
  yes: true,
  dryRun: false,
  json: true,
  removeGlobal: false,
}, []);
