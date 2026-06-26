import { COMMAND_NAMES } from "../../src/commands/catalog.js";
import { readFileSync } from "node:fs";

const EXPECTED_TOOL_LITERALS = [
  "hy_init",
  "hy_read_docs",
  "hy_plan",
  "hy_approve",
  "hy_branch",
  "hy_edit",
  "hy_sync_docs",
  "hy_verify",
  "hy_amend_plan",
  "hy_commit",
  "hy_ci",
  "hy_merge",
  "hy_chain",
  "hy_reset",
  "hy_status",
];

const docs = ["README.md", "docs/tools.md", "docs/cli.md"].map(file => readFileSync(file, "utf-8")).join("\n");
const server = readFileSync("src/server.ts", "utf-8");
const testSurface = COMMAND_NAMES.join("\n");

for (const tool of COMMAND_NAMES) {
  if (!docs.includes(tool)) throw new Error("docs missing tool " + tool);
  if (!server.includes('name: "' + tool + '"')) throw new Error("server missing tool " + tool);
  if (!testSurface.includes(tool)) throw new Error("test surface missing tool " + tool);
}


if (JSON.stringify([...COMMAND_NAMES].sort()) !== JSON.stringify([...EXPECTED_TOOL_LITERALS].sort())) {
  throw new Error("literal tool test list drifted from command catalog");
}
