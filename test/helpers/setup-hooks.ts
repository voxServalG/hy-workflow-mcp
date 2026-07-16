import type { InternalSetupTestHooks } from "../../src/setup/test-hooks.js";

const KEY = Symbol.for("@voxstudio/hy-workflow/internal-setup-test-hooks");

export function setSetupTestHooks(hooks: InternalSetupTestHooks): () => void {
  const previous = (globalThis as any)[KEY];
  (globalThis as any)[KEY] = hooks;
  return () => {
    if (previous === undefined) delete (globalThis as any)[KEY];
    else (globalThis as any)[KEY] = previous;
  };
}
