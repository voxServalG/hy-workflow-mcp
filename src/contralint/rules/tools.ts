import { COMMAND_CONTRACTS, COMMAND_NAMES } from "../../commands/catalog.js";
import { exists, markdownMentions, readText, walkFiles } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

function serverToolNames(text: string): string[] {
  return [...text.matchAll(/name:\s*"(hy_[^"]+)"/g)].map(match => match[1]).sort();
}

export function checkToolContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const server = readText(context.root, "src/server.ts");
  const docs = ["README.md", "docs/tools.md", "docs/cli.md"].filter(file => exists(context.root, file));
  const actual = serverToolNames(server);
  const expected = [...COMMAND_NAMES].sort();
  for (const name of expected.filter(name => !actual.includes(name))) {
    findings.push({ rule: "tools", severity: "hard_fail", message: "Tool " + name + " is declared in the command catalog but not registered in src/server.ts.", file: "src/server.ts" });
  }
  for (const name of actual.filter(name => !expected.includes(name))) {
    findings.push({ rule: "tools", severity: "hard_fail", message: "Tool " + name + " is registered in src/server.ts but missing from src/commands/catalog.ts.", file: "src/commands/catalog.ts" });
  }
  for (const command of COMMAND_CONTRACTS) {
    if (!exists(context.root, command.handlerFile)) {
      findings.push({ rule: "tools", severity: "hard_fail", message: "Tool handler is missing for " + command.name + ".", file: command.handlerFile });
    }
    for (const doc of docs) {
      if (!markdownMentions(readText(context.root, doc), command.name)) {
        findings.push({ rule: "tools", severity: "amend_required", message: "Documentation " + doc + " does not mention " + command.name + ".", file: doc });
      }
    }
  }
  const testText = walkFiles(context.root, "test", file => file.endsWith(".ts"))
    .map(file => readText(context.root, file))
    .join("\\n");
  for (const name of expected) {
    if (!testText.includes(name)) {
      findings.push({ rule: "tools", severity: "amend_required", message: "No contract or e2e test text references " + name + ".", file: "test" });
    }
  }
  return findings;
}

