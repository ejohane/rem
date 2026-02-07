#!/usr/bin/env bun
import { Command } from "commander";

import { getCoreStatus, rebuildIndexViaCore, saveNoteViaCore, searchNotesViaCore } from "@rem/core";

const program = new Command();

program.name("rem").description("rem CLI");

program
  .command("status")
  .option("--json", "Emit JSON output")
  .action(async (options: { json?: boolean }) => {
    const status = await getCoreStatus();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return;
    }

    process.stdout.write(
      `ok=${status.ok} notes=${status.notes} events=${status.events} store=${status.storeRoot}\n`,
    );
  });

program
  .command("search")
  .argument("<query>", "Full-text query")
  .option("--limit <number>", "Result limit", "20")
  .option("--json", "Emit JSON output")
  .action(async (query: string, options: { limit: string; json?: boolean }) => {
    const limit = Number.parseInt(options.limit, 10);
    const results = await searchNotesViaCore(query, Number.isNaN(limit) ? 20 : limit);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(results)}\n`);
      return;
    }

    for (const item of results) {
      process.stdout.write(`${item.id} ${item.title}\n`);
    }
  });

const notesCommand = program.command("notes").description("Notes commands");

notesCommand
  .command("save")
  .description("Create or update a note using a JSON payload")
  .requiredOption("--input <path>", "Path to JSON payload")
  .option("--json", "Emit JSON output")
  .action(async (options: { input: string; json?: boolean }) => {
    const payload = JSON.parse(await Bun.file(options.input).text()) as {
      id?: string;
      title: string;
      lexicalState: unknown;
      tags?: string[];
    };

    const result = await saveNoteViaCore({
      id: payload.id,
      title: payload.title,
      lexicalState: payload.lexicalState,
      tags: payload.tags,
      actor: { kind: "human", id: "cli" },
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    process.stdout.write(`${result.created ? "created" : "updated"} note ${result.noteId}\n`);
  });

program
  .command("rebuild-index")
  .option("--json", "Emit JSON output")
  .action(async (options: { json?: boolean }) => {
    const status = await rebuildIndexViaCore();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return;
    }

    process.stdout.write(
      `rebuilt notes=${status.notes} events=${status.events} store=${status.storeRoot}\n`,
    );
  });

await program.parseAsync(process.argv);
