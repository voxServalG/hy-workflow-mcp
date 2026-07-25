import type { LanguageProfile } from "./types.js";
import * as path from "node:path";
import * as fs from "node:fs";

export const GoProfile: LanguageProfile = {
  name: "go",
  extensions: [".go"],

  detect(root: string): boolean {
    return fs.existsSync(path.join(root, "go.mod"));
  },

  compileCommands(_root, _config) {
    // Go compilation is not a hard gate for hy_verify (CI runs go test)
    return [];
  },

  manifestFiles: ["go.mod", "go.sum"],

  defaultTest: () => "go test ./...",
};
