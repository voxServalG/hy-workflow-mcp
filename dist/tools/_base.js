import { readState, writeState, transition, assertPhase } from "../state.js";
export function toolResult(next, fields = {}) {
    return {
        ok: fields.ok ?? fields.error === undefined,
        phase: fields.phase ?? next,
        next,
        ...fields,
    };
}
// Shared helper
export { readState, writeState, transition, assertPhase };
//# sourceMappingURL=_base.js.map