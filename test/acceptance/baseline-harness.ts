import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeFixture(root: string, fixture: any): void {
  for (const relative of fixture.files) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    const content = relative.endsWith(".md") ? "# " + fixture.id + "\n\nAcceptance baseline fact.\n"
      : relative.endsWith(".json") ? "{}\n"
      : relative.endsWith(".py") ? "value = 1\n"
      : relative.endsWith(".rs") ? "pub const VALUE: i32 = 1;\n"
      : relative.endsWith(".ts") || relative.endsWith(".tsx") || relative.endsWith(".js") ? "export const value = 1;\n"
      : "";
    writeFileSync(target, content);
  }
}
