import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  DraftMeta,
  LexicalState,
  NoteMeta,
  NoteSection,
  PluginManifest,
  Proposal,
  RemEvent,
} from "@rem/schemas";

import { RemIndex } from "./index";

function makeNoteMeta(noteId: string, overrides?: Partial<NoteMeta>): NoteMeta {
  const base: NoteMeta = {
    id: noteId,
    schemaVersion: "v1",
    title: "Demo Note",
    noteType: "note",
    createdAt: "2026-02-07T00:00:00.000Z",
    updatedAt: "2026-02-07T00:00:00.000Z",
    author: { kind: "human", id: "tester" },
    tags: ["demo"],
    plugins: {},
    sectionIndexVersion: "v1",
  };

  return {
    ...base,
    ...overrides,
  };
}

function makeSection(noteId: string, sectionId: string, position: number): NoteSection {
  return {
    noteId,
    sectionId,
    headingText: `Section ${position + 1}`,
    headingLevel: 2,
    fallbackPath: [`Section ${position + 1}`],
    startNodeIndex: position,
    endNodeIndex: position,
    position,
  };
}

function makeProposal(proposalId: string, status: Proposal["status"]): Proposal {
  return {
    id: proposalId,
    schemaVersion: "v1",
    status,
    createdAt: "2026-02-07T00:00:00.000Z",
    updatedAt: "2026-02-07T00:05:00.000Z",
    actor: { kind: "agent", id: "agent-1" },
    target: {
      noteId: "note-1",
      sectionId: "sec-1",
      fallbackPath: ["Section 1"],
    },
    proposalType: "replace_section",
    contentRef: "content.json",
    rationale: "Improve readability",
  };
}

function makeEvent(eventId: string): RemEvent {
  return {
    eventId,
    schemaVersion: "v1",
    timestamp: "2026-02-07T00:10:00.000Z",
    type: "proposal.created",
    actor: { kind: "agent", id: "agent-1" },
    entity: { kind: "proposal", id: "proposal-1" },
    payload: {
      proposalId: "proposal-1",
    },
  };
}

function makeCustomEvent(input: {
  eventId: string;
  timestamp: string;
  type: string;
  actorKind: "human" | "agent";
  actorId?: string;
  entityKind: "note" | "proposal" | "draft" | "plugin";
  entityId: string;
}): RemEvent {
  return {
    eventId: input.eventId,
    schemaVersion: "v1",
    timestamp: input.timestamp,
    type: input.type,
    actor: {
      kind: input.actorKind,
      id: input.actorId,
    },
    entity: {
      kind: input.entityKind,
      id: input.entityId,
    },
    payload: {
      entityId: input.entityId,
    },
  };
}

function makeDraftMeta(draftId: string, updatedAt: string): DraftMeta {
  return {
    id: draftId,
    schemaVersion: "v1",
    createdAt: "2026-02-07T00:00:00.000Z",
    updatedAt,
    author: { kind: "agent", id: "agent-1" },
    targetNoteId: "note-1",
    title: `Draft ${draftId}`,
    tags: ["draft"],
  };
}

function makeDraftState(text: string): LexicalState {
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

function makePluginManifest(namespace: string, schemaVersion: string): PluginManifest {
  return {
    namespace,
    schemaVersion,
    payloadSchema: {
      type: "object",
      required: ["board"],
      properties: {
        board: {
          type: "string",
        },
      },
      additionalProperties: false,
    },
  };
}

describe("RemIndex proposal and section indexing", () => {
  test("upserts and lists sections by note", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-index-sections-"));
    const dbPath = path.join(workspace, "rem.db");
    const index = new RemIndex(dbPath);

    try {
      index.upsertSections("note-1", [
        makeSection("note-1", "sec-1", 0),
        makeSection("note-1", "sec-2", 1),
      ]);

      const sections = index.listSections("note-1");
      expect(sections.length).toBe(2);
      expect(sections[0]?.sectionId).toBe("sec-1");
      expect(sections[1]?.sectionId).toBe("sec-2");
    } finally {
      index.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("upserts and filters proposals by status", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-index-proposals-"));
    const dbPath = path.join(workspace, "rem.db");
    const index = new RemIndex(dbPath);

    try {
      index.upsertProposal(makeProposal("proposal-open", "open"));
      index.upsertProposal(makeProposal("proposal-rejected", "rejected"));

      const open = index.listProposals("open");
      const all = index.listProposals();

      expect(open.length).toBe(1);
      expect(open[0]?.id).toBe("proposal-open");
      expect(all.length).toBe(2);
    } finally {
      index.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("tracks proposal counts in stats while preserving note search", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-index-stats-"));
    const dbPath = path.join(workspace, "rem.db");
    const index = new RemIndex(dbPath);

    try {
      index.upsertNote(makeNoteMeta("note-1"), "alpha bravo");
      index.upsertProposal(makeProposal("proposal-1", "open"));
      index.insertEvent(makeEvent("event-1"));

      const search = index.search("alpha");
      const stats = index.getStats();

      expect(search.length).toBe(1);
      expect(search[0]?.id).toBe("note-1");
      expect(stats.noteCount).toBe(1);
      expect(stats.proposalCount).toBe(1);
      expect(stats.eventCount).toBe(1);
    } finally {
      index.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("lists indexed events with ordering and filters", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-index-events-query-"));
    const dbPath = path.join(workspace, "rem.db");
    const index = new RemIndex(dbPath);

    try {
      index.insertEvent(
        makeCustomEvent({
          eventId: "event-note",
          timestamp: "2026-02-07T00:00:00.000Z",
          type: "note.created",
          actorKind: "human",
          actorId: "human-1",
          entityKind: "note",
          entityId: "note-1",
        }),
      );
      index.insertEvent(
        makeCustomEvent({
          eventId: "event-proposal",
          timestamp: "2026-02-07T00:01:00.000Z",
          type: "proposal.created",
          actorKind: "agent",
          actorId: "agent-1",
          entityKind: "proposal",
          entityId: "proposal-1",
        }),
      );
      index.insertEvent(
        makeCustomEvent({
          eventId: "event-draft",
          timestamp: "2026-02-07T00:02:00.000Z",
          type: "draft.updated",
          actorKind: "agent",
          actorId: "agent-1",
          entityKind: "draft",
          entityId: "draft-1",
        }),
      );

      const latestFirst = index.listEvents();
      expect(latestFirst.map((event) => event.eventId)).toEqual([
        "event-draft",
        "event-proposal",
        "event-note",
      ]);

      const sinceFiltered = index.listEvents({
        since: "2026-02-07T00:01:00.000Z",
      });
      expect(sinceFiltered.map((event) => event.eventId)).toEqual([
        "event-draft",
        "event-proposal",
      ]);

      const agentProposal = index.listEvents({
        actorKind: "agent",
        actorId: "agent-1",
        type: "proposal.created",
        entityKind: "proposal",
      });
      expect(agentProposal.length).toBe(1);
      expect(agentProposal[0]?.eventId).toBe("event-proposal");
    } finally {
      index.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("applies tag and updated-time filters during search", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-index-search-filters-"));
    const dbPath = path.join(workspace, "rem.db");
    const index = new RemIndex(dbPath);

    try {
      index.upsertNote(
        makeNoteMeta("note-ops", {
          title: "Ops Note",
          noteType: "task",
          tags: ["ops", "daily"],
          plugins: {
            tasks: {
              board: "infra",
            },
          },
          createdAt: "2026-02-07T00:01:00.000Z",
          updatedAt: "2026-02-07T00:10:00.000Z",
        }),
        "deploy alpha",
      );
      index.upsertNote(
        makeNoteMeta("note-engineering", {
          title: "Engineering Note",
          noteType: "meeting",
          tags: ["engineering"],
          plugins: {
            meetings: {
              room: "alpha",
            },
          },
          createdAt: "2026-02-07T00:02:00.000Z",
          updatedAt: "2026-02-07T00:20:00.000Z",
        }),
        "deploy alpha",
      );
      index.upsertNote(
        makeNoteMeta("note-ops-late", {
          title: "Ops Late",
          noteType: "task",
          tags: ["ops"],
          plugins: {},
          createdAt: "2026-02-07T00:03:00.000Z",
          updatedAt: "2026-02-07T00:30:00.000Z",
        }),
        "deploy alpha",
      );

      const opsOnly = index.search("deploy", {
        tags: ["ops"],
      });
      expect(opsOnly.map((item) => item.id)).toEqual(["note-ops-late", "note-ops"]);

      const opsAndDaily = index.search("deploy", {
        tags: ["ops", "daily"],
      });
      expect(opsAndDaily.map((item) => item.id)).toEqual(["note-ops"]);

      const recentWindow = index.search("deploy", {
        updatedSince: "2026-02-07T00:15:00.000Z",
        updatedUntil: "2026-02-07T00:25:00.000Z",
      });
      expect(recentWindow.map((item) => item.id)).toEqual(["note-engineering"]);

      const createdWindow = index.search("deploy", {
        createdSince: "2026-02-07T00:02:00.000Z",
        createdUntil: "2026-02-07T00:03:00.000Z",
      });
      expect(createdWindow.map((item) => item.id)).toEqual(["note-ops-late", "note-engineering"]);

      const createdAndUpdated = index.search("deploy", {
        createdSince: "2026-02-07T00:02:00.000Z",
        createdUntil: "2026-02-07T00:03:00.000Z",
        updatedSince: "2026-02-07T00:25:00.000Z",
      });
      expect(createdAndUpdated.map((item) => item.id)).toEqual(["note-ops-late"]);

      const taskTypeOnly = index.search("deploy", {
        noteTypes: ["task"],
      });
      expect(taskTypeOnly.map((item) => item.id)).toEqual(["note-ops-late", "note-ops"]);

      const pluginNamespaceOnly = index.search("deploy", {
        pluginNamespaces: ["tasks"],
      });
      expect(pluginNamespaceOnly.map((item) => item.id)).toEqual(["note-ops"]);

      const combined = index.search("deploy", {
        tags: ["ops"],
        noteTypes: ["task"],
        pluginNamespaces: ["tasks"],
      });
      expect(combined.map((item) => item.id)).toEqual(["note-ops"]);
    } finally {
      index.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("upserts drafts and lists summaries by updated timestamp", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-index-drafts-"));
    const dbPath = path.join(workspace, "rem.db");
    const index = new RemIndex(dbPath);

    try {
      index.upsertDraft(
        "draft-a",
        makeDraftState("draft A"),
        makeDraftMeta("draft-a", "2026-02-07T00:05:00.000Z"),
      );
      index.upsertDraft(
        "draft-b",
        makeDraftState("draft B"),
        makeDraftMeta("draft-b", "2026-02-07T00:10:00.000Z"),
      );

      const summaries = index.listDrafts();
      expect(summaries.map((draft) => draft.id)).toEqual(["draft-b", "draft-a"]);
      expect(summaries[0]?.title).toBe("Draft draft-b");

      const draft = index.getDraft("draft-a");
      expect(draft?.id).toBe("draft-a");
      expect(draft?.meta.author.kind).toBe("agent");
    } finally {
      index.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("upserts and lists plugin manifests", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-index-plugins-"));
    const dbPath = path.join(workspace, "rem.db");
    const index = new RemIndex(dbPath);

    try {
      index.upsertPluginManifest(
        "tasks",
        "v1",
        "2026-02-07T00:00:00.000Z",
        "2026-02-07T00:00:00.000Z",
        makePluginManifest("tasks", "v1"),
      );
      index.upsertPluginManifest(
        "meetings",
        "v2",
        "2026-02-07T00:00:00.000Z",
        "2026-02-07T00:05:00.000Z",
        makePluginManifest("meetings", "v2"),
      );

      const manifests = index.listPluginManifests();
      expect(manifests.map((item) => item.namespace)).toEqual(["meetings", "tasks"]);
      expect(manifests[0]?.manifest.schemaVersion).toBe("v2");
    } finally {
      index.close();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
