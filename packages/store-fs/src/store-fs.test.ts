import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RemEvent } from "@rem/schemas";

import {
  appendEvent,
  ensureStoreLayout,
  listEventFiles,
  readEventsFromFile,
  resolveStorePaths,
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
