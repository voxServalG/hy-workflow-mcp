import * as fs from "node:fs";
import * as path from "node:path";

export function readText(root: string, file: string): string {
  return fs.readFileSync(path.join(root, file), "utf-8");
}

export function exists(root: string, file: string): boolean {
  return fs.existsSync(path.join(root, file));
}

export function walkFiles(root: string, start: string, predicate = (_file: string) => true): string[] {
  const base = path.join(root, start);
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const relative = path.relative(root, full).replace(/\\/g, "/");
        if (predicate(relative)) out.push(relative);
      }
    }
  };
  walk(base);
  return out.sort();
}

export function markdownMentions(text: string, token: string): boolean {
  return text.includes("`" + token + "`") || text.includes(token);
}

