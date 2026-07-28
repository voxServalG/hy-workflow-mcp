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
const mergeRecovery = matrix.fixtures.filter((fixture: any) => fixture.kind === "merge-recovery");
if (mergeRecovery.length !== 1 || mergeRecovery[0].incident !== "INC-MERGE-UNKNOWN-OUTCOME") throw new Error("Acceptance baseline must execute exactly one INC-MERGE-UNKNOWN-OUTCOME recovery fixture");
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
        if (result.name !== fixture.id || result.incident !== fixture.incident) throw new Error(`Baseline fixture ${fixture.id} returned the wrong identity: ${JSON.stringify(result)}`);
        results.push(result);
        process.stdout.write(JSON.stringify({ event: "acceptance-baseline-scenario", ok: true, ...result }) + "\n");
      }
    })(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Acceptance baseline exceeded 15 minutes")), 900_000); }),
  ]);
  if (results.length !== matrix.fixtures.length) throw new Error(`Acceptance baseline completed ${results.length}/${matrix.fixtures.length}; skips are forbidden`);
  const completedIncidents = results.map(result => String(result.incident));
  if (!completedIncidents.includes("INC-MERGE-UNKNOWN-OUTCOME")) throw new Error("Acceptance baseline did not execute the merge unknown-outcome oracle");
  process.stdout.write(JSON.stringify({ event: "acceptance-baseline-complete", ok: true, offline: true, packedTarball: true, scenarios: results.length, incidents: completedIncidents, durationMs: Date.now() - started }) + "\n");
} finally {
  if (timer) clearTimeout(timer);
  terminateAllAcceptanceChildren();
}
