#!/usr/bin/env bun
import { Command } from "commander";

import { getCoreStatus } from "@rem/core";

const program = new Command();

program.name("rem").description("rem CLI");

program
  .command("status")
  .option("--json", "Emit JSON output")
  .action((options: { json?: boolean }) => {
    const status = getCoreStatus();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return;
    }

    process.stdout.write(`ok=${status.ok} timestamp=${status.timestamp}\n`);
  });

await program.parseAsync(process.argv);
