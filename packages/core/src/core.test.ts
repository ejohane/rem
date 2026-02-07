import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
        lexicalState: lexicalStateWithText("First draft"),
        tags: ["sprint"],
        actor: { kind: "human", id: "test-user" },
      });

      await core.saveNote({
        id: created.noteId,
        title: "Sprint Notes",
        lexicalState: lexicalStateWithText("Updated draft"),
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
});
