import * as fs from "node:fs";
import { withRuntimeCompatConfigs } from "../../src/config.js";

const [root, ready, release] = process.argv.slice(2);
if (!root || !ready || !release) process.exit(2);

withRuntimeCompatConfigs(root, () => {
  fs.writeFileSync(ready, "ready\n");
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(release)) Atomics.wait(signal, 0, 0, 50);
});
