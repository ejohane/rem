#!/usr/bin/env bun
import { Command } from "commander";

import {
  type NoteFormat,
  acceptProposalViaCore,
  createProposalViaCore,
  getCoreStatus,
  getNoteViaCore,
  getProposalViaCore,
  listProposalsViaCore,
  listSectionsViaCore,
  rebuildIndexViaCore,
  rejectProposalViaCore,
  saveNoteViaCore,
  searchNotesViaCore,
} from "@rem/core";

const program = new Command();

function parseFallbackPath(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
}

function emitError(options: { json?: boolean }, code: string, message: string): void {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        error: {
          code,
          message,
        },
      })}\n`,
    );
  } else {
    process.stderr.write(`${message}\n`);
  }

  process.exitCode = 1;
}

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
      `ok=${status.ok} notes=${status.notes} proposals=${status.proposals} events=${status.events} store=${status.storeRoot}\n`,
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

const getCommand = program.command("get").description("Read commands");

getCommand
  .command("note")
  .description("Retrieve a note by id")
  .argument("<id>", "Note id")
  .option("--format <format>", "Output format: lexical|text|md", "lexical")
  .option("--json", "Emit JSON output")
  .action(async (id: string, options: { format: string; json?: boolean }) => {
    const format = options.format as NoteFormat;
    if (format !== "lexical" && format !== "text" && format !== "md") {
      emitError(options, "invalid_format", `Invalid format: ${options.format}`);
      return;
    }

    const note = await getNoteViaCore(id, format);
    if (!note) {
      emitError(options, "note_not_found", `Note not found: ${id}`);
      return;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(note)}\n`);
      return;
    }

    if (format === "lexical") {
      process.stdout.write(`${JSON.stringify(note.content, null, 2)}\n`);
      return;
    }

    process.stdout.write(`${String(note.content)}\n`);
  });

const sectionsCommand = program.command("sections").description("Section commands");

sectionsCommand
  .command("list")
  .description("List indexed sections for a note")
  .requiredOption("--note <id>", "Target note id")
  .option("--json", "Emit JSON output")
  .action(async (options: { note: string; json?: boolean }) => {
    const sections = await listSectionsViaCore(options.note);
    if (!sections) {
      emitError(options, "note_not_found", `Note not found: ${options.note}`);
      return;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(sections)}\n`);
      return;
    }

    for (const section of sections) {
      process.stdout.write(
        `${section.sectionId} ${section.headingText} [${section.fallbackPath.join(" > ")}]\n`,
      );
    }
  });

const proposalsCommand = program.command("proposals").description("Proposal commands");

proposalsCommand
  .command("create")
  .description("Create a proposal")
  .requiredOption("--note <id>", "Target note id")
  .requiredOption("--section <id>", "Target section id")
  .option("--fallback <path>", "Comma-separated fallback path")
  .option("--type <type>", "Proposal type: replace_section|annotate", "replace_section")
  .option("--text <text>", "Proposal content as plain text")
  .option("--content-file <path>", "JSON file containing proposal content payload")
  .option("--rationale <text>", "Optional rationale")
  .option("--agent-id <id>", "Agent actor id", "cli-agent")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      note: string;
      section: string;
      fallback?: string;
      type: "replace_section" | "annotate";
      text?: string;
      contentFile?: string;
      rationale?: string;
      agentId: string;
      json?: boolean;
    }) => {
      let content: {
        format: "lexical" | "text" | "json";
        content: unknown;
        schemaVersion?: string;
      };

      if (options.text) {
        content = {
          format: "text",
          content: options.text,
        };
      } else if (options.contentFile) {
        content = JSON.parse(await Bun.file(options.contentFile).text()) as {
          format: "lexical" | "text" | "json";
          content: unknown;
          schemaVersion?: string;
        };
      } else {
        emitError(options, "missing_content", "Provide --text or --content-file");
        return;
      }

      try {
        const result = await createProposalViaCore({
          actor: { kind: "agent", id: options.agentId },
          target: {
            noteId: options.note,
            sectionId: options.section,
            fallbackPath: parseFallbackPath(options.fallback),
          },
          proposalType: options.type,
          content,
          rationale: options.rationale,
          source: "cli",
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }

        process.stdout.write(`created proposal ${result.proposalId}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to create proposal";
        emitError(options, "proposal_create_failed", message);
      }
    },
  );

proposalsCommand
  .command("list")
  .description("List proposals")
  .option("--status <status>", "Status filter: open|accepted|rejected|superseded")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      status?: "open" | "accepted" | "rejected" | "superseded";
      json?: boolean;
    }) => {
      try {
        const proposals = await listProposalsViaCore({ status: options.status });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(proposals)}\n`);
          return;
        }

        for (const record of proposals) {
          process.stdout.write(
            `${record.proposal.id} ${record.proposal.status} ${record.proposal.target.noteId}/${record.proposal.target.sectionId}\n`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to list proposals";
        emitError(options, "proposal_list_failed", message);
      }
    },
  );

proposalsCommand
  .command("get")
  .description("Get a proposal by id")
  .argument("<id>", "Proposal id")
  .option("--json", "Emit JSON output")
  .action(async (id: string, options: { json?: boolean }) => {
    const proposal = await getProposalViaCore(id);
    if (!proposal) {
      emitError(options, "proposal_not_found", `Proposal not found: ${id}`);
      return;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(proposal)}\n`);
      return;
    }

    process.stdout.write(
      `${proposal.proposal.id} ${proposal.proposal.status} ${proposal.proposal.target.noteId}/${proposal.proposal.target.sectionId}\n`,
    );
  });

proposalsCommand
  .command("accept")
  .description("Accept a proposal")
  .argument("<id>", "Proposal id")
  .option("--reviewer-id <id>", "Reviewer actor id", "cli-reviewer")
  .option("--json", "Emit JSON output")
  .action(async (id: string, options: { reviewerId: string; json?: boolean }) => {
    try {
      const result = await acceptProposalViaCore({
        proposalId: id,
        actor: { kind: "human", id: options.reviewerId },
      });

      if (!result) {
        emitError(options, "proposal_not_found", `Proposal not found: ${id}`);
        return;
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }

      process.stdout.write(`accepted proposal ${id}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to accept proposal";
      emitError(options, "proposal_accept_failed", message);
    }
  });

proposalsCommand
  .command("reject")
  .description("Reject a proposal")
  .argument("<id>", "Proposal id")
  .option("--reviewer-id <id>", "Reviewer actor id", "cli-reviewer")
  .option("--json", "Emit JSON output")
  .action(async (id: string, options: { reviewerId: string; json?: boolean }) => {
    try {
      const result = await rejectProposalViaCore({
        proposalId: id,
        actor: { kind: "human", id: options.reviewerId },
      });

      if (!result) {
        emitError(options, "proposal_not_found", `Proposal not found: ${id}`);
        return;
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }

      process.stdout.write(`rejected proposal ${id}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reject proposal";
      emitError(options, "proposal_reject_failed", message);
    }
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
      `rebuilt notes=${status.notes} proposals=${status.proposals} events=${status.events} store=${status.storeRoot}\n`,
    );
  });

await program.parseAsync(process.argv);
