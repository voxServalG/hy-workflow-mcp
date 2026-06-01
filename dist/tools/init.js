import { readState, writeState, transition, assertPhase } from "../state.js";
import { execSync } from "node:child_process";
export async function handleInit() {
    const state = readState();
    assertPhase(state, "init", "plan");
    // Run hy-harness deploy
    try {
        execSync("npx --yes github:voxServalG/hy-harness", { stdio: "inherit", timeout: 60_000 });
    }
    catch {
        return { next: "init", error: "Harness deployment failed. Check Node.js >= 18 and Python >= 3.10." };
    }
    const next = transition(state, "plan");
    next.phase = "plan";
    writeState(next);
    return { next: "plan", message: "Harness deployed. Run hy_plan to define your task." };
}
//# sourceMappingURL=init.js.map