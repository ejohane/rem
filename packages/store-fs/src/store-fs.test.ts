import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  DraftMeta,
  LexicalState,
  PluginManifest,
  PluginMeta,
  Proposal,
  ProposalContent,
  ProposalMeta,
  RemEvent,
} from "@rem/schemas";

import {
  appendEvent,
  ensureStoreLayout,
  listDraftIds,
  listEventFiles,
  listPlugins,
  listProposalIds,
  loadDraft,
  loadPlugin,
  loadProposal,
  readEventsFromFile,
  resolveStorePaths,
  saveDraft,
  savePlugin,
  saveProposal,
  updateProposalStatus,
} from "./index";

function makeEvent(eventId: string): RemEvent {
  return {
    eventId,
    schemaVersion: "v1",
    timestamp: "2026-02-07T00:00:00.000Z",
    type: "note.created",
    actor: { kind: "human" },
    entity: { kind: "note", id: "note-1" },
    payload: { noteId: "note-1" },
  };
}

function lexicalStateWithText(text: string): LexicalState {
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

function makeProposal(proposalId: string): {
  proposal: Proposal;
  content: ProposalContent;
  meta: ProposalMeta;
} {
  const now = "2026-02-07T00:00:00.000Z";
  return {
    proposal: {
      id: proposalId,
      schemaVersion: "v1",
      status: "open",
      createdAt: now,
      updatedAt: now,
      actor: { kind: "agent", id: "agent-1" },
      target: {
        noteId: "note-1",
        sectionId: "section-1",
        fallbackPath: ["Plan"],
      },
      proposalType: "replace_section",
      contentRef: "content.json",
      rationale: "Improve clarity",
      source: "test-suite",
    },
    content: {
      schemaVersion: "v1",
      format: "text",
      content: "Updated section content",
    },
    meta: {
      id: proposalId,
      schemaVersion: "v1",
      createdAt: now,
      updatedAt: now,
      createdBy: { kind: "agent", id: "agent-1" },
      source: "test-suite",
    },
  };
}

function makeDraftMeta(draftId: string): DraftMeta {
  return {
    id: draftId,
    schemaVersion: "v1",
    createdAt: "2026-02-07T00:00:00.000Z",
    updatedAt: "2026-02-07T00:00:00.000Z",
    author: { kind: "agent", id: "agent-1" },
    targetNoteId: "note-1",
    title: "Draft one",
    tags: ["draft"],
  };
}

function makePluginManifest(namespace: string): PluginManifest {
  return {
    namespace,
    schemaVersion: "v1",
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

function makePluginMeta(namespace: string): PluginMeta {
  return {
    namespace,
    schemaVersion: "v1",
    registeredAt: "2026-02-07T00:00:00.000Z",
    updatedAt: "2026-02-07T00:00:00.000Z",
    registrationKind: "dynamic",
  };
}

describe("store-fs event durability helpers", () => {
  test("readEventsFromFile tolerates truncated final line", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-store-fs-partial-"));
    const filePath = path.join(workspace, "events.jsonl");

    try {
      await writeFile(filePath, `${JSON.stringify(makeEvent("event-1"))}\n{"eventId":"partial`);
      const events = await readEventsFromFile(filePath);

      expect(events.length).toBe(1);
      expect(events[0]?.eventId).toBe("event-1");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("readEventsFromFile throws for invalid non-final line", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rem-store-fs-invalid-"));
    const filePath = path.join(workspace, "events.jsonl");

    try {
      await writeFile(filePath, `{"bad":"line"\n${JSON.stringify(makeEvent("event-2"))}\n`);
      await expect(readEventsFromFile(filePath)).rejects.toThrow("Invalid event JSON");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("appendEvent writes readable JSONL event entries", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-store-fs-append-"));
    const paths = resolveStorePaths(storeRoot);

    try {
      await ensureStoreLayout(paths);
      await appendEvent(paths, makeEvent("event-3"));

      const eventFiles = await listEventFiles(paths);
      expect(eventFiles.length).toBe(1);

      const events = await readEventsFromFile(eventFiles[0] ?? "");
      expect(events.length).toBe(1);
      expect(events[0]?.eventId).toBe("event-3");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});

describe("store-fs proposals and drafts", () => {
  test("saves and loads proposal records", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-store-fs-proposal-"));
    const paths = resolveStorePaths(storeRoot);
    const first = makeProposal("proposal-1");
    const second = makeProposal("proposal-2");

    try {
      await ensureStoreLayout(paths);
      await saveProposal(paths, first.proposal, first.content, first.meta);
      await saveProposal(paths, second.proposal, second.content, second.meta);

      const loaded = await loadProposal(paths, "proposal-1");
      expect(loaded?.proposal.id).toBe("proposal-1");
      expect(loaded?.content.content).toBe("Updated section content");

      const ids = await listProposalIds(paths);
      expect(ids).toEqual(["proposal-1", "proposal-2"]);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("rejects invalid proposal schema payloads", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-store-fs-proposal-invalid-"));
    const paths = resolveStorePaths(storeRoot);
    const invalid = makeProposal("proposal-invalid");

    try {
      await ensureStoreLayout(paths);
      await expect(
        saveProposal(
          paths,
          {
            ...invalid.proposal,
            actor: { kind: "human", id: "human-1" },
          } as unknown as Proposal,
          invalid.content,
          invalid.meta,
        ),
      ).rejects.toThrow();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("updates proposal status with transition guard", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-store-fs-proposal-status-"));
    const paths = resolveStorePaths(storeRoot);
    const proposal = makeProposal("proposal-status");

    try {
      await ensureStoreLayout(paths);
      await saveProposal(paths, proposal.proposal, proposal.content, proposal.meta);

      const accepted = await updateProposalStatus(
        paths,
        proposal.proposal.id,
        "accepted",
        "2026-02-07T00:10:00.000Z",
      );

      expect(accepted?.proposal.status).toBe("accepted");
      expect(accepted?.proposal.updatedAt).toBe("2026-02-07T00:10:00.000Z");

      await expect(updateProposalStatus(paths, proposal.proposal.id, "open")).rejects.toThrow(
        "Invalid proposal status transition",
      );
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("saves and loads drafts", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-store-fs-draft-"));
    const paths = resolveStorePaths(storeRoot);

    try {
      await ensureStoreLayout(paths);
      await saveDraft(
        paths,
        "draft-1",
        lexicalStateWithText("draft content"),
        makeDraftMeta("draft-1"),
      );

      const loaded = await loadDraft(paths, "draft-1");
      expect(loaded?.meta.id).toBe("draft-1");
      expect(loaded?.meta.author.kind).toBe("agent");

      const ids = await listDraftIds(paths);
      expect(ids).toEqual(["draft-1"]);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("saves and lists plugin manifests", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-store-fs-plugin-"));
    const paths = resolveStorePaths(storeRoot);

    try {
      await ensureStoreLayout(paths);
      await savePlugin(paths, makePluginManifest("tasks"), makePluginMeta("tasks"));
      await savePlugin(paths, makePluginManifest("meetings"), makePluginMeta("meetings"));

      const loaded = await loadPlugin(paths, "tasks");
      expect(loaded?.manifest.namespace).toBe("tasks");

      const plugins = await listPlugins(paths);
      expect(plugins.map((plugin) => plugin.manifest.namespace)).toEqual(["meetings", "tasks"]);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
