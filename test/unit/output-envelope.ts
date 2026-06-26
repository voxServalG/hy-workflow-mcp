import { toolResult } from "../../src/output/envelope.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const ok = toolResult("plan", { display: { title: "ok" } });
assert(ok.ok === true, "success envelope should be ok");
assert(ok.phase === "plan" && ok.next === "plan", "success envelope should include phase and next");

const failed = toolResult("edit", { error: "scope drift detected", allowedTools: ["hy_edit"] });
assert(failed.ok === false, "error envelope should not be ok");
assert(failed.error?.type === "scope", "scope error should be classified");
assert(failed.error?.message.includes("scope drift"), "error message should survive normalization");
assert(failed.allowedTools?.includes("hy_edit"), "allowedTools should survive normalization");

