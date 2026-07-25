import type { LanguageProfile } from "./types.js";
import { TypeScriptProfile } from "./typescript.js";
import { PythonProfile } from "./python.js";
import { GoProfile } from "./go.js";
import { RustProfile } from "./rust.js";

export const PROFILES: readonly LanguageProfile[] = [
  TypeScriptProfile,
  PythonProfile,
  GoProfile,
  RustProfile,
];

export { TypeScriptProfile, PythonProfile, GoProfile, RustProfile };
export type { LanguageProfile, CompileCommand, CompileConfig } from "./types.js";
