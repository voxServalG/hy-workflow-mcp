export const PHASES = [
  "init",
  "plan",
  "approve",
  "branch",
  "edit",
  "verify",
  "commit",
  "merge",
  "done",
] as const;

export type Phase = typeof PHASES[number];

export const VALID_TRANSITIONS: Record<Phase, Phase[]> = {
  init: ["init", "plan", "done"],
  plan: ["plan", "approve", "done"],
  approve: ["approve", "branch", "plan"],
  branch: ["branch", "edit", "done"],
  edit: ["edit", "verify", "commit", "done"],
  verify: ["verify", "edit", "commit", "done"],
  commit: ["commit", "edit", "merge", "done"],
  merge: ["merge", "done"],
  done: ["done"],
};

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

