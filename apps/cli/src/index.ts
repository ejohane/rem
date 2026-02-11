#!/usr/bin/env bun
import path from "node:path";
import { Command } from "commander";

import type { Actor, PluginManifest } from "@rem/schemas";

import {
  type NoteFormat,
  acceptProposalViaCore,
  createProposalViaCore,
  getCoreStatus,
  getNoteViaCore,
  getProposalViaCore,
  listEventsViaCore,
  listPluginsViaCore,
  listProposalsViaCore,
  listSectionsViaCore,
  migrateSectionIdentityViaCore,
  rebuildIndexViaCore,
  registerPluginViaCore,
  rejectProposalViaCore,
  saveNoteViaCore,
  searchNotesViaCore,
} from "@rem/core";
import { getCannedSkill, listCannedSkills } from "./canned-skills";

const program = new Command();
const defaultApiHost = "127.0.0.1";
const defaultApiPort = 8787;
const appStartupTimeoutMs = 15000;
const appStartupPollIntervalMs = 250;

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

function parsePortOption(options: { json?: boolean }, value?: string): number | null {
  if (!value) {
    return defaultApiPort;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    emitError(options, "invalid_port", `Invalid port: ${value}`);
    return null;
  }

  return parsed;
}

function uniqueCandidates(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

async function resolveUiDistPath(preferredPath?: string): Promise<string | null> {
  const executableDir = path.dirname(process.execPath);
  const candidates = uniqueCandidates([
    preferredPath ?? "",
    process.env.REM_UI_DIST ?? "",
    path.join(executableDir, "ui-dist"),
    path.resolve(process.cwd(), "ui-dist"),
    path.resolve(process.cwd(), "apps/ui/dist"),
  ]);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const indexFile = Bun.file(path.join(resolved, "index.html"));
    if (await indexFile.exists()) {
      return resolved;
    }
  }

  return null;
}

async function resolveApiBinaryPath(preferredPath?: string): Promise<string | null> {
  const executableDir = path.dirname(process.execPath);
  const candidates = uniqueCandidates([
    preferredPath ?? "",
    process.env.REM_API_BINARY ?? "",
    path.join(executableDir, "rem-api"),
    path.resolve(process.cwd(), "rem-api"),
  ]);

  const bunWithWhich = Bun as unknown as {
    which?: (command: string) => string | null | undefined;
  };
  const fromPath = bunWithWhich.which?.("rem-api");
  if (fromPath) {
    candidates.push(fromPath);
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (await Bun.file(resolved).exists()) {
      return resolved;
    }
  }

  return null;
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      return true;
    } catch {
      // Poll until timeout.
    }

    await Bun.sleep(appStartupPollIntervalMs);
  }

  return false;
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];

  const openProcess = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
  });
  await openProcess.exited;
}

async function spawnApiProcess(options: {
  apiBinaryPath: string;
  host: string;
  port: number;
  uiDistPath?: string;
}): Promise<number> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    REM_API_HOST: options.host,
    REM_API_PORT: String(options.port),
  };
  if (options.uiDistPath) {
    env.REM_UI_DIST = options.uiDistPath;
  }

  const apiProcess = Bun.spawn([options.apiBinaryPath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  const handleInterrupt = () => {
    apiProcess.kill();
  };

  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleInterrupt);

  const exitCode = await apiProcess.exited;
  process.off("SIGINT", handleInterrupt);
  process.off("SIGTERM", handleInterrupt);

  return exitCode;
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
      `ok=${status.ok} notes=${status.notes} proposals=${status.proposals} plugins=${status.plugins} events=${status.events} lastIndexedEventAt=${status.lastIndexedEventAt ?? "none"} hints=${status.healthHints.length} store=${status.storeRoot}\n`,
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
  .option("--entity-kind <kind>", "Entity kind: note|proposal|plugin")
  .option("--entity-id <id>", "Entity id filter")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      limit: string;
      since?: string;
      type?: string;
      actorKind?: "human" | "agent";
      actorId?: string;
      entityKind?: "note" | "proposal" | "plugin";
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

const skillCommand = program.command("skill").description("Canned skill commands");

skillCommand
  .command("list")
  .description("List bundled canned skills that can be installed")
  .option("--json", "Emit JSON output")
  .action((options: { json?: boolean }) => {
    const skills = listCannedSkills().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }));

    if (options.json) {
      process.stdout.write(`${JSON.stringify(skills)}\n`);
      return;
    }

    for (const skill of skills) {
      process.stdout.write(`${skill.id} ${skill.name} - ${skill.description}\n`);
    }
  });

skillCommand
  .command("install")
  .description("Install a bundled canned skill into the local rem vault")
  .argument("<skill-id>", "Skill id from `rem skill list`")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "agent")
  .option("--actor-id <id>", "Actor id", "cli-skill-installer")
  .option("--json", "Emit JSON output")
  .action(
    async (
      skillId: string,
      options: {
        actorKind: "human" | "agent";
        actorId: string;
        json?: boolean;
      },
    ) => {
      const skill = getCannedSkill(skillId);
      if (!skill) {
        emitError(options, "skill_not_found", `Unknown canned skill: ${skillId}`);
        return;
      }

      try {
        const actor = {
          kind: options.actorKind,
          id: options.actorId || undefined,
        } as const;

        const pluginResult = await registerPluginViaCore({
          manifest: skill.pluginManifest,
          registrationKind: "static",
          actor,
        });

        const noteResult = await saveNoteViaCore({
          id: skill.note.id,
          title: skill.note.title,
          noteType: skill.note.noteType,
          lexicalState: skill.note.lexicalState,
          tags: skill.note.tags,
          plugins: {
            [skill.pluginManifest.namespace]: skill.note.payload,
          },
          actor,
        });

        const payload = {
          skillId: skill.id,
          pluginNamespace: skill.pluginManifest.namespace,
          pluginRegistered: pluginResult.created,
          noteId: noteResult.noteId,
          noteCreated: noteResult.created,
          eventId: noteResult.eventId,
        };

        if (options.json) {
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return;
        }

        process.stdout.write(
          `installed skill ${skill.id} (plugin=${skill.pluginManifest.namespace}, note=${noteResult.noteId})\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to install canned skill";
        emitError(options, "skill_install_failed", message);
      }
    },
  );

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

program
  .command("api")
  .description("Run the rem API binary")
  .option("--host <host>", "API host", defaultApiHost)
  .option("--port <number>", "API port", String(defaultApiPort))
  .option("--ui-dist <path>", "Optional UI dist directory for static file serving")
  .option("--api-binary <path>", "Path to rem-api binary")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      host: string;
      port: string;
      uiDist?: string;
      apiBinary?: string;
      json?: boolean;
    }) => {
      const port = parsePortOption(options, options.port);
      if (port === null) {
        return;
      }

      const apiBinaryPath = await resolveApiBinaryPath(options.apiBinary);
      if (!apiBinaryPath) {
        emitError(
          options,
          "api_binary_missing",
          "Unable to find rem-api binary. Pass --api-binary or set REM_API_BINARY.",
        );
        return;
      }

      let uiDistPath: string | undefined;
      if (options.uiDist) {
        const resolvedUiDist = await resolveUiDistPath(options.uiDist);
        if (!resolvedUiDist) {
          emitError(
            options,
            "ui_dist_missing",
            `Unable to find UI dist at ${options.uiDist}. Build UI first with: bun run --cwd apps/ui build`,
          );
          return;
        }
        uiDistPath = resolvedUiDist;
      }

      const exitCode = await spawnApiProcess({
        apiBinaryPath,
        host: options.host,
        port,
        uiDistPath,
      });
      process.exitCode = exitCode;
    },
  );

program
  .command("app")
  .description("Run full rem app (API + bundled UI) and open the browser")
  .option("--host <host>", "API host", defaultApiHost)
  .option("--port <number>", "API port", String(defaultApiPort))
  .option("--ui-dist <path>", "Path to built UI dist directory")
  .option("--api-binary <path>", "Path to rem-api binary")
  .option("--no-open", "Do not open browser automatically")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      host: string;
      port: string;
      uiDist?: string;
      apiBinary?: string;
      open: boolean;
      json?: boolean;
    }) => {
      const port = parsePortOption(options, options.port);
      if (port === null) {
        return;
      }

      const uiDistPath = await resolveUiDistPath(options.uiDist);
      if (!uiDistPath) {
        emitError(
          options,
          "ui_dist_missing",
          "Unable to locate UI dist. Build it with `bun run --cwd apps/ui build` or pass --ui-dist.",
        );
        return;
      }

      const apiBinaryPath = await resolveApiBinaryPath(options.apiBinary);
      if (!apiBinaryPath) {
        emitError(
          options,
          "api_binary_missing",
          "Unable to find rem-api binary. Pass --api-binary or set REM_API_BINARY.",
        );
        return;
      }

      const baseUrl = `http://${options.host}:${port}`;
      process.stdout.write(`starting rem app at ${baseUrl}\n`);

      const env = {
        ...process.env,
        REM_API_HOST: options.host,
        REM_API_PORT: String(port),
        REM_UI_DIST: uiDistPath,
      };

      const apiProcess = Bun.spawn([apiBinaryPath], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
      });

      const handleInterrupt = () => {
        apiProcess.kill();
      };

      process.on("SIGINT", handleInterrupt);
      process.on("SIGTERM", handleInterrupt);

      const ready = await waitForHttpReady(`${baseUrl}/status`, appStartupTimeoutMs);
      if (!ready) {
        apiProcess.kill();
        process.off("SIGINT", handleInterrupt);
        process.off("SIGTERM", handleInterrupt);
        emitError(
          options,
          "app_start_timeout",
          `Timed out waiting for API at ${baseUrl} after ${appStartupTimeoutMs}ms`,
        );
        return;
      }

      if (options.open) {
        try {
          await openInDefaultBrowser(baseUrl);
        } catch {
          process.stderr.write(`warning: unable to open browser automatically at ${baseUrl}\n`);
        }
      }

      const exitCode = await apiProcess.exited;
      process.off("SIGINT", handleInterrupt);
      process.off("SIGTERM", handleInterrupt);
      process.exitCode = exitCode;
    },
  );

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
