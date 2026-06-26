import { runDocLint } from "../../src/checks.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const result = runDocLint(process.cwd())[0];
assert(result.name === "doclint", "should be doclint result");
assert(result.layer === "lint", "should be lint layer");
assert(result.passed, `current doclint output should pass: ${result.detail}`);
assert(result.detail.includes("errors"), `detail should include errors count: ${result.detail}`);
assert(result.detail.includes("warnings"), `detail should include warnings count: ${result.detail}`);
assert(result.detail.includes("files"), `detail should include file count: ${result.detail}`);
assert(!result.detail.includes("undefined"), `detail must not contain undefined: ${result.detail}`);
