import { appendFile, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import type { LexicalState, NoteMeta, RemEvent } from "@rem/schemas";

export interface StorePaths {
  root: string;
  notesDir: string;
  eventsDir: string;
  indexDir: string;
  dbPath: string;
}

export interface StoredNote {
  note: LexicalState;
  meta: NoteMeta;
}

export function resolveStorePaths(root: string): StorePaths {
  const normalizedRoot = path.resolve(root);

  return {
    root: normalizedRoot,
    notesDir: path.join(normalizedRoot, "notes"),
    eventsDir: path.join(normalizedRoot, "events"),
    indexDir: path.join(normalizedRoot, "index"),
    dbPath: path.join(normalizedRoot, "index", "rem.db"),
  };
}

export async function ensureStoreLayout(paths: StorePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.notesDir, { recursive: true }),
    mkdir(paths.eventsDir, { recursive: true }),
    mkdir(paths.indexDir, { recursive: true }),
  ]);
}

async function writeAtomicFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, "w");

  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tempPath, filePath);
}

export async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await writeAtomicFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function saveNote(
  paths: StorePaths,
  noteId: string,
  note: LexicalState,
  meta: NoteMeta,
): Promise<void> {
  const noteDir = path.join(paths.notesDir, noteId);
  await mkdir(noteDir, { recursive: true });

  await Promise.all([
    writeJsonAtomic(path.join(noteDir, "note.json"), note),
    writeJsonAtomic(path.join(noteDir, "meta.json"), meta),
  ]);
}

export async function loadNote(paths: StorePaths, noteId: string): Promise<StoredNote | null> {
  const noteDir = path.join(paths.notesDir, noteId);
  const notePath = path.join(noteDir, "note.json");
  const metaPath = path.join(noteDir, "meta.json");

  try {
    const [noteRaw, metaRaw] = await Promise.all([
      readFile(notePath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);

    return {
      note: JSON.parse(noteRaw) as LexicalState,
      meta: JSON.parse(metaRaw) as NoteMeta,
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function listNoteIds(paths: StorePaths): Promise<string[]> {
  const entries = await readdir(paths.notesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function appendEvent(paths: StorePaths, event: RemEvent): Promise<string> {
  const day = event.timestamp.slice(0, 10);
  const month = event.timestamp.slice(0, 7);
  const monthDir = path.join(paths.eventsDir, month);
  const filePath = path.join(monthDir, `${day}.jsonl`);

  await mkdir(monthDir, { recursive: true });
  await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  return filePath;
}

export async function listEventFiles(paths: StorePaths): Promise<string[]> {
  const eventFiles: string[] = [];
  const monthEntries = await readdir(paths.eventsDir, { withFileTypes: true });

  for (const monthEntry of monthEntries) {
    if (!monthEntry.isDirectory()) {
      continue;
    }

    const monthDir = path.join(paths.eventsDir, monthEntry.name);
    const dayEntries = await readdir(monthDir, { withFileTypes: true });

    for (const dayEntry of dayEntries) {
      if (!dayEntry.isFile() || !dayEntry.name.endsWith(".jsonl")) {
        continue;
      }

      eventFiles.push(path.join(monthDir, dayEntry.name));
    }
  }

  eventFiles.sort();
  return eventFiles;
}

export async function readEventsFromFile(filePath: string): Promise<RemEvent[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RemEvent);
}
