#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command } from "commander";

import {
  discoverPluginRuntimeAssets,
  evaluatePluginPermissionGate,
  loadPluginRuntimeModule,
  mapPluginActionError,
  resolvePluginRoot,
  resolveTrustedRoots,
  runPluginActionWithGuards,
} from "@rem/plugins";
import { pluginManifestInputSchema } from "@rem/schemas";
import type { Actor } from "@rem/schemas";

import {
  type NoteFormat,
  acceptProposalViaCore,
  applyPluginTemplateViaCore,
  createPluginEntityViaCore,
  createProposalViaCore,
  disablePluginViaCore,
  enablePluginViaCore,
  getCoreStatus,
  getCoreStoreRootConfigViaCore,
  getNoteViaCore,
  getPluginEntityViaCore,
  getPluginSchedulerStatusViaCore,
  getPluginViaCore,
  getProposalViaCore,
  installPluginViaCore,
  listEventsViaCore,
  listPluginEntitiesViaCore,
  listPluginTemplatesViaCore,
  listPluginsViaCore,
  listProposalsViaCore,
  listSectionsViaCore,
  migrateSectionIdentityViaCore,
  rebuildIndexViaCore,
  recordPluginActionEventViaCore,
  registerPluginViaCore,
  rejectProposalViaCore,
  runPluginSchedulerViaCore,
  saveNoteViaCore,
  searchNotesViaCore,
  uninstallPluginViaCore,
  updatePluginEntityViaCore,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return strings.length > 0 ? strings : undefined;
}

async function parseJsonInput(rawInput: string | undefined, context: string): Promise<unknown> {
  if (!rawInput) {
    return undefined;
  }

  const inputPath = path.resolve(rawInput);
  if (await Bun.file(inputPath).exists()) {
    return JSON.parse(await Bun.file(inputPath).text());
  }

  try {
    return JSON.parse(rawInput);
  } catch (error) {
    throw new Error(`${context} must be valid JSON or a JSON file path: ${rawInput}`, {
      cause: error,
    });
  }
}

async function parsePluginActionInput(rawInput?: string): Promise<unknown> {
  return parseJsonInput(rawInput, "Plugin action input");
}

function buildPluginCoreBridge(
  actor: Actor,
  sourcePlugin: string,
): {
  saveNote: (input: unknown) => Promise<unknown>;
  searchNotes: (query: string, filters?: Record<string, unknown>) => Promise<unknown>;
  createProposal: (input: unknown) => Promise<unknown>;
  listEvents: (input?: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    saveNote: async (input: unknown): Promise<unknown> => {
      if (!isPlainObject(input)) {
        throw new Error("core.saveNote payload must be an object");
      }

      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        throw new Error("core.saveNote payload must include a title");
      }

      const overrideReason =
        typeof input.overrideReason === "string" && input.overrideReason.trim().length > 0
          ? input.overrideReason.trim()
          : undefined;
      const approvedBy =
        typeof input.approvedBy === "string" && input.approvedBy.trim().length > 0
          ? input.approvedBy.trim()
          : undefined;
      if (actor.kind === "agent" && !overrideReason) {
        throw new Error(
          "Agent plugin note writes must use core.createProposal unless overrideReason is provided",
        );
      }

      return saveNoteViaCore({
        id: typeof input.id === "string" ? input.id : undefined,
        title: input.title,
        noteType: typeof input.noteType === "string" ? input.noteType : undefined,
        lexicalState: input.lexicalState,
        tags: parseOptionalStringArray(input.tags),
        plugins: isPlainObject(input.plugins)
          ? (input.plugins as Record<string, unknown>)
          : undefined,
        actor,
        overrideReason,
        approvedBy,
        sourcePlugin,
      });
    },
    searchNotes: async (query: string, filters?: Record<string, unknown>): Promise<unknown> => {
      return searchNotesViaCore(query, filters as Parameters<typeof searchNotesViaCore>[1]);
    },
    createProposal: async (input: unknown): Promise<unknown> => {
      if (!isPlainObject(input)) {
        throw new Error("core.createProposal payload must be an object");
      }

      return createProposalViaCore({
        ...(input as Omit<Parameters<typeof createProposalViaCore>[0], "actor">),
        actor,
      });
    },
    listEvents: async (input?: Record<string, unknown>): Promise<unknown> => {
      return listEventsViaCore(input as Parameters<typeof listEventsViaCore>[0]);
    },
  };
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

async function resolveStoreRootForApiProcess(): Promise<string> {
  const fromEnv = process.env.REM_STORE_ROOT?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const config = await getCoreStoreRootConfigViaCore();
  return config.configuredStoreRoot ?? config.defaultStoreRoot;
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
  const storeRoot = await resolveStoreRootForApiProcess();
  const env: Record<string, string | undefined> = {
    ...process.env,
    REM_API_HOST: options.host,
    REM_API_PORT: String(options.port),
    REM_STORE_ROOT: storeRoot,
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
  .command("install")
  .description("Register a plugin manifest and mark it installed")
  .requiredOption("--manifest <path>", "Path to plugin manifest JSON")
  .option("--plugin-path <path>", "Optional local plugin runtime path (reserved for host runtime)")
  .option("--registration-kind <kind>", "Registration kind: static|dynamic", "dynamic")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "cli-plugin-admin")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      manifest: string;
      pluginPath?: string;
      registrationKind: "static" | "dynamic";
      actorKind: "human" | "agent";
      actorId: string;
      json?: boolean;
    }) => {
      try {
        const manifest = pluginManifestInputSchema.parse(
          JSON.parse(await Bun.file(options.manifest).text()),
        );
        const actor = {
          kind: options.actorKind,
          id: options.actorId || undefined,
        } as const;

        const registerResult = await registerPluginViaCore({
          manifest,
          registrationKind: options.registrationKind,
          actor,
        });
        const installResult = await installPluginViaCore({
          namespace: registerResult.namespace,
          actor,
        });

        const payload = {
          namespace: registerResult.namespace,
          created: registerResult.created,
          state: installResult.state,
          eventId: installResult.eventId,
          pluginPath: options.pluginPath ?? null,
        };

        if (options.json) {
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return;
        }

        process.stdout.write(`installed plugin ${payload.namespace} state=${payload.state}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to install plugin";
        emitError(options, "plugin_install_failed", message);
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
          [key: string]: unknown;
        };

        const result = await registerPluginViaCore({
          manifest: pluginManifestInputSchema.parse(manifest),
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
  .command("inspect")
  .description("Get plugin manifest and lifecycle metadata by namespace")
  .argument("<namespace>", "Plugin namespace")
  .option("--json", "Emit JSON output")
  .action(async (namespace: string, options: { json?: boolean }) => {
    try {
      const plugin = await getPluginViaCore(namespace);
      if (!plugin) {
        emitError(options, "plugin_not_found", `Plugin not found: ${namespace}`);
        return;
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify(plugin)}\n`);
        return;
      }

      process.stdout.write(
        `${plugin.manifest.namespace} ${plugin.manifest.schemaVersion} state=${plugin.meta.lifecycleState}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to inspect plugin";
      emitError(options, "plugin_inspect_failed", message);
    }
  });

pluginCommand
  .command("run")
  .description("Invoke a plugin CLI action")
  .argument("<namespace>", "Plugin namespace")
  .argument("<action-id>", "CLI action id")
  .option("--input <json-or-path>", "Inline JSON payload or path to a JSON file")
  .option("--plugin-path <path>", "Optional explicit plugin runtime path")
  .option("--trusted-roots <paths>", "Comma-separated trusted plugin roots")
  .option("--request-id <id>", "Optional request id override")
  .option("--timeout-ms <number>", "Action timeout in milliseconds", "15000")
  .option("--max-input-bytes <number>", "Max JSON input payload size in bytes", "65536")
  .option("--max-output-bytes <number>", "Max JSON output payload size in bytes", "262144")
  .option("--max-concurrency <number>", "Max concurrent invocations per plugin", "1")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "cli-plugin-runner")
  .option("--json", "Emit JSON output")
  .action(
    async (
      namespace: string,
      actionId: string,
      options: {
        input?: string;
        pluginPath?: string;
        trustedRoots?: string;
        requestId?: string;
        timeoutMs: string;
        maxInputBytes: string;
        maxOutputBytes: string;
        maxConcurrency: string;
        actorKind: "human" | "agent";
        actorId: string;
        json?: boolean;
      },
    ) => {
      let actor: Actor | undefined;
      let requestId: string | undefined;
      let invocationStartedAtMs: number | undefined;

      try {
        const plugin = await getPluginViaCore(namespace);
        if (!plugin) {
          emitError(options, "plugin_not_found", `Plugin not found: ${namespace}`);
          return;
        }

        if (plugin.meta.lifecycleState !== "enabled") {
          emitError(
            options,
            "plugin_not_enabled",
            `Plugin ${namespace} must be enabled to run actions`,
          );
          return;
        }

        const declaredAction = plugin.manifest.cli?.actions.find(
          (action) => action.id === actionId,
        );
        if (!declaredAction) {
          emitError(
            options,
            "plugin_action_not_declared",
            `Action not declared in plugin manifest: ${namespace}/${actionId}`,
          );
          return;
        }

        const grantedPermissions = plugin.manifest.permissions ?? [];
        const permissionGate = evaluatePluginPermissionGate({
          grantedPermissions,
          requiredPermissions: declaredAction.requiredPermissions ?? [],
        });
        if (!permissionGate.allowed) {
          emitError(
            options,
            "plugin_permission_denied",
            `Action ${namespace}/${actionId} requires missing permissions: ${permissionGate.missingPermissions.join(", ")}`,
          );
          return;
        }

        const configuredRoots = [
          ...(parseListOption(options.trustedRoots) ?? []),
          ...(options.pluginPath ? [options.pluginPath] : []),
        ];
        const trustedRoots = resolveTrustedRoots({
          configuredRoots,
        });
        const pluginRoot = await resolvePluginRoot({
          namespace,
          trustedRoots,
          pluginPath: options.pluginPath,
        });
        const runtimeAssets = await discoverPluginRuntimeAssets({
          pluginRoot,
          trustedRoots,
          manifest: plugin.manifest,
        });
        if (!runtimeAssets.cliEntrypoint) {
          emitError(
            options,
            "plugin_entrypoint_missing",
            `No CLI entrypoint available for plugin ${namespace}`,
          );
          return;
        }

        const runtimeModule = await loadPluginRuntimeModule(
          runtimeAssets.cliEntrypoint.absolutePath,
        );
        const runtimeAction = runtimeModule.cli?.actions[actionId];
        if (!runtimeAction) {
          emitError(
            options,
            "plugin_action_not_found",
            `Action not found in runtime module: ${namespace}/${actionId}`,
          );
          return;
        }

        const invocationActor: Actor = {
          kind: options.actorKind,
          id: options.actorId || undefined,
        };
        actor = invocationActor;
        const invocationRequestId = options.requestId ?? randomUUID();
        requestId = invocationRequestId;
        invocationStartedAtMs = Date.now();
        const inputPayload = await parsePluginActionInput(options.input);
        const timeoutMs = Number.parseInt(options.timeoutMs, 10);
        const maxInputBytes = Number.parseInt(options.maxInputBytes, 10);
        const maxOutputBytes = Number.parseInt(options.maxOutputBytes, 10);
        const maxConcurrency = Number.parseInt(options.maxConcurrency, 10);
        const guardedExecution = await runPluginActionWithGuards({
          namespace,
          actionId,
          input: inputPayload,
          policy: {
            timeoutMs,
            maxInputBytes,
            maxOutputBytes,
            maxConcurrentInvocationsPerPlugin: maxConcurrency,
          },
          invoke: async () =>
            runtimeAction(inputPayload, {
              plugin: {
                namespace: plugin.manifest.namespace,
                schemaVersion: plugin.manifest.schemaVersion,
              },
              invocation: {
                actorKind: invocationActor.kind,
                actorId: invocationActor.id,
                host: "cli",
                requestId: invocationRequestId,
              },
              permissions: new Set(grantedPermissions),
              core: buildPluginCoreBridge(invocationActor, namespace),
              log: ({ level, message, data }) => {
                process.stderr.write(
                  `[plugin:${namespace}:${actionId}] ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`,
                );
              },
            }),
        });
        const actionEvent = await recordPluginActionEventViaCore({
          namespace,
          actionId,
          requestId: invocationRequestId,
          actor: invocationActor,
          host: "cli",
          status: "success",
          durationMs: guardedExecution.durationMs,
          inputBytes: guardedExecution.inputBytes,
          outputBytes: guardedExecution.outputBytes,
        });

        const payload = {
          namespace,
          actionId,
          requestId: invocationRequestId,
          eventId: actionEvent.eventId,
          actor: invocationActor,
          durationMs: guardedExecution.durationMs,
          inputBytes: guardedExecution.inputBytes,
          outputBytes: guardedExecution.outputBytes,
          result: guardedExecution.result,
        };

        if (options.json) {
          process.stdout.write(`${JSON.stringify(payload)}\n`);
          return;
        }

        process.stdout.write(
          `ran ${namespace}/${actionId} requestId=${invocationRequestId} durationMs=${guardedExecution.durationMs}\n`,
        );
      } catch (error) {
        const mapped = mapPluginActionError(error, "Failed to run plugin action");
        if (actor && requestId) {
          const durationMs = invocationStartedAtMs
            ? Math.max(0, Date.now() - invocationStartedAtMs)
            : 0;
          await recordPluginActionEventViaCore({
            namespace,
            actionId,
            requestId,
            actor,
            host: "cli",
            status: "failure",
            durationMs,
            errorCode: mapped.code,
            errorMessage: mapped.message,
          }).catch(() => undefined);
        }

        emitError(options, mapped.code, mapped.message);
        return;
      }
    },
  );

pluginCommand
  .command("enable")
  .description("Enable a registered plugin")
  .argument("<namespace>", "Plugin namespace")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "cli-plugin-admin")
  .option("--json", "Emit JSON output")
  .action(
    async (
      namespace: string,
      options: {
        actorKind: "human" | "agent";
        actorId: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await enablePluginViaCore({
          namespace,
          actor: {
            kind: options.actorKind,
            id: options.actorId || undefined,
          },
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }

        process.stdout.write(`enabled plugin ${result.namespace}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to enable plugin";
        emitError(options, "plugin_enable_failed", message);
      }
    },
  );

pluginCommand
  .command("disable")
  .description("Disable a registered plugin")
  .argument("<namespace>", "Plugin namespace")
  .option("--reason <reason>", "Disable reason", "manual_disable")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "cli-plugin-admin")
  .option("--json", "Emit JSON output")
  .action(
    async (
      namespace: string,
      options: {
        reason: string;
        actorKind: "human" | "agent";
        actorId: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await disablePluginViaCore({
          namespace,
          disableReason: options.reason,
          actor: {
            kind: options.actorKind,
            id: options.actorId || undefined,
          },
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }

        process.stdout.write(`disabled plugin ${result.namespace}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to disable plugin";
        emitError(options, "plugin_disable_failed", message);
      }
    },
  );

pluginCommand
  .command("uninstall")
  .description("Mark a plugin as uninstalled")
  .argument("<namespace>", "Plugin namespace")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "cli-plugin-admin")
  .option("--json", "Emit JSON output")
  .action(
    async (
      namespace: string,
      options: {
        actorKind: "human" | "agent";
        actorId: string;
        json?: boolean;
      },
    ) => {
      try {
        const result = await uninstallPluginViaCore({
          namespace,
          actor: {
            kind: options.actorKind,
            id: options.actorId || undefined,
          },
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }

        process.stdout.write(`uninstalled plugin ${result.namespace}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to uninstall plugin";
        emitError(options, "plugin_uninstall_failed", message);
      }
    },
  );

const pluginTemplateCommand = pluginCommand
  .command("templates")
  .description("Plugin template discovery and application");

pluginTemplateCommand
  .command("list")
  .description("List declarative templates exposed by installed/enabled plugins")
  .option("--namespace <namespace>", "Filter by plugin namespace")
  .option(
    "--include-unavailable",
    "Include templates from plugins that are not currently available",
  )
  .option("--json", "Emit JSON output")
  .action(async (options: { namespace?: string; includeUnavailable?: boolean; json?: boolean }) => {
    try {
      const templates = await listPluginTemplatesViaCore({
        namespace: options.namespace,
        includeUnavailable: options.includeUnavailable,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify(templates)}\n`);
        return;
      }

      for (const entry of templates) {
        process.stdout.write(
          `${entry.namespace}/${entry.template.id} ${entry.template.title} state=${entry.lifecycleState} available=${entry.available}\n`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to list plugin templates";
      emitError(options, "plugin_template_list_failed", message);
    }
  });

pluginTemplateCommand
  .command("apply")
  .description("Create a note from a plugin-declared template")
  .requiredOption("--namespace <namespace>", "Plugin namespace")
  .requiredOption("--template <id>", "Template id")
  .option("--title <title>", "Optional note title override")
  .option("--note-type <type>", "Optional note type override")
  .option("--tags <tags>", "Comma-separated tags to merge with template defaults")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "cli-template-admin")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      namespace: string;
      template: string;
      title?: string;
      noteType?: string;
      tags?: string;
      actorKind: "human" | "agent";
      actorId: string;
      json?: boolean;
    }) => {
      try {
        const result = await applyPluginTemplateViaCore({
          namespace: options.namespace,
          templateId: options.template,
          title: options.title,
          noteType: options.noteType,
          tags: parseListOption(options.tags),
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
          `created note ${result.noteId} from template ${result.namespace}/${result.templateId}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to apply plugin template";
        emitError(options, "plugin_template_apply_failed", message);
      }
    },
  );

const pluginSchedulerCommand = pluginCommand
  .command("scheduler")
  .description("Scheduler runtime inspection and execution");

pluginSchedulerCommand
  .command("run")
  .description("Execute due scheduled plugin tasks once for the current tick")
  .option("--now <iso>", "Optional scheduler evaluation time (ISO-8601)")
  .option("--namespaces <namespaces>", "Comma-separated plugin namespace filter")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "agent")
  .option("--actor-id <id>", "Actor id", "cli-scheduler")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      now?: string;
      namespaces?: string;
      actorKind: "human" | "agent";
      actorId: string;
      json?: boolean;
    }) => {
      try {
        const result = await runPluginSchedulerViaCore({
          now: options.now,
          namespaces: parseListOption(options.namespaces),
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
          `scheduler ran due=${result.dueRuns} executed=${result.executedRuns.length} failed=${result.failedRuns.length} duplicates=${result.skippedAsDuplicate}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to run plugin scheduler";
        emitError(options, "plugin_scheduler_run_failed", message);
      }
    },
  );

pluginSchedulerCommand
  .command("status")
  .description("Inspect scheduler ledger and recent task runs")
  .option("--namespace <namespace>", "Optional plugin namespace filter")
  .option("--limit <number>", "Recent run limit", "20")
  .option("--json", "Emit JSON output")
  .action(async (options: { namespace?: string; limit: string; json?: boolean }) => {
    try {
      const limit = Number.parseInt(options.limit, 10);
      const status = await getPluginSchedulerStatusViaCore({
        namespace: options.namespace,
        limit: Number.isNaN(limit) ? 20 : limit,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify(status)}\n`);
        return;
      }

      process.stdout.write(
        `ledgerEntries=${status.ledgerEntries} taskSummaries=${status.taskSummaries.length} recentRuns=${status.recentRuns.length} updatedAt=${status.updatedAt ?? "none"}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to inspect scheduler status";
      emitError(options, "plugin_scheduler_status_failed", message);
    }
  });

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

const entitiesCommand = program.command("entities").description("Plugin entity commands");

entitiesCommand
  .command("save")
  .description("Create or update a plugin-defined entity")
  .requiredOption("--namespace <namespace>", "Plugin namespace")
  .requiredOption("--type <entityType>", "Entity type id")
  .requiredOption("--input <input>", "Entity payload JSON or JSON file path")
  .option("--id <id>", "Entity id")
  .option("--schema-version <version>", "Optional schema version override")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "entity-admin")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      namespace: string;
      type: string;
      input: string;
      id?: string;
      schemaVersion?: string;
      actorKind: string;
      actorId: string;
      json?: boolean;
    }) => {
      try {
        if (options.actorKind !== "human" && options.actorKind !== "agent") {
          emitError(options, "invalid_actor_kind", `Invalid actor kind: ${options.actorKind}`);
          return;
        }

        const rawInput = await parseJsonInput(options.input, "Entity input");
        if (!isPlainObject(rawInput)) {
          emitError(options, "invalid_entity_input", "Entity input must be a JSON object");
          return;
        }

        const payload = rawInput as Record<string, unknown>;
        const candidateData = payload.data;
        const data = isPlainObject(candidateData) ? candidateData : payload;
        if (!isPlainObject(data)) {
          emitError(options, "invalid_entity_input", "Entity data must be a JSON object");
          return;
        }

        const entityIdFromPayload = typeof payload.id === "string" ? payload.id.trim() : undefined;
        const entityId = options.id?.trim() || entityIdFromPayload;
        const schemaVersionInput =
          options.schemaVersion?.trim() ||
          (typeof payload.schemaVersion === "string" ? payload.schemaVersion.trim() : undefined);
        const actor: Actor =
          options.actorKind === "agent"
            ? { kind: "agent", id: options.actorId.trim() }
            : { kind: "human", id: options.actorId.trim() };

        const links = Array.isArray(payload.links) ? payload.links : undefined;
        let mode: "created" | "updated" = "created";
        let record: Awaited<ReturnType<typeof createPluginEntityViaCore>>;
        if (entityId) {
          const existing = await getPluginEntityViaCore({
            namespace: options.namespace,
            entityType: options.type,
            id: entityId,
          });
          if (existing) {
            mode = "updated";
            record = await updatePluginEntityViaCore({
              namespace: options.namespace,
              entityType: options.type,
              id: entityId,
              schemaVersion: schemaVersionInput,
              data,
              links,
              actor,
            });
          } else {
            record = await createPluginEntityViaCore({
              namespace: options.namespace,
              entityType: options.type,
              id: entityId,
              schemaVersion: schemaVersionInput,
              data,
              links,
              actor,
            });
          }
        } else {
          record = await createPluginEntityViaCore({
            namespace: options.namespace,
            entityType: options.type,
            id: entityId,
            schemaVersion: schemaVersionInput,
            data,
            links,
            actor,
          });
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify({ mode, ...record })}\n`);
          return;
        }

        process.stdout.write(
          `${mode} entity ${record.entity.namespace}/${record.entity.entityType}/${record.entity.id} schema=${record.entity.schemaVersion} compatibility=${record.compatibility.mode}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to save entity";
        emitError(options, "entity_save_failed", message);
      }
    },
  );

entitiesCommand
  .command("get")
  .description("Get a plugin-defined entity by namespace/type/id")
  .requiredOption("--namespace <namespace>", "Plugin namespace")
  .requiredOption("--type <entityType>", "Entity type id")
  .requiredOption("--id <id>", "Entity id")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      namespace: string;
      type: string;
      id: string;
      json?: boolean;
    }) => {
      try {
        const entity = await getPluginEntityViaCore({
          namespace: options.namespace,
          entityType: options.type,
          id: options.id,
        });
        if (!entity) {
          emitError(
            options,
            "entity_not_found",
            `Entity not found: ${options.namespace}/${options.type}/${options.id}`,
          );
          return;
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify(entity)}\n`);
          return;
        }

        process.stdout.write(
          `${entity.entity.namespace}/${entity.entity.entityType}/${entity.entity.id} schema=${entity.entity.schemaVersion} compatibility=${entity.compatibility.mode}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to get entity";
        emitError(options, "entity_get_failed", message);
      }
    },
  );

entitiesCommand
  .command("list")
  .description("List plugin-defined entities")
  .requiredOption("--namespace <namespace>", "Plugin namespace")
  .requiredOption("--type <entityType>", "Entity type id")
  .option("--schema-version <version>", "Optional schema version filter")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      namespace: string;
      type: string;
      schemaVersion?: string;
      json?: boolean;
    }) => {
      try {
        const entities = await listPluginEntitiesViaCore({
          namespace: options.namespace,
          entityType: options.type,
          schemaVersion: options.schemaVersion,
        });

        if (options.json) {
          process.stdout.write(`${JSON.stringify(entities)}\n`);
          return;
        }

        for (const entry of entities) {
          process.stdout.write(
            `${entry.entity.id} schema=${entry.entity.schemaVersion} compatibility=${entry.compatibility.mode}\n`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to list entities";
        emitError(options, "entity_list_failed", message);
      }
    },
  );

entitiesCommand
  .command("migrate")
  .description("Run deterministic plugin entity schema migrations via a plugin action")
  .requiredOption("--namespace <namespace>", "Plugin namespace")
  .requiredOption("--type <entityType>", "Entity type id")
  .requiredOption("--action <actionId>", "Plugin CLI action to transform entity payloads")
  .option(
    "--from-schema-version <version>",
    "Only migrate entities currently at this schemaVersion",
  )
  .option(
    "--target-schema-version <version>",
    "Target schemaVersion (defaults to manifest schemaVersion)",
  )
  .option("--dry-run", "Plan migration without mutating entities")
  .option("--plugin-path <path>", "Optional explicit plugin runtime path")
  .option("--trusted-roots <paths>", "Comma-separated trusted plugin roots")
  .option("--request-id <id>", "Optional request id prefix for migration action invocations")
  .option("--timeout-ms <number>", "Action timeout in milliseconds", "15000")
  .option("--max-input-bytes <number>", "Max JSON input payload size in bytes", "65536")
  .option("--max-output-bytes <number>", "Max JSON output payload size in bytes", "262144")
  .option("--max-concurrency <number>", "Max concurrent invocations per plugin", "1")
  .option("--actor-kind <kind>", "Actor kind: human|agent", "human")
  .option("--actor-id <id>", "Actor id", "entity-migrator")
  .option("--json", "Emit JSON output")
  .action(
    async (options: {
      namespace: string;
      type: string;
      action: string;
      fromSchemaVersion?: string;
      targetSchemaVersion?: string;
      dryRun?: boolean;
      pluginPath?: string;
      trustedRoots?: string;
      requestId?: string;
      timeoutMs: string;
      maxInputBytes: string;
      maxOutputBytes: string;
      maxConcurrency: string;
      actorKind: "human" | "agent";
      actorId: string;
      json?: boolean;
    }) => {
      try {
        if (options.actorKind !== "human" && options.actorKind !== "agent") {
          emitError(options, "invalid_actor_kind", `Invalid actor kind: ${options.actorKind}`);
          return;
        }

        const plugin = await getPluginViaCore(options.namespace);
        if (!plugin) {
          emitError(options, "plugin_not_found", `Plugin not found: ${options.namespace}`);
          return;
        }

        const targetSchemaVersion =
          options.targetSchemaVersion?.trim() || plugin.manifest.schemaVersion;
        if (targetSchemaVersion !== plugin.manifest.schemaVersion) {
          emitError(
            options,
            "invalid_target_schema_version",
            `Target schemaVersion must match manifest schemaVersion ${plugin.manifest.schemaVersion}`,
          );
          return;
        }

        const fromSchemaVersion = options.fromSchemaVersion?.trim() || undefined;
        const entities = await listPluginEntitiesViaCore({
          namespace: options.namespace,
          entityType: options.type,
        });
        const candidates = [...entities]
          .filter((entry) => {
            if (fromSchemaVersion) {
              return entry.entity.schemaVersion === fromSchemaVersion;
            }
            return entry.entity.schemaVersion !== targetSchemaVersion;
          })
          .sort((left, right) => left.entity.id.localeCompare(right.entity.id));

        const migrationSummary = {
          namespace: options.namespace,
          entityType: options.type,
          actionId: options.action,
          deterministicOrder: "entity.id:asc",
          fromSchemaVersion: fromSchemaVersion ?? null,
          targetSchemaVersion,
          dryRun: Boolean(options.dryRun),
          scanned: entities.length,
          eligible: candidates.length,
          migrated: 0,
          skipped: entities.length - candidates.length,
          failed: 0,
          results: candidates.map((entry) => ({
            id: entry.entity.id,
            fromSchemaVersion: entry.entity.schemaVersion,
            targetSchemaVersion,
            status: "planned" as "planned" | "migrated" | "failed",
            error: undefined as string | undefined,
          })),
        };

        if (options.dryRun || candidates.length === 0) {
          if (options.json) {
            process.stdout.write(`${JSON.stringify(migrationSummary)}\n`);
            return;
          }

          process.stdout.write(
            `planned migration ${options.namespace}/${options.type} eligible=${migrationSummary.eligible} scanned=${migrationSummary.scanned}\n`,
          );
          return;
        }

        if (plugin.meta.lifecycleState !== "enabled") {
          emitError(
            options,
            "plugin_not_enabled",
            `Plugin ${options.namespace} must be enabled to run migration actions`,
          );
          return;
        }

        const declaredAction = plugin.manifest.cli?.actions.find(
          (action) => action.id === options.action,
        );
        if (!declaredAction) {
          emitError(
            options,
            "plugin_action_not_declared",
            `Action not declared in plugin manifest: ${options.namespace}/${options.action}`,
          );
          return;
        }

        const grantedPermissions = plugin.manifest.permissions ?? [];
        const permissionGate = evaluatePluginPermissionGate({
          grantedPermissions,
          requiredPermissions: declaredAction.requiredPermissions ?? [],
        });
        if (!permissionGate.allowed) {
          emitError(
            options,
            "plugin_permission_denied",
            `Action ${options.namespace}/${options.action} requires missing permissions: ${permissionGate.missingPermissions.join(", ")}`,
          );
          return;
        }

        const configuredRoots = [
          ...(parseListOption(options.trustedRoots) ?? []),
          ...(options.pluginPath ? [options.pluginPath] : []),
        ];
        const trustedRoots = resolveTrustedRoots({
          configuredRoots,
        });
        const pluginRoot = await resolvePluginRoot({
          namespace: options.namespace,
          trustedRoots,
          pluginPath: options.pluginPath,
        });
        const runtimeAssets = await discoverPluginRuntimeAssets({
          pluginRoot,
          trustedRoots,
          manifest: plugin.manifest,
        });
        if (!runtimeAssets.cliEntrypoint) {
          emitError(
            options,
            "plugin_entrypoint_missing",
            `No CLI entrypoint available for plugin ${options.namespace}`,
          );
          return;
        }

        const runtimeModule = await loadPluginRuntimeModule(
          runtimeAssets.cliEntrypoint.absolutePath,
        );
        const runtimeAction = runtimeModule.cli?.actions[options.action];
        if (!runtimeAction) {
          emitError(
            options,
            "plugin_action_not_found",
            `Action not found in runtime module: ${options.namespace}/${options.action}`,
          );
          return;
        }

        const actor: Actor = {
          kind: options.actorKind,
          id: options.actorId || undefined,
        };
        const requestIdPrefix = options.requestId?.trim() || randomUUID();
        const timeoutMs = Number.parseInt(options.timeoutMs, 10);
        const maxInputBytes = Number.parseInt(options.maxInputBytes, 10);
        const maxOutputBytes = Number.parseInt(options.maxOutputBytes, 10);
        const maxConcurrency = Number.parseInt(options.maxConcurrency, 10);

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          if (!candidate) {
            continue;
          }

          const requestId = `${requestIdPrefix}:${candidate.entity.id}`;
          const startedAtMs = Date.now();

          try {
            const guardedExecution = await runPluginActionWithGuards({
              namespace: options.namespace,
              actionId: options.action,
              input: {
                entity: candidate.entity,
                meta: candidate.meta,
                compatibility: candidate.compatibility,
                fromSchemaVersion: candidate.entity.schemaVersion,
                targetSchemaVersion,
              },
              policy: {
                timeoutMs,
                maxInputBytes,
                maxOutputBytes,
                maxConcurrentInvocationsPerPlugin: maxConcurrency,
              },
              invoke: async () =>
                runtimeAction(
                  {
                    entity: candidate.entity,
                    meta: candidate.meta,
                    compatibility: candidate.compatibility,
                    fromSchemaVersion: candidate.entity.schemaVersion,
                    targetSchemaVersion,
                  },
                  {
                    plugin: {
                      namespace: plugin.manifest.namespace,
                      schemaVersion: plugin.manifest.schemaVersion,
                    },
                    invocation: {
                      actorKind: actor.kind,
                      actorId: actor.id,
                      host: "cli",
                      requestId,
                    },
                    permissions: new Set(grantedPermissions),
                    core: buildPluginCoreBridge(actor, options.namespace),
                    log: ({ level, message, data }) => {
                      process.stderr.write(
                        `[plugin:${options.namespace}:${options.action}:migrate:${candidate.entity.id}] ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ""}\n`,
                      );
                    },
                  },
                ),
            });

            await recordPluginActionEventViaCore({
              namespace: options.namespace,
              actionId: options.action,
              requestId,
              actor,
              host: "cli",
              status: "success",
              durationMs: guardedExecution.durationMs,
              inputBytes: guardedExecution.inputBytes,
              outputBytes: guardedExecution.outputBytes,
            });

            if (!isPlainObject(guardedExecution.result)) {
              throw new Error(
                `Migration action must return an object payload for entity ${candidate.entity.id}`,
              );
            }
            const migrationOutput = guardedExecution.result as Record<string, unknown>;
            if (!isPlainObject(migrationOutput.data)) {
              throw new Error(
                `Migration action output must include data object for entity ${candidate.entity.id}`,
              );
            }

            const migrated = await updatePluginEntityViaCore({
              namespace: options.namespace,
              entityType: options.type,
              id: candidate.entity.id,
              schemaVersion: targetSchemaVersion,
              data: migrationOutput.data as Record<string, unknown>,
              links: Array.isArray(migrationOutput.links)
                ? (migrationOutput.links as Parameters<
                    typeof updatePluginEntityViaCore
                  >[0]["links"])
                : candidate.meta.links,
              actor,
            });

            const result = migrationSummary.results[index];
            if (result) {
              result.status = "migrated";
              result.targetSchemaVersion = migrated.entity.schemaVersion;
            }
            migrationSummary.migrated += 1;
          } catch (error) {
            const mapped = mapPluginActionError(error, "Failed to run plugin migration action");
            await recordPluginActionEventViaCore({
              namespace: options.namespace,
              actionId: options.action,
              requestId,
              actor,
              host: "cli",
              status: "failure",
              durationMs: Math.max(0, Date.now() - startedAtMs),
              errorCode: mapped.code,
              errorMessage: mapped.message,
            }).catch(() => undefined);

            const result = migrationSummary.results[index];
            if (result) {
              result.status = "failed";
              result.error = mapped.message;
            }
            migrationSummary.failed += 1;
          }
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify(migrationSummary)}\n`);
          return;
        }

        process.stdout.write(
          `migrated entities ${options.namespace}/${options.type} migrated=${migrationSummary.migrated} failed=${migrationSummary.failed} eligible=${migrationSummary.eligible}\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to migrate entities";
        emitError(options, "entity_migration_failed", message);
      }
    },
  );

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
      const storeRoot = await resolveStoreRootForApiProcess();

      const env = {
        ...process.env,
        REM_API_HOST: options.host,
        REM_API_PORT: String(port),
        REM_UI_DIST: uiDistPath,
        REM_STORE_ROOT: storeRoot,
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
