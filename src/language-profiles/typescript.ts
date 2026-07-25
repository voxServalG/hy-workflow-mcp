import type { LanguageProfile } from "./types.js";
import * as path from "node:path";
import * as fs from "node:fs";

export const TypeScriptProfile: LanguageProfile = {
  name: "typescript",
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],

  detect(root: string): boolean {
    // tsconfig.json OR .ts/.tsx files in source directories
    if (fs.existsSync(path.join(root, "tsconfig.json"))) return true;
    for (const dir of ["src", "lib", "app"]) {
      const abs = path.join(root, dir);
      if (!fs.existsSync(abs)) continue;
      for (const entry of fs.readdirSync(abs, { encoding: "utf8" })) {
        if (entry.endsWith(".ts") || entry.endsWith(".tsx")) return true;
      }
    }
    return false;
  },

  compileCommands(root: string, config) {
    const hasTs = config.exts.some(e => e === ".ts" || e === ".tsx");
    const hasJs = config.exts.some(e => [".js", ".jsx", ".mjs", ".cjs"].includes(e));
    const tsconfig = fs.existsSync(path.join(root, "tsconfig.json"));

    if (hasTs || (hasJs && tsconfig)) {
      return [{
        command: "npx tsc --noEmit",
        successDetail: "TypeScript build OK",
        failDetail: "TypeScript build failed",
        hard: true, layer: "compile", name: "compile: typescript",
      }];
    }
    if (hasJs) {
      return [{
        command: "echo skip", successDetail: "JS-only project has no TypeScript compile config",
        failDetail: "", hard: false, layer: "compile", name: "compile: javascript (no tsconfig)",
      }];
    }
    return [];
  },

  manifestFiles: [
    "package.json", "package-lock.json", "npm-shrinkwrap.json",
    "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  ],

  defaultTest: () => "npm test",
};
