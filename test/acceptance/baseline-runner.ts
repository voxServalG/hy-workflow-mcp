import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspace, packAndMountOffline, terminateAllAcceptanceChildren } from "./harness.js";
import { installDocsGardenerStub } from "./baseline-harness.js";
import { runBaselineFixture } from "./baseline-scenarios.js";

const sourceRoot = process.cwd();
const matrix = JSON.parse(readFileSync(join(sourceRoot, "test", "acceptance", "baseline-matrix.json"), "utf8"));
if (matrix?.schemaVersion !== "1" || !Array.isArray(matrix.fixtures) || matrix.fixtures.length < 6) throw new Error("Acceptance baseline matrix must contain at least six fixtures");
const incidents = matrix.fixtures.map((fixture: any) => fixture.incident);
if (incidents.some((id: unknown) => typeof id !== "string" || !String(id).startsWith("INC-")) || new Set(incidents).size !== incidents.length) throw new Error("Acceptance baseline incidents must be unique INC-* identifiers");
const workspace = createWorkspace(sourceRoot);
const started = Date.now();
const results: Array<Record<string, unknown>> = [];
let timer: NodeJS.Timeout | undefined;
try {
  await packAndMountOffline(workspace);
  installDocsGardenerStub(workspace);
  await Promise.race([
    (async () => {
      for (const fixture of matrix.fixtures) {
        const result = await runBaselineFixture(workspace, fixture);
        results.push(result);
        process.stdout.write(JSON.stringify({ event: "acceptance-baseline-scenario", ok: true, ...result }) + "\n");
      }
    })(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Acceptance baseline exceeded 15 minutes")), 900_000); }),
  ]);
  if (results.length !== matrix.fixtures.length) throw new Error(`Acceptance baseline completed ${results.length}/${matrix.fixtures.length}; skips are forbidden`);
  process.stdout.write(JSON.stringify({ event: "acceptance-baseline-complete", ok: true, offline: true, packedTarball: true, scenarios: results.length, durationMs: Date.now() - started }) + "\n");
} finally {
  if (timer) clearTimeout(timer);
  terminateAllAcceptanceChildren();
}
