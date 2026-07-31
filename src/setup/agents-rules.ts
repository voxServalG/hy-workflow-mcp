/**
 * Permanent tombstone for the retired project AGENTS injection.
 *
 * Setup has no AGENTS project artifact, migration format, parser, or content
 * contract. Keep this single boolean only so package consumers can detect that
 * the former module is intentionally inert instead of treating its absence as
 * a packaging failure.
 */
export const AGENTS_INJECTION_RETIRED = true as const;
