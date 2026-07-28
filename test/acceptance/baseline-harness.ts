import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AcceptanceWorkspace } from "./harness.js";

const DOCS_TOOLS = ["garden-fix", "garden-grow", "garden-polish", "garden-scan", "garden-scan-hard", "garden-scan-soft"];

export function installDocsGardenerStub(workspace: AcceptanceWorkspace): void {
  const target = join(workspace.bin, process.platform === "win32" ? "docs-gardener.cmd" : "docs-gardener");
  const script = join(workspace.root, "docs-gardener-stub.mjs");
  writeFileSync(script, `import {createInterface} from "node:readline";
if(process.argv.includes("--version")){console.log("baseline-stub-1");process.exit(0)}
const names=${JSON.stringify(DOCS_TOOLS)};const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.method==="initialize")reply(m.id,{protocolVersion:m.params?.protocolVersion??"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"docs-gardener-baseline",version:"1"}});else if(m.method==="tools/list")reply(m.id,{tools:names.map(name=>({name,inputSchema:{type:"object",properties:{}}}))});else if(m.method==="ping")reply(m.id,{})});
`);
  if (process.platform === "win32") writeFileSync(target, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  else { writeFileSync(target, `#!${process.execPath}\nimport "${script}";\n`); chmodSync(target, 0o755); }
}

export function writeFixture(root: string, fixture: any): void {
  for (const relative of fixture.files) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    const content = relative.endsWith(".md") ? `# ${fixture.id}\n\nAcceptance baseline fact.\n`
      : relative.endsWith(".json") ? "{}\n"
      : relative.endsWith(".py") ? "value = 1\n"
      : relative.endsWith(".rs") ? "pub const VALUE: i32 = 1;\n"
      : relative.endsWith(".ts") || relative.endsWith(".tsx") || relative.endsWith(".js") ? "export const value = 1;\n" : "";
    writeFileSync(target, content);
  }
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify({
    project: { baseBranch: fixture.branch, codeExt: fixture.codeExt, codeDirs: fixture.codeDirs, docsDir: fixture.docsDir },
    codelint: { lintDirs: fixture.codeDirs, maxLinesWarning: 300, maxLinesError: 500 },
    doclint: { maxLinesWarning: 200, maxLinesError: 500 },
    docsGardener: { catalogs: {} },
    ci: { commands: ["node --version"] },
  }, null, 2) + "\n");
}
