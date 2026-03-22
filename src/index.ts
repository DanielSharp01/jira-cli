#!/usr/bin/env bun
import { buildProgram } from "./cli/index.ts";

// Commander treats args starting with "-" as flags.
// Transform -N-unit date expressions (e.g. -2-month) to __neg__N-unit
// before parsing so they're treated as positional arguments.
const argv = process.argv.map(arg =>
  /^-\d+-(year|month|week)(-end)?$/.test(arg) ? `__neg__${arg.slice(1)}` : arg
);
const program = buildProgram();

// No args → show help
if (process.argv.length <= 2) {
  program.help();
} else {
  program.parse(argv);
}
