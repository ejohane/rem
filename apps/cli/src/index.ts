#!/usr/bin/env bun
import { Command } from "commander";

import type { Actor, PluginManifest } from "@rem/schemas";

import {
  type NoteFormat,
  acceptProposalViaCore,
  createProposalViaCore,
  getCoreStatus,
  getDraftViaCore,
  getNoteViaCore,
  getProposalViaCore,
  listDraftsViaCore,
  listEventsViaCore,
  listPluginsViaCore,
  listProposalsViaCore,
  listSectionsViaCore,
  migrateSectionIdentityViaCore,
  rebuildIndexViaCore,
  registerPluginViaCore,
  rejectProposalViaCore,
  saveDraftViaCore,
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

function parseListOption(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts : undefined;
}

function resolveActorOptions(
  payloadActor: Actor | undefined,
  options: {
    actorKind?: "human" | "agent";
    actorId?: string;
  },
): Actor | undefined {
  if (payloadActor) {
    return payloadActor;
  }

  if (!options.actorKind && !options.actorId) {
    return undefined;
  }

  return {
    kind: options.actorKind ?? "human",
    id: options.actorId || undefined,
  };
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
      `ok=${status.ok} notes=${status.notes} proposals=${status.proposals} drafts=${status.drafts} plugins=${status.plugins} events=${status.events} lastIndexedEventAt=${status.lastIndexedEventAt ?? "none"} hints=${status.healthHints.length} store=${status.storeRoot}\n`,
    );
  });

program
  .command("search")
  .argument("<query>", "Full-text query")
  .option("--limit <number>", "Result limit", "20")
  .option("--tags <tags>", "Comma-separated tags filter")
  .option("--note-types <types>", "Comma-separated note type filter")
  .option("--plugin-namespaces <namespaces>", "Comma-separated plugin namespace filter")
  .option("--created-since <iso>", "Created timestamp lower bound (inclusive)")
  .option("--created-until <iso>", "Created timestamp upper bound (inclusive)")
  .option("--updated-since <iso>", "Updated timestamp lower bound (inclusive)")
  .option("--updated-until <iso>", "Updated timestamp upper bound (inclusive)")
  .option("--json", "Emit JSON output")
  .action(
    async (
      query: string,
      options: {
        limit: string;
        tags?: string;
        noteTypes?: string;
        pluginNamespaces?: string;
        createdSince?: string;
        createdUntil?: string;
        updatedSince?: string;
        updatedUntil?: string;
        json?: boolean;
      },
    ) => {
      const limit = Number.parseInt(options.limit, 10);
      const results = await searchNotesViaCore(query, {
        limit: Number.isNaN(limit) ? 20 : limit,
        tags: parseListOption(options.tags),
        noteTypes: parseListOption(options.noteTypes),
        pluginNamespaces: parseListOption(options.pluginNamespaces),
        createdSince: options.createdSince,
        createdUntil: options.createdUntil,
        updatedSince: options.updatedSince,
        updatedUntil: options.updatedUntil,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify(results)}\n`);
        return;
      }

      for (const item of results) {
        process.stdout.write(`${item.id} ${item.title}\n`);
      }
    },
  );

const notesCommand = program.command("notes").description("Notes commands");

notesCommand
  .command("save")
  .description("Create or update a note using a JSON payload")
  .requiredOption("--input <path>", "Path to JSON payload")
  .option("--actor-kind <kind>", "Actor kind override: human|agent")
  .option("--actor-id <id>", "Actor id override")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      input: string;
      actorKind?: "human" | "agent";
      actorId?: string;
      json?: boolean;
    }) => {
      try {
        const payload = JSON.parse(await Bun.file(options.input).text()) as {
          id?: string;
          title: string;
          noteType?: string;
          lexicalState: unknown;
          tags?: string[];
          plugins?: Record<string, unknown>;
          actor?: Actor;
        };

        const actor = resolveActorOptions(payload.actor, options) ?? {
          kind: "human",
          id: "cli",
        };

        const result = await saveNoteViaCore({
          id: payload.id,
          title: payload.title,
          noteType: payload.noteType,
          lexicalState: payload.lexicalState,
          tags: payload.tags,
          plugins: payload.plugins,
          actor,
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }

        process.stdout.write(`${result.created ? "created" : "updated"} note ${result.noteId}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to save note";
        emitError(options, "note_save_failed", message);
      }
    },
  );

const draftsCommand = program.command("drafts").description("Draft commands");

draftsCommand
  .command("save")
  .description("Create or update a draft using a JSON payload")
  .requiredOption("--input <path>", "Path to JSON payload")
  .option("--json", "Emit JSON output")
  .action(async (options: { input: string; json?: boolean }) => {
    const payload = JSON.parse(await Bun.file(options.input).text()) as {
      id?: string;
      lexicalState: unknown;
      title?: string;
      tags?: string[];
      targetNoteId?: string;
      author?: { kind: "human" | "agent"; id?: string };
    };

    const result = await saveDraftViaCore({
      id: payload.id,
      lexicalState: payload.lexicalState,
      title: payload.title,
      tags: payload.tags,
      targetNoteId: payload.targetNoteId,
      author: payload.author,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    process.stdout.write(`${result.created ? "created" : "updated"} draft ${result.draftId}\n`);
  });

draftsCommand
  .command("list")
  .description("List drafts")
  .option("--limit <number>", "Result limit", "100")
  .option("--json", "Emit JSON output")
  .action(async (options: { limit: string; json?: boolean }) => {
    const limit = Number.parseInt(options.limit, 10);
    const drafts = await listDraftsViaCore({
      limit: Number.isNaN(limit) ? 100 : limit,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(drafts)}\n`);
      return;
    }

    for (const draft of drafts) {
      process.stdout.write(`${draft.id} ${draft.title}\n`);
    }
  });

draftsCommand
  .command("get")
  .description("Get a draft by id")
  .argument("<id>", "Draft id")
  .option("--json", "Emit JSON output")
  .action(async (id: string, options: { json?: boolean }) => {
    const draft = await getDraftViaCore(id);
    if (!draft) {
      emitError(options, "draft_not_found", `Draft not found: ${id}`);
      return;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(draft)}\n`);
      return;
    }

    process.stdout.write(`${draft.draftId} ${draft.meta.title}\n`);
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

const eventsCommand = program.command("events").description("Event stream commands");

eventsCommand
  .command("list")
  .description("List events")
  .option("--limit <number>", "Result limit", "100")
  .option("--since <iso>", "Timestamp lower bound (inclusive)")
  .option("--type <type>", "Event type filter")
  .option("--actor-kind <kind>", "Actor kind: human|agent")
  .option("--actor-id <id>", "Actor id filter")
  .option("--entity-kind <kind>", "Entity kind: note|proposal|draft|plugin")
  .option("--entity-id <id>", "Entity id filter")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      limit: string;
      since?: string;
      type?: string;
      actorKind?: "human" | "agent";
      actorId?: string;
      entityKind?: "note" | "proposal" | "draft" | "plugin";
      entityId?: string;
      json?: boolean;
    }) => {
      try {
        const limit = Number.parseInt(options.limit, 10);
        const events = await listEventsViaCore({
          since: options.since,
          limit: Number.isNaN(limit) ? 100 : limit,
          type: options.type,
          actorKind: options.actorKind,
          actorId: options.actorId,
          entityKind: options.entityKind,
          entityId: options.entityId,
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(events)}\n`);
          return;
        }

        for (const event of events) {
          process.stdout.write(
            `${event.timestamp} ${event.type} ${event.entity.kind}:${event.entity.id}\n`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to list events";
        emitError(options, "events_list_failed", message);
      }
    },
  );

eventsCommand
  .command("tail")
  .description("List the most recent events")
  .option("--limit <number>", "Result limit", "50")
  .option("--json", "Emit JSON output")
  .action(async (options: { limit: string; json?: boolean }) => {
    const limit = Number.parseInt(options.limit, 10);
    const events = await listEventsViaCore({
      limit: Number.isNaN(limit) ? 50 : limit,
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(events)}\n`);
      return;
    }

    for (const event of events) {
      process.stdout.write(
        `${event.timestamp} ${event.type} ${event.entity.kind}:${event.entity.id}\n`,
      );
    }
  });

const pluginCommand = program.command("plugin").description("Plugin registry commands");

pluginCommand
  .command("register")
  .description("Register or update a plugin manifest from JSON")
  .requiredOption("--manifest <path>", "Path to plugin manifest JSON")
  .option("--registration-kind <kind>", "Registration kind: static|dynamic", "dynamic")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "cli-plugin-admin")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      manifest: string;
      registrationKind: "static" | "dynamic";
      actorKind: "human" | "agent";
      actorId: string;
      json?: boolean;
    }) => {
      try {
        const manifest = JSON.parse(await Bun.file(options.manifest).text()) as {
          namespace: string;
          schemaVersion: string;
          payloadSchema: unknown;
        };

        const result = await registerPluginViaCore({
          manifest: {
            namespace: manifest.namespace,
            schemaVersion: manifest.schemaVersion,
            payloadSchema: manifest.payloadSchema as PluginManifest["payloadSchema"],
          },
          registrationKind: options.registrationKind,
          actor: {
            kind: options.actorKind,
            id: options.actorId || undefined,
          },
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }

        process.stdout.write(
          `${result.created ? "registered" : "updated"} plugin ${result.namespace}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to register plugin";
        emitError(options, "plugin_register_failed", message);
      }
    },
  );

pluginCommand
  .command("list")
  .description("List plugin manifests")
  .option("--limit <number>", "Result limit", "100")
  .option("--json", "Emit JSON output")
  .action(async (options: { limit: string; json?: boolean }) => {
    try {
      const limit = Number.parseInt(options.limit, 10);
      const plugins = await listPluginsViaCore(Number.isNaN(limit) ? 100 : limit);

      if (options.json) {
        process.stdout.write(`${JSON.stringify(plugins)}\n`);
        return;
      }

      for (const plugin of plugins) {
        process.stdout.write(`${plugin.manifest.namespace} ${plugin.manifest.schemaVersion}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to list plugins";
      emitError(options, "plugin_list_failed", message);
    }
  });

const migrateCommand = program.command("migrate").description("Migration commands");

migrateCommand
  .command("sections")
  .description("Backfill durable section identity for all notes")
  .option("--json", "Emit JSON output")
  .action(async (options: { json?: boolean }) => {
    const result = await migrateSectionIdentityViaCore();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    process.stdout.write(
      `migration=${result.migration} scanned=${result.scanned} migrated=${result.migrated} skipped=${result.skipped} events=${result.events}\n`,
    );
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
