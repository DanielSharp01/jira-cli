#!/usr/bin/env bun
import { buildProgram } from "./cli/index.ts";
import { runTui } from "./tui/index.ts";

// No args (or only the binary name) → interactive TUI
if (process.argv.length <= 2) {
  await runTui();
} else {
  const program = buildProgram();
  program.parse(process.argv);
}
