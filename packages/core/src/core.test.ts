import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type { PluginManifestInput, RemEvent } from "@rem/schemas";

import {
  RemCore,
  getCoreStatus,
  getCoreStoreRootConfigViaCore,
  setCoreStoreRootConfigViaCore,
} from "./index";

function lexicalStateWithText(text: string): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text,
            },
          ],
        },
      ],
    },
  };
}

function lexicalStateWithHeadingAndParagraph(heading: string, text: string): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "heading",
          tag: "h2",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: heading,
            },
          ],
        },
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text,
            },
          ],
        },
      ],
    },
  };
}

function lexicalStateWithSectionStructure(): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Preface",
            },
          ],
        },
        {
          type: "heading",
          tag: "h1",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Plan",
            },
          ],
        },
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Plan details",
            },
          ],
        },
        {
          type: "heading",
          tag: "h2",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Milestones",
            },
          ],
        },
      ],
    },
  };
}

function lexicalStateWithRenamedSectionStructure(): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Preface",
            },
          ],
        },
        {
          type: "heading",
          tag: "h2",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Plan Updated",
            },
          ],
        },
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Plan details",
            },
          ],
        },
        {
          type: "heading",
          tag: "h3",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Milestones",
            },
          ],
        },
      ],
    },
  };
}

function lexicalStateWithInsertedSectionStructure(): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Preface",
            },
          ],
        },
        {
          type: "heading",
          tag: "h1",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Plan",
            },
          ],
        },
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Plan details",
            },
          ],
        },
        {
          type: "heading",
          tag: "h2",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "New Section",
            },
          ],
        },
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Brand new details",
            },
          ],
        },
        {
          type: "heading",
          tag: "h2",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: "Milestones",
            },
          ],
        },
      ],
    },
  };
}

function tasksPluginManifest(): PluginManifestInput {
  return {
    namespace: "tasks",
    schemaVersion: "v1",
    payloadSchema: {
      type: "object" as const,
      required: ["board"],
      properties: {
        board: {
          type: "string" as const,
        },
        done: {
          type: "boolean" as const,
        },
      },
      additionalProperties: false,
    },
  };
}

function tasksPluginManifestV2(input?: {
  namespace?: string;
  permissions?: Array<"notes.read" | "notes.write">;
}): PluginManifestInput {
  return {
    manifestVersion: "v2" as const,
    namespace: input?.namespace ?? "tasks-v2",
    schemaVersion: "v2",
    remVersionRange: ">=0.1.0",
    capabilities: ["templates"],
    permissions: input?.permissions ?? ["notes.read", "notes.write"],
    notePayloadSchema: {
      type: "object" as const,
      required: ["board"],
      properties: {
        board: {
          type: "string" as const,
        },
        done: {
          type: "boolean" as const,
        },
      },
      additionalProperties: false,
    },
    templates: [
      {
        id: "daily",
        title: "Daily",
        defaultNoteType: "task",
        defaultTags: ["daily", "template"],
        lexicalTemplate: lexicalStateWithText("daily template"),
      },
    ],
  };
}

function scheduledTaskPluginManifest(input: {
  namespace: string;
  schedule: {
    kind: "daily" | "weekly" | "hourly";
    hour?: number;
    minute?: number;
    weekday?: "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
    timezone?: string;
  };
  runWindowMinutes?: number;
  idempotencyKey?: "calendar_slot" | "action_input_hash";
}): PluginManifestInput {
  return {
    manifestVersion: "v2" as const,
    namespace: input.namespace,
    schemaVersion: "v2",
    remVersionRange: ">=0.1.0",
    capabilities: ["cli_actions", "scheduled_tasks"],
    permissions: ["notes.read"],
    notePayloadSchema: {
      type: "object" as const,
      required: [],
      properties: {},
      additionalProperties: true,
    },
    cli: {
      actions: [
        {
          id: "create_note",
          title: "Create note",
        },
      ],
    },
    scheduledTasks: [
      {
        id: "daily-note",
        title: "Create daily note",
        actionId: "create_note",
        idempotencyKey: input.idempotencyKey ?? "calendar_slot",
        runWindowMinutes: input.runWindowMinutes,
        schedule: input.schedule,
      },
    ],
  };
}

function peopleEntityPluginManifest(input?: {
  namespace?: string;
  schemaVersion?: string;
  requiredField?: "name" | "fullName";
  textFields?: string[];
}): PluginManifestInput {
  const requiredField = input?.requiredField ?? "name";

  return {
    manifestVersion: "v2" as const,
    namespace: input?.namespace ?? "people-core",
    schemaVersion: input?.schemaVersion ?? "v1",
    remVersionRange: ">=0.1.0",
    capabilities: ["entities"],
    permissions: ["entities.read", "entities.write"],
    notePayloadSchema: {
      type: "object" as const,
      required: [],
      properties: {},
      additionalProperties: true,
    },
    entityTypes: [
      {
        id: "person",
        title: "Person",
        schema: {
          type: "object" as const,
          required: [requiredField],
          properties:
            requiredField === "name"
              ? {
                  name: { type: "string" as const },
                  summary: { type: "string" as const },
                }
              : {
                  fullName: { type: "string" as const },
                  summary: { type: "string" as const },
                },
          additionalProperties: false,
        },
        indexes: input?.textFields
          ? {
              textFields: input.textFields,
            }
          : undefined,
      },
    ],
  };
}

async function readCanonicalEvents(storeRoot: string): Promise<RemEvent[]> {
  const eventsDir = path.join(storeRoot, "events");
  const monthEntries = await readdir(eventsDir, { withFileTypes: true });
  const events: RemEvent[] = [];

  for (const monthEntry of monthEntries) {
    if (!monthEntry.isDirectory()) {
      continue;
    }

    const monthDir = path.join(eventsDir, monthEntry.name);
    const dayEntries = await readdir(monthDir, { withFileTypes: true });

    for (const dayEntry of dayEntries) {
      if (!dayEntry.isFile() || !dayEntry.name.endsWith(".jsonl")) {
        continue;
      }

      const eventPath = path.join(monthDir, dayEntry.name);
      const raw = await readFile(eventPath, "utf8");

      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        events.push(JSON.parse(trimmed) as RemEvent);
      }
    }
  }

  return events;
}

async function findEventFiles(storeRoot: string): Promise<string[]> {
  const eventsDir = path.join(storeRoot, "events");
  const eventFiles: string[] = [];
  const monthEntries = await readdir(eventsDir, { withFileTypes: true });

  for (const monthEntry of monthEntries) {
    if (!monthEntry.isDirectory()) {
      continue;
    }

    const monthDir = path.join(eventsDir, monthEntry.name);
    const dayEntries = await readdir(monthDir, { withFileTypes: true });

    for (const dayEntry of dayEntries) {
      if (dayEntry.isFile() && dayEntry.name.endsWith(".jsonl")) {
        eventFiles.push(path.join(monthDir, dayEntry.name));
      }
    }
  }

  eventFiles.sort();
  return eventFiles;
}

describe("RemCore note write pipeline", () => {
  test("status includes index recency and health hints for empty store", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-status-empty-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const status = await core.status();
      expect(status.lastIndexedEventAt).toBeNull();
      expect(status.healthHints.length).toBeGreaterThan(0);
      expect(status.healthHints[0]).toContain("No indexed events");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid lexical state", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-invalid-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await expect(
        core.saveNote({
          title: "Invalid",
          lexicalState: {},
        }),
      ).rejects.toThrow();

      const noteDirs = await readdir(path.join(storeRoot, "notes"));
      expect(noteDirs.length).toBe(0);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("emits create and update events", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-events-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Sprint Notes",
        lexicalState: lexicalStateWithText("First note revision"),
        tags: ["sprint"],
        actor: { kind: "human", id: "test-user" },
      });

      await core.saveNote({
        id: created.noteId,
        title: "Sprint Notes",
        lexicalState: lexicalStateWithText("Updated note revision"),
        tags: ["sprint", "updated"],
        actor: { kind: "human", id: "test-user" },
      });

      const events = await readCanonicalEvents(storeRoot);
      expect(events.length).toBe(2);
      expect(events[0]?.type).toBe("note.created");
      expect(events[1]?.type).toBe("note.updated");

      const status = await core.status();
      expect(status.notes).toBe(1);
      expect(status.events).toBe(2);
      expect(typeof status.lastIndexedEventAt).toBe("string");
      expect(Array.isArray(status.healthHints)).toBeTrue();
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("emits trust override metadata for direct note writes when provided", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-trust-override-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Agent Override Note",
        lexicalState: lexicalStateWithText("override write"),
        actor: { kind: "agent", id: "plugin-agent" },
        overrideReason: "approved_automation_window",
        approvedBy: "human-reviewer",
        sourcePlugin: "daily-note",
      });
      expect(created.created).toBeTrue();

      const events = await core.listEvents({
        type: "note.created",
        entityId: created.noteId,
      });
      expect(events.length).toBe(1);
      expect(events[0]?.payload.overrideReason).toBe("approved_automation_window");
      expect(events[0]?.payload.approvedBy).toBe("human-reviewer");
      expect(events[0]?.payload.sourcePlugin).toBe("daily-note");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("lists events with filters in reverse-chronological order", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-list-events-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Timeline",
        lexicalState: lexicalStateWithSectionStructure(),
        tags: ["timeline"],
        actor: { kind: "human", id: "human-1" },
      });

      const target = (await core.listSections(created.noteId))?.find(
        (section) => section.headingText === "Plan",
      );
      expect(target).toBeTruthy();

      await core.createProposal({
        actor: { kind: "agent", id: "agent-1" },
        target: {
          noteId: created.noteId,
          sectionId: target?.sectionId ?? "",
          fallbackPath: target?.fallbackPath,
        },
        proposalType: "replace_section",
        content: {
          format: "text",
          content: "Updated timeline section",
        },
      });

      const allEvents = await core.listEvents();
      expect(allEvents.length).toBe(2);
      expect(allEvents[0]?.type).toBe("proposal.created");
      expect(allEvents[1]?.type).toBe("note.created");

      const noteEvents = await core.listEvents({
        type: "note.created",
        actorKind: "human",
        actorId: "human-1",
      });
      expect(noteEvents.length).toBe(1);
      expect(noteEvents[0]?.entity.id).toBe(created.noteId);

      const proposalEvents = await core.listEvents({
        entityKind: "proposal",
      });
      expect(proposalEvents.length).toBe(1);
      expect(proposalEvents[0]?.type).toBe("proposal.created");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("rebuild-index preserves search results", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-rebuild-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.saveNote({
        title: "Alpha",
        lexicalState: lexicalStateWithText("alpha bravo"),
        actor: { kind: "human", id: "test-user" },
      });

      await core.saveNote({
        title: "Beta",
        lexicalState: lexicalStateWithText("charlie alpha"),
        actor: { kind: "human", id: "test-user" },
      });

      const beforeIds = (await core.searchNotes("alpha")).map((item) => item.id).sort();

      const rebuilt = await core.rebuildIndex();
      expect(rebuilt.notes).toBe(2);
      expect(rebuilt.events).toBe(2);

      const afterIds = (await core.searchNotes("alpha")).map((item) => item.id).sort();

      expect(afterIds).toEqual(beforeIds);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("search applies tags and updated window filters", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-search-filters-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: tasksPluginManifest(),
        actor: { kind: "human", id: "plugin-admin" },
      });

      await core.saveNote({
        title: "Ops Alpha",
        noteType: "task",
        lexicalState: lexicalStateWithText("deploy alpha"),
        tags: ["ops", "daily"],
        actor: { kind: "human", id: "user-1" },
        plugins: {
          tasks: {
            board: "ops",
            done: false,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await core.saveNote({
        title: "Engineering Alpha",
        noteType: "meeting",
        lexicalState: lexicalStateWithText("deploy alpha"),
        tags: ["engineering"],
        actor: { kind: "human", id: "user-1" },
      });

      const notesForCreatedBounds = await core.searchNotes("deploy", { limit: 20 });
      const opsNote = notesForCreatedBounds.find((note) => note.title === "Ops Alpha");
      const engineeringNote = notesForCreatedBounds.find(
        (note) => note.title === "Engineering Alpha",
      );
      expect(opsNote).toBeTruthy();
      expect(engineeringNote).toBeTruthy();

      const opsCreatedAt = (await core.getCanonicalNote(opsNote?.id ?? ""))?.meta.createdAt;
      const engineeringCreatedAt = (await core.getCanonicalNote(engineeringNote?.id ?? ""))?.meta
        .createdAt;
      expect(opsCreatedAt).toBeTruthy();
      expect(engineeringCreatedAt).toBeTruthy();

      const all = await core.searchNotes("deploy", { limit: 20 });
      expect(all.length).toBe(2);

      const opsOnly = await core.searchNotes("deploy", {
        tags: ["ops"],
      });
      expect(opsOnly.length).toBe(1);
      expect(opsOnly[0]?.title).toBe("Ops Alpha");

      const recent = await core.searchNotes("deploy", {
        tags: ["engineering"],
        updatedSince: "2000-01-01T00:00:00.000Z",
        updatedUntil: "2100-01-01T00:00:00.000Z",
      });
      expect(recent.length).toBe(1);
      expect(recent[0]?.title).toBe("Engineering Alpha");

      const taskOnly = await core.searchNotes("deploy", {
        noteTypes: ["task"],
      });
      expect(taskOnly.length).toBe(1);
      expect(taskOnly[0]?.title).toBe("Ops Alpha");

      const pluginOnly = await core.searchNotes("deploy", {
        pluginNamespaces: ["tasks"],
      });
      expect(pluginOnly.length).toBe(1);
      expect(pluginOnly[0]?.title).toBe("Ops Alpha");

      const createdSince = await core.searchNotes("deploy", {
        createdSince: engineeringCreatedAt,
      });
      expect(createdSince.length).toBe(1);
      expect(createdSince[0]?.title).toBe("Engineering Alpha");

      const createdUntil = await core.searchNotes("deploy", {
        createdUntil: opsCreatedAt,
      });
      expect(createdUntil.length).toBe(1);
      expect(createdUntil[0]?.title).toBe("Ops Alpha");

      const combined = await core.searchNotes("deploy", {
        tags: ["ops"],
        noteTypes: ["task"],
        pluginNamespaces: ["tasks"],
      });
      expect(combined.length).toBe(1);
      expect(combined[0]?.title).toBe("Ops Alpha");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("registers plugins and enforces plugin payload schema on note writes", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-plugins-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const registered = await core.registerPlugin({
        manifest: tasksPluginManifest(),
        actor: { kind: "human", id: "admin-1" },
      });

      expect(registered.created).toBeTrue();
      expect(registered.namespace).toBe("tasks");

      const plugins = await core.listPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0]?.manifest.namespace).toBe("tasks");

      await expect(
        core.saveNote({
          title: "Bad plugin payload",
          lexicalState: lexicalStateWithText("content"),
          actor: { kind: "human", id: "user-1" },
          plugins: {
            tasks: {
              done: true,
            },
          },
        }),
      ).rejects.toThrow("missing required field: board");

      const saved = await core.saveNote({
        title: "Good plugin payload",
        lexicalState: lexicalStateWithText("content"),
        actor: { kind: "human", id: "user-1" },
        plugins: {
          tasks: {
            board: "infra",
            done: false,
          },
        },
      });

      expect(saved.meta.plugins.tasks).toEqual({
        board: "infra",
        done: false,
      });

      await expect(
        core.saveNote({
          title: "Unknown plugin payload",
          lexicalState: lexicalStateWithText("content"),
          actor: { kind: "human", id: "user-1" },
          plugins: {
            unknownPlugin: {
              board: "infra",
            },
          },
        }),
      ).rejects.toThrow("Plugin not registered: unknownPlugin");

      const pluginEvents = await core.listEvents({ entityKind: "plugin" });
      expect(pluginEvents.length).toBe(1);
      expect(pluginEvents[0]?.type).toBe("plugin.registered");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("normalizes and persists v2 plugin manifest contracts while keeping payload compatibility", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-plugin-v2-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const registered = await core.registerPlugin({
        manifest: tasksPluginManifestV2(),
        actor: { kind: "human", id: "admin-v2" },
      });

      expect(registered.created).toBeTrue();
      expect(registered.manifest.manifestVersion).toBe("v2");
      expect(registered.manifest.payloadSchema.required).toEqual(["board"]);
      expect(registered.manifest.notePayloadSchema?.required).toEqual(["board"]);

      const listed = await core.listPlugins();
      const tasksV2 = listed.find((plugin) => plugin.manifest.namespace === "tasks-v2");
      expect(tasksV2).toBeTruthy();
      expect(tasksV2?.manifest.manifestVersion).toBe("v2");
      expect(tasksV2?.manifest.payloadSchema.required).toEqual(["board"]);

      const storedManifestPath = path.join(storeRoot, "plugins", "tasks-v2", "manifest.json");
      const storedManifest = JSON.parse(await readFile(storedManifestPath, "utf8")) as {
        manifestVersion?: string;
        payloadSchema?: { required?: string[] };
        notePayloadSchema?: { required?: string[] };
      };
      expect(storedManifest.manifestVersion).toBe("v2");
      expect(storedManifest.payloadSchema?.required).toEqual(["board"]);
      expect(storedManifest.notePayloadSchema?.required).toEqual(["board"]);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("enforces plugin lifecycle transitions and keeps lifecycle state queryable", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-plugin-lifecycle-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: tasksPluginManifest(),
        actor: { kind: "human", id: "admin-lifecycle" },
      });

      const installed = await core.installPlugin({
        namespace: "tasks",
        actor: { kind: "human", id: "admin-lifecycle" },
      });
      expect(installed.state).toBe("installed");

      const enabled = await core.enablePlugin({
        namespace: "tasks",
        actor: { kind: "human", id: "admin-lifecycle" },
      });
      expect(enabled.state).toBe("enabled");

      const disabled = await core.disablePlugin({
        namespace: "tasks",
        disableReason: "maintenance_window",
        actor: { kind: "human", id: "admin-lifecycle" },
      });
      expect(disabled.state).toBe("disabled");
      expect(disabled.meta.disableReason).toBe("maintenance_window");

      const reenabled = await core.enablePlugin({
        namespace: "tasks",
        actor: { kind: "human", id: "admin-lifecycle" },
      });
      expect(reenabled.state).toBe("enabled");
      expect(reenabled.meta.disableReason).toBeUndefined();

      await expect(
        core.installPlugin({
          namespace: "tasks",
          actor: { kind: "human", id: "admin-lifecycle" },
        }),
      ).rejects.toThrow("Invalid plugin lifecycle transition");

      const plugins = await core.listPlugins();
      const tasks = plugins.find((plugin) => plugin.manifest.namespace === "tasks");
      expect(tasks?.meta.lifecycleState).toBe("enabled");

      const lifecycleEvents = await core.listEvents({ entityKind: "plugin" });
      expect(lifecycleEvents.some((event) => event.type === "plugin.installed")).toBeTrue();
      expect(lifecycleEvents.some((event) => event.type === "plugin.activated")).toBeTrue();
      expect(lifecycleEvents.some((event) => event.type === "plugin.deactivated")).toBeTrue();
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("forces plugin disable and explicit re-enable when permissions expand", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-plugin-permission-expansion-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: tasksPluginManifestV2({
          namespace: "tasks-expansion",
          permissions: ["notes.read"],
        }),
        actor: { kind: "human", id: "admin-expansion" },
      });

      await core.installPlugin({
        namespace: "tasks-expansion",
        actor: { kind: "human", id: "admin-expansion" },
      });
      await core.enablePlugin({
        namespace: "tasks-expansion",
        actor: { kind: "human", id: "admin-expansion" },
      });

      const updated = await core.registerPlugin({
        manifest: tasksPluginManifestV2({
          namespace: "tasks-expansion",
          permissions: ["notes.read", "notes.write"],
        }),
        actor: { kind: "human", id: "admin-expansion" },
      });

      expect(updated.created).toBeFalse();
      expect(updated.meta.lifecycleState).toBe("disabled");
      expect(updated.meta.disableReason).toBe("permissions_expanded");

      const reenabled = await core.enablePlugin({
        namespace: "tasks-expansion",
        actor: { kind: "human", id: "admin-expansion" },
      });
      expect(reenabled.state).toBe("enabled");

      const plugins = await core.listPlugins();
      const plugin = plugins.find((item) => item.manifest.namespace === "tasks-expansion");
      expect(plugin?.meta.lifecycleState).toBe("enabled");
      expect(plugin?.meta.disableReason).toBeUndefined();
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("records plugin action success and failure events with required payload minimums", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-plugin-action-events-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: tasksPluginManifestV2({
          namespace: "action-events-core",
          permissions: ["notes.read"],
        }),
        actor: { kind: "human", id: "action-events-admin" },
      });

      const invoked = await core.recordPluginActionEvent({
        namespace: "action-events-core",
        actionId: "echo",
        requestId: "req-core-success",
        actor: { kind: "agent", id: "agent-1" },
        host: "cli",
        status: "success",
        durationMs: 12,
        inputBytes: 15,
        outputBytes: 20,
      });
      expect(invoked.type).toBe("plugin.action_invoked");

      const failed = await core.recordPluginActionEvent({
        namespace: "action-events-core",
        actionId: "echo",
        requestId: "req-core-failure",
        actor: { kind: "agent", id: "agent-1" },
        host: "api",
        status: "failure",
        durationMs: 23,
        errorCode: "plugin_action_timeout",
        errorMessage: "Action timed out after 1ms",
      });
      expect(failed.type).toBe("plugin.action_failed");

      const invokedEvents = await core.listEvents({ type: "plugin.action_invoked" });
      expect(invokedEvents.length).toBe(1);
      expect(invokedEvents[0]?.entity.kind).toBe("plugin");
      expect(invokedEvents[0]?.entity.id).toBe("action-events-core");
      expect(invokedEvents[0]?.payload.namespace).toBe("action-events-core");
      expect(invokedEvents[0]?.payload.actionId).toBe("echo");
      expect(invokedEvents[0]?.payload.requestId).toBe("req-core-success");
      expect(invokedEvents[0]?.payload.actorKind).toBe("agent");
      expect(invokedEvents[0]?.payload.durationMs).toBe(12);
      expect(invokedEvents[0]?.payload.status).toBe("success");

      const failedEvents = await core.listEvents({ type: "plugin.action_failed" });
      expect(failedEvents.length).toBe(1);
      expect(failedEvents[0]?.payload.namespace).toBe("action-events-core");
      expect(failedEvents[0]?.payload.actionId).toBe("echo");
      expect(failedEvents[0]?.payload.requestId).toBe("req-core-failure");
      expect(failedEvents[0]?.payload.actorKind).toBe("agent");
      expect(failedEvents[0]?.payload.durationMs).toBe(23);
      expect(failedEvents[0]?.payload.status).toBe("failure");
      expect(failedEvents[0]?.payload.errorCode).toBe("plugin_action_timeout");
      expect(failedEvents[0]?.payload.errorMessage).toContain("timed out");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("lists available plugin templates and applies template defaults to note creation", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-plugin-templates-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: tasksPluginManifestV2({
          namespace: "templates-core",
        }),
        actor: { kind: "human", id: "templates-admin" },
      });

      const unavailableTemplates = await core.listPluginTemplates({ includeUnavailable: true });
      const unavailable = unavailableTemplates.find((item) => item.namespace === "templates-core");
      expect(unavailable?.available).toBeFalse();
      expect(unavailable?.lifecycleState).toBe("registered");

      await core.installPlugin({
        namespace: "templates-core",
        actor: { kind: "human", id: "templates-admin" },
      });

      const availableTemplates = await core.listPluginTemplates();
      const templateRecord = availableTemplates.find((item) => item.namespace === "templates-core");
      expect(templateRecord).toBeTruthy();
      expect(templateRecord?.template.id).toBe("daily");
      expect(templateRecord?.available).toBeTrue();
      expect(templateRecord?.lifecycleState).toBe("installed");

      const appliedDefault = await core.applyPluginTemplate({
        namespace: "templates-core",
        templateId: "daily",
        actor: { kind: "human", id: "templates-user" },
      });
      expect(appliedDefault.namespace).toBe("templates-core");
      expect(appliedDefault.templateId).toBe("daily");
      expect(appliedDefault.created).toBeTrue();

      const defaultNote = await core.getCanonicalNote(appliedDefault.noteId);
      expect(defaultNote?.meta.title).toBe("Daily");
      expect(defaultNote?.meta.noteType).toBe("task");
      expect(defaultNote?.meta.tags).toEqual(["daily", "template"]);

      const defaultText = await core.getNote(appliedDefault.noteId, "text");
      expect(defaultText?.content).toContain("daily template");

      const appliedOverride = await core.applyPluginTemplate({
        namespace: "templates-core",
        templateId: "daily",
        title: "Daily Override",
        noteType: "journal",
        tags: ["morning", "daily"],
        actor: { kind: "human", id: "templates-user" },
      });
      const overrideNote = await core.getCanonicalNote(appliedOverride.noteId);
      expect(overrideNote?.meta.title).toBe("Daily Override");
      expect(overrideNote?.meta.noteType).toBe("journal");
      expect(overrideNote?.meta.tags).toEqual(["daily", "template", "morning"]);

      await core.uninstallPlugin({
        namespace: "templates-core",
        actor: { kind: "human", id: "templates-admin" },
      });
      await expect(
        core.applyPluginTemplate({
          namespace: "templates-core",
          templateId: "daily",
          actor: { kind: "human", id: "templates-user" },
        }),
      ).rejects.toThrow("templates are unavailable in lifecycle state registered");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("bootstraps daily notes plugin and creates idempotent daily notes", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-daily-notes-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const first = await core.getOrCreateDailyNote({
        now: "2026-01-15T10:45:00.000Z",
        timeZone: "UTC",
      });
      const second = await core.getOrCreateDailyNote({
        now: "2026-01-15T11:45:00.000Z",
        timeZone: "UTC",
      });

      expect(first.noteId).toBe("daily-2026-01-15");
      expect(first.created).toBeTrue();
      expect(first.title).toBe("Thursday Jan 15th 2026");
      expect(first.dateKey).toBe("2026-01-15");
      expect(first.shortDate).toBe("1-15-2026");
      expect(second.noteId).toBe(first.noteId);
      expect(second.created).toBeFalse();

      const canonical = await core.getCanonicalNote(first.noteId);
      expect(canonical?.meta.noteType).toBe("note");
      expect(canonical?.meta.tags).toEqual(["daily"]);
      expect(canonical?.meta.plugins["daily-notes"]).toEqual({
        dateKey: "2026-01-15",
        shortDate: "1-15-2026",
        displayTitle: "Thursday Jan 15th 2026",
        timezone: "UTC",
      });

      const plugin = await core.getPlugin("daily-notes");
      expect(plugin).toBeTruthy();
      expect(plugin?.meta.lifecycleState).toBe("enabled");

      const noteCreatedEvents = await core.listEvents({
        type: "note.created",
        entityId: first.noteId,
      });
      expect(noteCreatedEvents.length).toBe(1);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("serializes concurrent daily note creation attempts", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-daily-concurrency-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const [left, right] = await Promise.all([
        core.getOrCreateDailyNote({
          now: "2026-01-15T10:45:00.000Z",
          timeZone: "UTC",
        }),
        core.getOrCreateDailyNote({
          now: "2026-01-15T10:45:00.000Z",
          timeZone: "UTC",
        }),
      ]);

      expect(left.noteId).toBe("daily-2026-01-15");
      expect(right.noteId).toBe("daily-2026-01-15");
      expect([left.created, right.created].filter((value) => value).length).toBe(1);

      const noteCreatedEvents = await core.listEvents({
        type: "note.created",
        entityId: "daily-2026-01-15",
      });
      expect(noteCreatedEvents.length).toBe(1);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("fails daily note get-or-create when deterministic id is owned by a non-daily note", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-daily-conflict-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.saveNote({
        id: "daily-2026-01-15",
        title: "Manual note using reserved id",
        lexicalState: lexicalStateWithText("manual"),
        actor: { kind: "human", id: "test-user" },
      });

      await expect(
        core.getOrCreateDailyNote({
          now: "2026-01-15T10:45:00.000Z",
          timeZone: "UTC",
        }),
      ).rejects.toThrow("daily_note_id_conflict");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("supports plugin entity create, update, read, and list with schema validation", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-plugin-entities-crud-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: peopleEntityPluginManifest({
          namespace: "people-core",
          schemaVersion: "v1",
          requiredField: "name",
        }),
        actor: { kind: "human", id: "entity-admin" },
      });

      const created = await core.createPluginEntity({
        namespace: "people-core",
        entityType: "person",
        id: "alice",
        data: {
          name: "Alice",
        },
        links: [{ kind: "note", noteId: "note-1" }],
        actor: { kind: "human", id: "entity-admin" },
      });
      expect(created.entity.id).toBe("alice");
      expect(created.entity.schemaVersion).toBe("v1");
      expect(created.meta.links?.length).toBe(1);
      expect(created.compatibility.mode).toBe("current");

      const fetched = await core.getPluginEntity({
        namespace: "people-core",
        entityType: "person",
        id: "alice",
      });
      expect(fetched?.entity.data).toEqual({ name: "Alice" });
      expect(fetched?.compatibility.mode).toBe("current");

      const updated = await core.updatePluginEntity({
        namespace: "people-core",
        entityType: "person",
        id: "alice",
        data: {
          name: "Alice Updated",
        },
        actor: { kind: "human", id: "entity-editor" },
      });
      expect(updated.entity.data).toEqual({ name: "Alice Updated" });
      expect(updated.meta.createdAt).toBe(created.meta.createdAt);
      expect(updated.meta.updatedAt >= created.meta.updatedAt).toBeTrue();
      expect(updated.meta.actor.id).toBe("entity-editor");

      const listed = await core.listPluginEntities({
        namespace: "people-core",
        entityType: "person",
      });
      expect(listed.map((entry) => entry.entity.id)).toEqual(["alice"]);
      expect(listed[0]?.compatibility.mode).toBe("current");

      const schemaVersionFiltered = await core.listPluginEntities({
        namespace: "people-core",
        entityType: "person",
        schemaVersion: "v1",
      });
      expect(schemaVersionFiltered.length).toBe(1);

      await expect(
        core.createPluginEntity({
          namespace: "people-core",
          entityType: "person",
          id: "alice",
          data: {
            name: "Duplicate",
          },
          actor: { kind: "human", id: "entity-admin" },
        }),
      ).rejects.toThrow("Entity already exists");

      await expect(
        core.updatePluginEntity({
          namespace: "people-core",
          entityType: "person",
          id: "missing",
          data: {
            name: "Ghost",
          },
          actor: { kind: "human", id: "entity-admin" },
        }),
      ).rejects.toThrow("Entity not found");

      await expect(
        core.createPluginEntity({
          namespace: "people-core",
          entityType: "person",
          id: "bad",
          data: {
            fullName: "Wrong schema",
          },
          actor: { kind: "human", id: "entity-admin" },
        }),
      ).rejects.toThrow("missing required field: name");

      const entityEvents = await core.listEvents({ type: "entity.created" });
      expect(entityEvents.length).toBe(1);
      expect(entityEvents[0]?.payload.entityId).toBe("alice");
      expect(entityEvents[0]?.payload.entityType).toBe("person");

      const updateEvents = await core.listEvents({ type: "entity.updated" });
      expect(updateEvents.length).toBe(1);
      expect(updateEvents[0]?.payload.entityId).toBe("alice");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("supports mixed-version plugin entity reads across schema migration windows", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-plugin-entities-mixed-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: peopleEntityPluginManifest({
          namespace: "people-mixed",
          schemaVersion: "v1",
          requiredField: "name",
        }),
        actor: { kind: "human", id: "entity-admin" },
      });

      await core.createPluginEntity({
        namespace: "people-mixed",
        entityType: "person",
        id: "legacy",
        data: {
          name: "Legacy Name",
        },
        actor: { kind: "human", id: "entity-admin" },
      });

      await core.registerPlugin({
        manifest: peopleEntityPluginManifest({
          namespace: "people-mixed",
          schemaVersion: "v2",
          requiredField: "fullName",
        }),
        actor: { kind: "human", id: "entity-admin" },
      });

      const legacy = await core.getPluginEntity({
        namespace: "people-mixed",
        entityType: "person",
        id: "legacy",
      });
      expect(legacy?.entity.schemaVersion).toBe("v1");
      expect(legacy?.compatibility.mode).toBe("mixed");
      expect(legacy?.compatibility.manifestSchemaVersion).toBe("v2");

      const withFilterV1 = await core.listPluginEntities({
        namespace: "people-mixed",
        entityType: "person",
        schemaVersion: "v1",
      });
      expect(withFilterV1.map((entry) => entry.entity.id)).toEqual(["legacy"]);
      expect(withFilterV1[0]?.compatibility.mode).toBe("mixed");

      const createdV2 = await core.createPluginEntity({
        namespace: "people-mixed",
        entityType: "person",
        id: "modern",
        data: {
          fullName: "Modern Name",
        },
        actor: { kind: "human", id: "entity-admin" },
      });
      expect(createdV2.entity.schemaVersion).toBe("v2");
      expect(createdV2.compatibility.mode).toBe("current");

      await expect(
        core.createPluginEntity({
          namespace: "people-mixed",
          entityType: "person",
          id: "bad-version",
          schemaVersion: "v1",
          data: {
            fullName: "Invalid Version Write",
          },
          actor: { kind: "human", id: "entity-admin" },
        }),
      ).rejects.toThrow("is not writable");

      await expect(
        core.updatePluginEntity({
          namespace: "people-mixed",
          entityType: "person",
          id: "legacy",
          data: {
            name: "Still legacy shape",
          },
          actor: { kind: "human", id: "entity-admin" },
        }),
      ).rejects.toThrow("missing required field: fullName");

      const migratedLegacy = await core.updatePluginEntity({
        namespace: "people-mixed",
        entityType: "person",
        id: "legacy",
        data: {
          fullName: "Legacy Migrated",
        },
        actor: { kind: "human", id: "entity-admin" },
      });
      expect(migratedLegacy.entity.schemaVersion).toBe("v2");
      expect(migratedLegacy.compatibility.mode).toBe("current");

      const listed = await core.listPluginEntities({
        namespace: "people-mixed",
        entityType: "person",
      });
      expect(listed.map((entry) => entry.entity.id)).toEqual(["legacy", "modern"]);
      expect(listed.every((entry) => entry.entity.schemaVersion === "v2")).toBeTrue();
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("rebuild-index preserves entity, link, and entity FTS parity", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-entity-index-rebuild-"));
    const core = await RemCore.create({ storeRoot });

    const readEntityIndexSnapshot = () => {
      const db = new Database(path.join(storeRoot, "index", "rem.db"), { readonly: true });
      try {
        const entities = db
          .query(
            `SELECT
              namespace,
              entity_type AS entityType,
              entity_id AS entityId,
              schema_version AS schemaVersion,
              updated_at AS updatedAt
            FROM entities
            ORDER BY namespace ASC, entity_type ASC, entity_id ASC`,
          )
          .all() as Array<{
          namespace: string;
          entityType: string;
          entityId: string;
          schemaVersion: string;
          updatedAt: string;
        }>;
        const links = db
          .query(
            `SELECT
              namespace,
              entity_type AS entityType,
              entity_id AS entityId,
              link_kind AS kind,
              note_id AS noteId,
              target_namespace AS targetNamespace,
              target_entity_type AS targetEntityType,
              target_entity_id AS targetEntityId
            FROM entity_links
            ORDER BY namespace ASC, entity_type ASC, entity_id ASC, kind ASC`,
          )
          .all() as Array<{
          namespace: string;
          entityType: string;
          entityId: string;
          kind: string;
          noteId: string | null;
          targetNamespace: string | null;
          targetEntityType: string | null;
          targetEntityId: string | null;
        }>;
        const search = db
          .query(
            `SELECT
              entities.entity_id AS entityId
            FROM entities_fts
            JOIN entities
              ON entities.namespace = entities_fts.namespace
              AND entities.entity_type = entities_fts.entity_type
              AND entities.entity_id = entities_fts.entity_id
            WHERE entities_fts MATCH ?
            ORDER BY bm25(entities_fts), entities.updated_at DESC`,
          )
          .all("Alice") as Array<{ entityId: string }>;

        return {
          entities,
          links,
          search: search.map((row) => row.entityId),
        };
      } finally {
        db.close();
      }
    };

    try {
      await core.registerPlugin({
        manifest: peopleEntityPluginManifest({
          namespace: "people-index",
          schemaVersion: "v1",
          requiredField: "name",
          textFields: ["name", "summary"],
        }),
        actor: { kind: "human", id: "entity-admin" },
      });

      await core.createPluginEntity({
        namespace: "people-index",
        entityType: "person",
        id: "bob",
        data: {
          name: "Bob",
          summary: "Infrastructure",
        },
        actor: { kind: "human", id: "entity-admin" },
      });

      await core.createPluginEntity({
        namespace: "people-index",
        entityType: "person",
        id: "alice",
        data: {
          name: "Alice",
          summary: "Platform lead",
        },
        links: [
          { kind: "note", noteId: "note-123" },
          {
            kind: "entity",
            namespace: "people-index",
            entityType: "person",
            entityId: "bob",
          },
        ],
        actor: { kind: "human", id: "entity-admin" },
      });

      const before = readEntityIndexSnapshot();
      expect(before.entities.length).toBe(2);
      expect(before.links.length).toBe(2);
      expect(before.search).toEqual(["alice"]);

      await core.rebuildIndex();

      const after = readEntityIndexSnapshot();
      expect(after.entities).toEqual(before.entities);
      expect(after.links).toEqual(before.links);
      expect(after.search).toEqual(before.search);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("executes scheduled task slots once and remains idempotent across restart", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-scheduler-restart-"));
    let core: RemCore | null = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: scheduledTaskPluginManifest({
          namespace: "scheduler-restart",
          schedule: {
            kind: "hourly",
            minute: 0,
            timezone: "UTC",
          },
          runWindowMinutes: 15,
        }),
        actor: { kind: "human", id: "scheduler-admin" },
      });
      await core.installPlugin({
        namespace: "scheduler-restart",
        actor: { kind: "human", id: "scheduler-admin" },
      });
      await core.enablePlugin({
        namespace: "scheduler-restart",
        actor: { kind: "human", id: "scheduler-admin" },
      });

      const firstRun = await core.runPluginScheduler({
        now: "2026-02-11T10:05:00.000Z",
        executor: async () => {},
      });
      expect(firstRun.executedRuns.length).toBe(1);
      expect(firstRun.dueRuns).toBe(1);
      expect(firstRun.skippedAsDuplicate).toBe(0);
      expect(firstRun.ledgerEntries).toBe(1);

      const schedulerEvents = await core.listEvents({ type: "plugin.task_ran" });
      expect(schedulerEvents.length).toBe(1);
      expect(schedulerEvents[0]?.payload.taskId).toBe("daily-note");
      expect(schedulerEvents[0]?.payload.scheduledFor).toBe("2026-02-11T10:00:00.000Z");
      expect(schedulerEvents[0]?.payload.idempotencyKey).toBe("calendar_slot");
      expect(schedulerEvents[0]?.payload.status).toBe("success");
      expect(typeof schedulerEvents[0]?.payload.startedAt).toBe("string");
      expect(typeof schedulerEvents[0]?.payload.finishedAt).toBe("string");

      const schedulerStatus = await core.getPluginSchedulerStatus();
      expect(schedulerStatus.ledgerEntries).toBe(1);
      expect(schedulerStatus.taskSummaries.length).toBe(1);
      expect(schedulerStatus.taskSummaries[0]?.namespace).toBe("scheduler-restart");
      expect(schedulerStatus.taskSummaries[0]?.taskId).toBe("daily-note");
      expect(schedulerStatus.recentRuns.length).toBe(1);

      await core.close();
      core = await RemCore.create({ storeRoot });

      const secondRun = await core.runPluginScheduler({
        now: "2026-02-11T10:10:00.000Z",
        executor: async () => {
          throw new Error("duplicate execution should be suppressed");
        },
      });
      expect(secondRun.executedRuns.length).toBe(0);
      expect(secondRun.dueRuns).toBe(0);
      expect(secondRun.skippedAsDuplicate).toBe(1);
      expect(secondRun.ledgerEntries).toBe(1);

      const ledgerPath = path.join(storeRoot, "runtime", "scheduler-ledger.json");
      const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
        entries: Array<{ dedupeKey: string; namespace: string }>;
      };
      expect(ledger.entries.length).toBe(1);
      expect(ledger.entries[0]?.namespace).toBe("scheduler-restart");
    } finally {
      if (core) {
        await core.close();
      }
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("evaluates scheduled tasks using declared timezone and run-window semantics", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-scheduler-timezone-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: scheduledTaskPluginManifest({
          namespace: "scheduler-timezone",
          schedule: {
            kind: "daily",
            hour: 9,
            minute: 30,
            timezone: "America/New_York",
          },
          runWindowMinutes: 10,
        }),
        actor: { kind: "human", id: "scheduler-admin" },
      });
      await core.installPlugin({
        namespace: "scheduler-timezone",
        actor: { kind: "human", id: "scheduler-admin" },
      });
      await core.enablePlugin({
        namespace: "scheduler-timezone",
        actor: { kind: "human", id: "scheduler-admin" },
      });

      const withinWindow = await core.runPluginScheduler({
        now: "2026-06-15T13:38:00.000Z",
      });
      expect(withinWindow.executedRuns.length).toBe(1);
      expect(withinWindow.executedRuns[0]?.timezone).toBe("America/New_York");
      expect(withinWindow.executedRuns[0]?.slotKey).toContain("T09:30@America/New_York");

      const outsideWindow = await core.runPluginScheduler({
        now: "2026-06-15T13:45:00.000Z",
      });
      expect(outsideWindow.executedRuns.length).toBe(0);
      expect(outsideWindow.dueRuns).toBe(0);
      expect(outsideWindow.skippedAsDuplicate).toBe(0);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("derives deterministic idempotency keys for action_input_hash scheduled tasks", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-scheduler-idempotency-hash-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: scheduledTaskPluginManifest({
          namespace: "scheduler-hash",
          schedule: {
            kind: "hourly",
            minute: 0,
            timezone: "UTC",
          },
          runWindowMinutes: 10,
          idempotencyKey: "action_input_hash",
        }),
        actor: { kind: "human", id: "scheduler-admin" },
      });
      await core.installPlugin({
        namespace: "scheduler-hash",
        actor: { kind: "human", id: "scheduler-admin" },
      });
      await core.enablePlugin({
        namespace: "scheduler-hash",
        actor: { kind: "human", id: "scheduler-admin" },
      });

      const firstRun = await core.runPluginScheduler({
        now: "2026-02-11T10:05:00.000Z",
      });
      expect(firstRun.executedRuns.length).toBe(1);
      expect(firstRun.executedRuns[0]?.idempotencyKey).toBe("action_input_hash");
      expect(firstRun.executedRuns[0]?.dedupeKey).toContain("action_input_hash:");

      const secondRun = await core.runPluginScheduler({
        now: "2026-02-11T10:07:00.000Z",
      });
      expect(secondRun.executedRuns.length).toBe(0);
      expect(secondRun.skippedAsDuplicate).toBe(1);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("emits failure scheduler events and keeps failed runs out of the ledger", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-scheduler-failure-events-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.registerPlugin({
        manifest: scheduledTaskPluginManifest({
          namespace: "scheduler-failure",
          schedule: {
            kind: "hourly",
            minute: 0,
            timezone: "UTC",
          },
          runWindowMinutes: 10,
        }),
        actor: { kind: "human", id: "scheduler-admin" },
      });
      await core.installPlugin({
        namespace: "scheduler-failure",
        actor: { kind: "human", id: "scheduler-admin" },
      });
      await core.enablePlugin({
        namespace: "scheduler-failure",
        actor: { kind: "human", id: "scheduler-admin" },
      });

      const failedRun = await core.runPluginScheduler({
        now: "2026-02-11T10:05:00.000Z",
        executor: async () => {
          throw new Error("boom");
        },
      });
      expect(failedRun.executedRuns.length).toBe(0);
      expect(failedRun.failedRuns.length).toBe(1);
      expect(failedRun.ledgerEntries).toBe(0);

      const schedulerEvents = await core.listEvents({ type: "plugin.task_ran" });
      expect(schedulerEvents.length).toBe(1);
      expect(schedulerEvents[0]?.payload.status).toBe("failure");
      expect(schedulerEvents[0]?.payload.errorCode).toBe("execution_failed");
      expect(schedulerEvents[0]?.payload.errorMessage).toBe("boom");

      const schedulerStatus = await core.getPluginSchedulerStatus();
      expect(schedulerStatus.ledgerEntries).toBe(0);
      expect(schedulerStatus.taskSummaries.length).toBe(0);
      expect(schedulerStatus.recentRuns.length).toBe(0);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("returns null for missing note retrieval", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-missing-note-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const canonical = await core.getCanonicalNote("missing-id");
      const formatted = await core.getNote("missing-id", "text");

      expect(canonical).toBeNull();
      expect(formatted).toBeNull();
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("retrieves note content as lexical, text, and markdown", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-get-formats-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Design Note",
        lexicalState: lexicalStateWithHeadingAndParagraph("Plan", "Ship incremental slices."),
        actor: { kind: "human", id: "test-user" },
      });

      const canonical = await core.getCanonicalNote(created.noteId);
      const textResult = await core.getNote(created.noteId, "text");
      const markdownResult = await core.getNote(created.noteId, "md");

      expect(canonical?.noteId).toBe(created.noteId);
      expect((canonical?.lexicalState as { root?: unknown })?.root).toBeTruthy();

      expect(textResult?.format).toBe("text");
      expect(textResult?.content).toContain("Plan");
      expect(textResult?.content).toContain("Ship incremental slices.");

      expect(markdownResult?.format).toBe("md");
      expect(markdownResult?.content).toContain("## Plan");
      expect(markdownResult?.content).toContain("Ship incremental slices.");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("persists deterministic section index for notes", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-sections-deterministic-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Section Map",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const first = await core.getCanonicalNote(created.noteId);

      await core.saveNote({
        id: created.noteId,
        title: "Section Map",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const second = await core.getCanonicalNote(created.noteId);

      expect(first?.sectionIndex.sections.length).toBe(3);
      expect(second?.sectionIndex.sections.length).toBe(3);
      expect(second?.sectionIndex.sections.map((section) => section.sectionId)).toEqual(
        first?.sectionIndex.sections.map((section) => section.sectionId),
      );
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("preserves section IDs across heading edits and section insertion", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-sections-stable-edits-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Section Identity",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const baseline = await core.listSections(created.noteId);
      expect(baseline?.length).toBe(3);
      const baselineByHeading = new Map(
        (baseline ?? []).map((section) => [section.headingText, section.sectionId] as const),
      );

      await core.saveNote({
        id: created.noteId,
        title: "Section Identity",
        lexicalState: lexicalStateWithRenamedSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const renamed = await core.listSections(created.noteId);
      expect(renamed?.length).toBe(3);
      const renamedByHeading = new Map(
        (renamed ?? []).map((section) => [section.headingText, section.sectionId] as const),
      );
      expect(renamedByHeading.get("Plan Updated")).toBe(baselineByHeading.get("Plan"));
      expect(renamedByHeading.get("Milestones")).toBe(baselineByHeading.get("Milestones"));

      await core.saveNote({
        id: created.noteId,
        title: "Section Identity",
        lexicalState: lexicalStateWithInsertedSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const inserted = await core.listSections(created.noteId);
      const insertedByHeading = new Map(
        (inserted ?? []).map((section) => [section.headingText, section.sectionId] as const),
      );

      expect(insertedByHeading.get("Plan")).toBe(baselineByHeading.get("Plan"));
      expect(insertedByHeading.get("Milestones")).toBe(baselineByHeading.get("Milestones"));
      expect(insertedByHeading.get("New Section")).toBeTruthy();
      expect(insertedByHeading.get("New Section")).not.toBe(baselineByHeading.get("Plan"));
      expect(insertedByHeading.get("New Section")).not.toBe(baselineByHeading.get("Milestones"));
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("migration backfills section identity metadata without breaking open proposals", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-section-migration-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Legacy Section Identity",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const sectionsPath = path.join(storeRoot, "notes", created.noteId, "sections.json");
      const metaPath = path.join(storeRoot, "notes", created.noteId, "meta.json");
      const sectionsRaw = await readFile(sectionsPath, "utf8");
      const metaRaw = await readFile(metaPath, "utf8");

      const sections = JSON.parse(sectionsRaw) as {
        noteId: string;
        schemaVersion: string;
        generatedAt: string;
        sections: Array<Record<string, unknown>>;
      };
      const legacySections = {
        ...sections,
        sections: sections.sections.map((section, index) => ({
          ...section,
          sectionId: `legacy-sec-${index + 1}`,
        })),
      };

      const meta = JSON.parse(metaRaw) as Record<string, unknown>;
      const legacyMeta = {
        ...meta,
        sectionIndexVersion: "v1",
      };

      await writeFile(sectionsPath, `${JSON.stringify(legacySections, null, 2)}\n`);
      await writeFile(metaPath, `${JSON.stringify(legacyMeta, null, 2)}\n`);

      await core.rebuildIndex();

      const legacyIndexedSections = await core.listSections(created.noteId);
      const legacyPlanSection = legacyIndexedSections?.find(
        (section) => section.headingText === "Plan",
      );
      expect(legacyPlanSection?.sectionId).toContain("legacy-sec");

      const proposal = await core.createProposal({
        actor: { kind: "agent", id: "agent-1" },
        target: {
          noteId: created.noteId,
          sectionId: legacyPlanSection?.sectionId ?? "",
          fallbackPath: legacyPlanSection?.fallbackPath,
        },
        proposalType: "replace_section",
        content: {
          format: "text",
          content: "Migrated proposal content",
        },
      });

      const migration = await core.migrateSectionIdentity();
      expect(migration.migrated).toBe(1);
      expect(migration.noteIds).toContain(created.noteId);

      const migratedSections = await core.listSections(created.noteId);
      const migratedPlanSection = migratedSections?.find(
        (section) => section.headingText === "Plan",
      );
      expect(migratedPlanSection?.sectionId).toBe(legacyPlanSection?.sectionId);

      const accepted = await core.acceptProposal({
        proposalId: proposal.proposalId,
        actor: { kind: "human", id: "reviewer-1" },
      });
      expect(accepted?.status).toBe("accepted");

      const migrationEvents = await core.listEvents({ type: "schema.migration_run" });
      expect(migrationEvents.length).toBe(1);
      expect(migrationEvents[0]?.entity.id).toBe(created.noteId);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("finds sections by id and fallback path", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-sections-lookup-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Section Lookup",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const sections = await core.listSections(created.noteId);
      expect(sections?.length).toBe(3);

      const planSection = sections?.find((section) => section.headingText === "Plan");
      expect(planSection).toBeTruthy();

      const byId = await core.findSection({
        noteId: created.noteId,
        sectionId: planSection?.sectionId ?? "",
      });
      expect(byId?.headingText).toBe("Plan");

      const byFallback = await core.findSection({
        noteId: created.noteId,
        sectionId: "missing-id",
        fallbackPath: ["Plan", "Milestones"],
      });
      expect(byFallback?.headingText).toBe("Milestones");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("creates, lists, and rejects annotate proposals", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-proposals-reject-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Proposal Target",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const sections = await core.listSections(created.noteId);
      const planSection = sections?.find((section) => section.headingText === "Plan");
      expect(planSection).toBeTruthy();

      const proposal = await core.createProposal({
        actor: { kind: "agent", id: "agent-1" },
        target: {
          noteId: created.noteId,
          sectionId: planSection?.sectionId ?? "",
          fallbackPath: planSection?.fallbackPath,
        },
        proposalType: "annotate",
        content: {
          format: "json",
          content: {
            tagsToAdd: ["reviewed"],
          },
        },
        rationale: "Tighten wording",
      });

      const openProposals = await core.listProposals({ status: "open" });
      expect(openProposals.length).toBe(1);
      expect(openProposals[0]?.proposal.id).toBe(proposal.proposalId);

      const rejected = await core.rejectProposal({
        proposalId: proposal.proposalId,
        actor: { kind: "human", id: "reviewer-1" },
      });
      expect(rejected?.status).toBe("rejected");

      const afterReject = await core.getProposal(proposal.proposalId);
      expect(afterReject?.proposal.status).toBe("rejected");

      const events = await readCanonicalEvents(storeRoot);
      const rejectedEvent = events.find((event) => event.type === "proposal.rejected");
      expect(rejectedEvent?.payload.proposalType).toBe("annotate");

      await expect(
        core.acceptProposal({
          proposalId: proposal.proposalId,
          actor: { kind: "human", id: "reviewer-1" },
        }),
      ).rejects.toThrow("Cannot accept proposal in status rejected");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("accepts proposal and updates note with proposal events", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-proposals-accept-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Proposal Accept",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const sections = await core.listSections(created.noteId);
      const planSection = sections?.find((section) => section.headingText === "Plan");
      expect(planSection).toBeTruthy();

      const proposal = await core.createProposal({
        actor: { kind: "agent", id: "agent-1" },
        target: {
          noteId: created.noteId,
          sectionId: planSection?.sectionId ?? "",
          fallbackPath: planSection?.fallbackPath,
        },
        proposalType: "replace_section",
        content: {
          format: "text",
          content: "New accepted content",
        },
        rationale: "Replace stale details",
      });

      const accepted = await core.acceptProposal({
        proposalId: proposal.proposalId,
        actor: { kind: "human", id: "reviewer-1" },
      });

      expect(accepted?.status).toBe("accepted");
      expect(accepted?.noteEventId).toBeTruthy();

      const textNote = await core.getNote(created.noteId, "text");
      expect(textNote?.content).toContain("New accepted content");

      const proposalAfter = await core.getProposal(proposal.proposalId);
      expect(proposalAfter?.proposal.status).toBe("accepted");

      const events = await readCanonicalEvents(storeRoot);
      expect(events.some((event) => event.type === "proposal.created")).toBeTrue();
      expect(events.some((event) => event.type === "proposal.accepted")).toBeTrue();
      expect(events.some((event) => event.type === "note.updated")).toBeTrue();

      const acceptedEvent = events.find((event) => event.type === "proposal.accepted");
      expect(acceptedEvent?.payload.proposalType).toBe("replace_section");
      expect(acceptedEvent?.payload.applyMode).toBe("replace_section");

      const noteUpdatedEvent = events.find((event) => event.type === "note.updated");
      expect(noteUpdatedEvent?.payload.sourceProposalType).toBe("replace_section");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("accepts annotate proposal and updates note metadata with annotation context", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-proposals-annotate-accept-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Annotate Target",
        lexicalState: lexicalStateWithSectionStructure(),
        tags: ["stale", "keep"],
        actor: { kind: "human", id: "test-user" },
      });

      const sections = await core.listSections(created.noteId);
      const planSection = sections?.find((section) => section.headingText === "Plan");
      expect(planSection).toBeTruthy();

      const proposal = await core.createProposal({
        actor: { kind: "agent", id: "agent-1" },
        target: {
          noteId: created.noteId,
          sectionId: planSection?.sectionId ?? "",
          fallbackPath: planSection?.fallbackPath,
        },
        proposalType: "annotate",
        content: {
          format: "json",
          content: {
            root: {
              children: [
                {
                  type: "paragraph",
                  version: 1,
                  children: [
                    {
                      type: "text",
                      version: 1,
                      text: "Annotation note",
                    },
                  ],
                },
              ],
            },
            tagsToAdd: ["fresh"],
            tagsToRemove: ["stale"],
            setTitle: "Annotate Target Updated",
          },
        },
      });

      const accepted = await core.acceptProposal({
        proposalId: proposal.proposalId,
        actor: { kind: "human", id: "reviewer-1" },
      });

      expect(accepted?.status).toBe("accepted");

      const canonical = await core.getCanonicalNote(created.noteId);
      expect(canonical?.meta.title).toBe("Annotate Target Updated");
      expect(canonical?.meta.tags).toEqual(["keep", "fresh"]);

      const textNote = await core.getNote(created.noteId, "text");
      expect(textNote?.content).toContain("Annotation note");

      const events = await readCanonicalEvents(storeRoot);
      const acceptedEvent = events.find((event) => event.type === "proposal.accepted");
      expect(acceptedEvent?.payload.proposalType).toBe("annotate");
      expect(acceptedEvent?.payload.applyMode).toBe("annotate");
      expect(acceptedEvent?.payload.tagsAdded).toEqual(["fresh"]);
      expect(acceptedEvent?.payload.tagsRemoved).toEqual(["stale"]);
      expect(acceptedEvent?.payload.titleUpdated).toBeTrue();

      const noteUpdatedEvent = events.find((event) => event.type === "note.updated");
      expect(noteUpdatedEvent?.payload.sourceProposalType).toBe("annotate");
      expect(noteUpdatedEvent?.payload.applyMode).toBe("annotate");
      expect(noteUpdatedEvent?.payload.tags).toEqual(["keep", "fresh"]);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("fails proposal creation when target section does not exist", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-proposals-missing-section-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Missing Section",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      await expect(
        core.createProposal({
          actor: { kind: "agent", id: "agent-1" },
          target: {
            noteId: created.noteId,
            sectionId: "missing-section-id",
            fallbackPath: ["Does Not Exist"],
          },
          proposalType: "replace_section",
          content: {
            format: "text",
            content: "Won't apply",
          },
        }),
      ).rejects.toThrow("Target section not found");
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("rebuild-index restores proposal and section indexes", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-rebuild-proposals-sections-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Rebuild Proposal Indexes",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const sectionsBefore = await core.listSections(created.noteId);
      const target = sectionsBefore?.find((section) => section.headingText === "Plan");
      expect(target).toBeTruthy();

      await core.createProposal({
        actor: { kind: "agent", id: "agent-1" },
        target: {
          noteId: created.noteId,
          sectionId: target?.sectionId ?? "",
          fallbackPath: target?.fallbackPath,
        },
        proposalType: "replace_section",
        content: {
          format: "text",
          content: "Pending proposal content",
        },
      });

      const proposalsBefore = await core.listProposals({ status: "open" });
      expect(proposalsBefore.length).toBe(1);

      const rebuilt = await core.rebuildIndex();
      expect(rebuilt.notes).toBe(1);
      expect(rebuilt.proposals).toBe(1);

      const proposalsAfter = await core.listProposals({ status: "open" });
      const sectionsAfter = await core.listSections(created.noteId);

      expect(proposalsAfter.length).toBe(1);
      expect(sectionsAfter?.length).toBe(sectionsBefore?.length);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("rebuild-index tolerates truncated final event line", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-rebuild-crash-"));
    const core = await RemCore.create({ storeRoot });

    try {
      await core.saveNote({
        title: "Crash Recovery",
        lexicalState: lexicalStateWithText("truncated tail"),
        actor: { kind: "human", id: "test-user" },
      });

      const eventFiles = await findEventFiles(storeRoot);
      expect(eventFiles.length).toBe(1);

      await appendFile(eventFiles[0] ?? "", '{"eventId":"partial');

      const rebuilt = await core.rebuildIndex();
      expect(rebuilt.events).toBe(1);
      expect(rebuilt.notes).toBe(1);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("rebuild-index tolerates truncated tail after proposal lifecycle events", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-core-rebuild-proposal-crash-"));
    const core = await RemCore.create({ storeRoot });

    try {
      const created = await core.saveNote({
        title: "Crash Recovery Proposal",
        lexicalState: lexicalStateWithSectionStructure(),
        actor: { kind: "human", id: "test-user" },
      });

      const target = (await core.listSections(created.noteId))?.find(
        (section) => section.headingText === "Plan",
      );
      expect(target).toBeTruthy();

      const proposal = await core.createProposal({
        actor: { kind: "agent", id: "agent-1" },
        target: {
          noteId: created.noteId,
          sectionId: target?.sectionId ?? "",
          fallbackPath: target?.fallbackPath,
        },
        proposalType: "replace_section",
        content: {
          format: "text",
          content: "Recovered section content",
        },
      });

      await core.acceptProposal({
        proposalId: proposal.proposalId,
        actor: { kind: "human", id: "reviewer-1" },
      });

      const eventFiles = await findEventFiles(storeRoot);
      expect(eventFiles.length).toBe(1);

      await appendFile(eventFiles[0] ?? "", '{"eventId":"partial');

      const rebuilt = await core.rebuildIndex();
      expect(rebuilt.events).toBe(4);
      expect(rebuilt.proposals).toBe(1);
    } finally {
      await core.close();
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("store root config persists configured path and drives core status", async () => {
    const previousConfigPath = process.env.REM_CONFIG_PATH;
    const previousStoreRoot = process.env.REM_STORE_ROOT;
    const configWorkspace = await mkdtemp(path.join(tmpdir(), "rem-core-config-file-"));
    const configuredStoreRoot = await mkdtemp(path.join(tmpdir(), "rem-core-config-store-"));
    const configPath = path.join(configWorkspace, "config.json");

    try {
      process.env.REM_CONFIG_PATH = configPath;
      process.env.REM_STORE_ROOT = undefined;

      const updatedConfig = await setCoreStoreRootConfigViaCore(configuredStoreRoot);
      expect(updatedConfig.configPath).toBe(path.resolve(configPath));
      expect(updatedConfig.configuredStoreRoot).toBe(path.resolve(configuredStoreRoot));
      expect(updatedConfig.effectiveStoreRoot).toBe(path.resolve(configuredStoreRoot));
      expect(updatedConfig.source).toBe("runtime");

      const persistedRaw = JSON.parse(await readFile(configPath, "utf8")) as {
        schemaVersion: string;
        storeRoot: string;
      };
      expect(persistedRaw.schemaVersion).toBe("v1");
      expect(persistedRaw.storeRoot).toBe(path.resolve(configuredStoreRoot));

      const status = await getCoreStatus();
      expect(status.storeRoot).toBe(path.resolve(configuredStoreRoot));
    } finally {
      process.env.REM_CONFIG_PATH = previousConfigPath;
      process.env.REM_STORE_ROOT = previousStoreRoot;
      await rm(configWorkspace, { recursive: true, force: true });
      await rm(configuredStoreRoot, { recursive: true, force: true });
    }
  });

  test("store root config expands home paths on updates", async () => {
    const previousConfigPath = process.env.REM_CONFIG_PATH;
    const previousStoreRoot = process.env.REM_STORE_ROOT;
    const configWorkspace = await mkdtemp(path.join(tmpdir(), "rem-core-config-env-"));
    const configPath = path.join(configWorkspace, "config.json");

    try {
      process.env.REM_CONFIG_PATH = configPath;
      process.env.REM_STORE_ROOT = undefined;

      const config = await setCoreStoreRootConfigViaCore("~/rem-core-env-root");
      expect(config.configuredStoreRoot).toBe(
        path.resolve(path.join(homedir(), "rem-core-env-root")),
      );
      expect(config.effectiveStoreRoot).toBe(
        path.resolve(path.join(homedir(), "rem-core-env-root")),
      );
      expect(config.source).toBe("runtime");
    } finally {
      process.env.REM_CONFIG_PATH = previousConfigPath;
      process.env.REM_STORE_ROOT = previousStoreRoot;
      await rm(configWorkspace, { recursive: true, force: true });
    }
  });

  test("store root config ignores invalid persisted config payload even with runtime override", async () => {
    const previousConfigPath = process.env.REM_CONFIG_PATH;
    const previousStoreRoot = process.env.REM_STORE_ROOT;
    const configWorkspace = await mkdtemp(path.join(tmpdir(), "rem-core-config-invalid-"));
    const runtimeStoreRoot = await mkdtemp(path.join(tmpdir(), "rem-core-config-runtime-"));
    const configPath = path.join(configWorkspace, "config.json");

    try {
      process.env.REM_CONFIG_PATH = configPath;
      process.env.REM_STORE_ROOT = undefined;
      await setCoreStoreRootConfigViaCore(runtimeStoreRoot);
      await writeFile(
        configPath,
        JSON.stringify({
          schemaVersion: "v1",
          storeRoot: "",
        }),
        "utf8",
      );

      const config = await getCoreStoreRootConfigViaCore();
      expect(config.configPath).toBe(path.resolve(configPath));
      expect(config.configuredStoreRoot).toBeNull();
      expect(config.source).toBe("runtime");
      expect(config.effectiveStoreRoot).toBe(path.resolve(runtimeStoreRoot));
    } finally {
      process.env.REM_CONFIG_PATH = previousConfigPath;
      process.env.REM_STORE_ROOT = previousStoreRoot;
      await rm(configWorkspace, { recursive: true, force: true });
      await rm(runtimeStoreRoot, { recursive: true, force: true });
    }
  });
});
