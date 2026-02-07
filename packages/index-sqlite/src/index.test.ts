import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { NoteMeta, NoteSection, Proposal, RemEvent } from "@rem/schemas";

import { RemIndex } from "./index";

function makeNoteMeta(noteId: string): NoteMeta {
  return {
    id: noteId,
    schemaVersion: "v1",
    title: "Demo Note",
    createdAt: "2026-02-07T00:00:00.000Z",
    updatedAt: "2026-02-07T00:00:00.000Z",
    author: { kind: "human", id: "tester" },
    tags: ["demo"],
    plugins: {},
    sectionIndexVersion: "v1",
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
});
