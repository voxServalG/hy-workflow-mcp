#!/usr/bin/env node
import { runContractLint } from "./run.js";

const report = runContractLint(process.cwd());
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exitCode = report.ok ? 0 : 1;

