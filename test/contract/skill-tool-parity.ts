import { COMMAND_NAMES } from "../../src/commands/catalog.js";
import { SKILL_CONTRACTS } from "../../src/skills/catalog.js";
import { readFileSync } from "node:fs";

for (const skill of SKILL_CONTRACTS) {
  const text = readFileSync(skill.path, "utf-8");
  for (const tool of skill.tools) {
    if (!COMMAND_NAMES.includes(tool)) throw new Error("unknown skill tool " + tool);
    if (!text.includes(tool)) throw new Error("skill missing tool " + tool);
  }
}

