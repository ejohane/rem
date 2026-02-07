import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
});
