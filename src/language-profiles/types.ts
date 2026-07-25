import type { CheckResult } from "../checks.js";

/** A compile command a profile wants to run. */
export interface CompileCommand {
  command: string | { file: string; args: string[] };
  successDetail: string;
  failDetail: string;
  hard: boolean;
  layer: string;
  name: string;
}

export interface CompileConfig {
  exts: string[];
  codeDirs: string[];
}

export interface LanguageProfile {
  name: string;
  extensions: string[];
  detect(root: string): boolean;
  /** Return compile commands for this language. Empty = nothing to compile. */
  compileCommands(root: string, config: CompileConfig): CompileCommand[];
  /** Manifest files to check in boundary.no_new_external. */
  manifestFiles: string[];
  /** Default CI test command, or null. */
  defaultTest(root: string): string | null;
}
