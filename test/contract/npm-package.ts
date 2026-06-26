import { readPackageJson } from "../../src/adapters/npm-package.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const pkg = readPackageJson(process.cwd());
assert(pkg.main === "dist/server.js", "main should point at dist/server.js");
assert(pkg.bin?.["hy-workflow"] === "dist/server.js", "bin should point at dist/server.js");
for (const script of ["build", "lint:contract", "test", "test:unit", "test:e2e", "test:contract", "verify"]) {
  assert(Boolean(pkg.scripts?.[script]), "missing script " + script);
}
assert(pkg.files?.includes("dist"), "files should include dist");
assert(pkg.files?.includes("docs"), "files should include docs");
assert(pkg.files?.includes("README.md"), "files should include README.md");

