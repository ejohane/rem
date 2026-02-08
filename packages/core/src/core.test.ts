import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RemEvent } from "@rem/schemas";

import { RemCore } from "./index";

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

function tasksPluginManifest() {
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
});
