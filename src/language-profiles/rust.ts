import type { LanguageProfile } from "./types.js";
import * as path from "node:path";
import * as fs from "node:fs";

export const RustProfile: LanguageProfile = {
  name: "rust",
  extensions: [".rs"],

  detect(root: string): boolean {
    return fs.existsSync(path.join(root, "Cargo.toml"));
  },

  compileCommands(_root, _config) {
    // Rust compilation is not a hard gate for hy_verify (CI runs cargo test)
    return [];
  },

  manifestFiles: ["Cargo.toml", "Cargo.lock"],

  defaultTest: () => "cargo test --workspace --all-targets",
};
