import { COMMAND_NAMES } from "../commands/catalog.js";

export const CORE_SKILL_PATH = "docs/skills/core/SKILL.md";

export const CORE_SKILL_TOOL_REFERENCES = [...COMMAND_NAMES];

export type SkillContract = {
  path: string;
  tools: string[];
  requiresWorkflowOrder: boolean;
  requiresOutputContract: boolean;
  requiresRecoveryGuidance: boolean;
};

export const SKILL_CONTRACTS: SkillContract[] = [
  {
    path: CORE_SKILL_PATH,
    tools: CORE_SKILL_TOOL_REFERENCES,
    requiresWorkflowOrder: true,
    requiresOutputContract: true,
    requiresRecoveryGuidance: true,
  },
];

