import * as fs from "node:fs";

type PackageMetadata = {
  name: string;
  version: string;
};

const metadata = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;
