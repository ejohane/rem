import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  buildSectionIndexFromLexical,
  extractMarkdownFromLexical,
  extractPlainTextFromLexical,
} from "@rem/extractor-lexical";
import { RemIndex, resetIndexDatabase } from "@rem/index-sqlite";
import {
  type Actor,
  type NoteMeta,
  type NoteSection,
  type NoteSectionIndex,
  actorSchema,
  lexicalStateSchema,
  noteMetaSchema,
  noteSectionIndexSchema,
  remEventSchema,
} from "@rem/schemas";
import type { ServiceStatus } from "@rem/shared";
import {
  type StorePaths,
  appendEvent,
  ensureStoreLayout,
  listEventFiles,
  listNoteIds,
  loadNote,
  readEventsFromFile,
  resolveStorePaths,
  saveNote,
} from "@rem/store-fs";

const CORE_SCHEMA_VERSION = "v1";

export interface CoreStatus extends ServiceStatus {
  storeRoot: string;
  notes: number;
  proposals: number;
  events: number;
}

export interface SaveNoteInput {
  id?: string;
  title: string;
  lexicalState: unknown;
  tags?: string[];
  actor?: Actor;
}

export interface SaveNoteResult {
  noteId: string;
  eventId: string;
  created: boolean;
  meta: NoteMeta;
}

export interface CoreSearchResult {
  id: string;
  title: string;
  updatedAt: string;
  snippet: string;
}

export type NoteFormat = "lexical" | "text" | "md";

export interface CoreCanonicalNote {
  noteId: string;
  lexicalState: unknown;
  meta: NoteMeta;
  sectionIndex: NoteSectionIndex;
}

export interface CoreFormattedNote {
  noteId: string;
  format: NoteFormat;
  content: unknown;
  meta: NoteMeta;
}

export interface CoreSectionLookupInput {
  noteId: string;
  sectionId: string;
  fallbackPath?: string[];
}

export interface RemCoreOptions {
  storeRoot?: string;
}

export class RemCore {
  private readonly paths: StorePaths;
  private index: RemIndex;

  private constructor(paths: StorePaths) {
    this.paths = paths;
    this.index = new RemIndex(paths.dbPath);
  }

  static async create(options?: RemCoreOptions): Promise<RemCore> {
    const storeRoot =
      options?.storeRoot ?? process.env.REM_STORE_ROOT ?? path.resolve(process.cwd(), "rem_store");
    const paths = resolveStorePaths(storeRoot);
    await ensureStoreLayout(paths);
    return new RemCore(paths);
  }

  async close(): Promise<void> {
    this.index.close();
  }

  async status(): Promise<CoreStatus> {
    const stats = this.index.getStats();
    return {
      ok: true,
      timestamp: new Date().toISOString(),
      storeRoot: this.paths.root,
      notes: stats.noteCount,
      proposals: stats.proposalCount,
      events: stats.eventCount,
    };
  }

  async saveNote(input: SaveNoteInput): Promise<SaveNoteResult> {
    const actor = actorSchema.parse(input.actor ?? { kind: "human" });
    const note = lexicalStateSchema.parse(input.lexicalState);
    const nowIso = new Date().toISOString();

    const noteId = input.id ?? randomUUID();
    const existing = await loadNote(this.paths, noteId);
    const created = !existing;
    const createdAt = existing?.meta.createdAt ?? nowIso;

    const meta = noteMetaSchema.parse({
      id: noteId,
      schemaVersion: CORE_SCHEMA_VERSION,
      title: input.title,
      createdAt,
      updatedAt: nowIso,
      author: actor,
      tags: input.tags ?? [],
      plugins: existing?.meta.plugins ?? {},
      sectionIndexVersion: "v1",
    });

    const sectionIndex = noteSectionIndexSchema.parse(
      buildSectionIndexFromLexical(noteId, note, {
        schemaVersion: CORE_SCHEMA_VERSION,
      }),
    );

    await saveNote(this.paths, noteId, note, meta, sectionIndex);

    const extracted = extractPlainTextFromLexical(note);
    this.index.upsertNote(meta, extracted);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: created ? "note.created" : "note.updated",
      actor,
      entity: {
        kind: "note",
        id: noteId,
      },
      payload: {
        noteId,
        title: meta.title,
        tags: meta.tags,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      noteId,
      eventId: event.eventId,
      created,
      meta,
    };
  }

  async searchNotes(query: string, limit = 20): Promise<CoreSearchResult[]> {
    return this.index.search(query, limit);
  }

  async getCanonicalNote(noteId: string): Promise<CoreCanonicalNote | null> {
    const stored = await loadNote(this.paths, noteId);
    if (!stored) {
      return null;
    }

    const meta = noteMetaSchema.parse(stored.meta);
    const note = lexicalStateSchema.parse(stored.note);
    const sectionIndex = stored.sectionIndex
      ? noteSectionIndexSchema.parse(stored.sectionIndex)
      : noteSectionIndexSchema.parse(
          buildSectionIndexFromLexical(noteId, note, {
            schemaVersion: CORE_SCHEMA_VERSION,
          }),
        );

    return {
      noteId,
      lexicalState: note,
      meta,
      sectionIndex,
    };
  }

  async getNote(noteId: string, format: NoteFormat = "lexical"): Promise<CoreFormattedNote | null> {
    const canonical = await this.getCanonicalNote(noteId);
    if (!canonical) {
      return null;
    }

    let content: unknown = canonical.lexicalState;
    if (format === "text") {
      content = extractPlainTextFromLexical(canonical.lexicalState);
    } else if (format === "md") {
      content = extractMarkdownFromLexical(canonical.lexicalState);
    }

    return {
      noteId,
      format,
      content,
      meta: canonical.meta,
    };
  }

  async listSections(noteId: string): Promise<NoteSection[] | null> {
    const canonical = await this.getCanonicalNote(noteId);
    if (!canonical) {
      return null;
    }

    return canonical.sectionIndex.sections;
  }

  async findSection(input: CoreSectionLookupInput): Promise<NoteSection | null> {
    const sections = await this.listSections(input.noteId);
    if (!sections) {
      return null;
    }

    const exact = sections.find((section) => section.sectionId === input.sectionId);
    if (exact) {
      return exact;
    }

    if (!input.fallbackPath || input.fallbackPath.length === 0) {
      return null;
    }

    const fallbackKey = input.fallbackPath.join("\u001f");
    return sections.find((section) => section.fallbackPath.join("\u001f") === fallbackKey) ?? null;
  }

  async rebuildIndex(): Promise<CoreStatus> {
    this.index.close();
    await resetIndexDatabase(this.paths.dbPath);
    this.index = new RemIndex(this.paths.dbPath);

    const noteIds = await listNoteIds(this.paths);
    for (const noteId of noteIds) {
      const stored = await loadNote(this.paths, noteId);
      if (!stored) {
        continue;
      }

      const meta = noteMetaSchema.parse(stored.meta);
      const note = lexicalStateSchema.parse(stored.note);
      const sectionIndex = stored.sectionIndex
        ? noteSectionIndexSchema.parse(stored.sectionIndex)
        : noteSectionIndexSchema.parse(
            buildSectionIndexFromLexical(noteId, note, {
              schemaVersion: CORE_SCHEMA_VERSION,
            }),
          );
      await saveNote(this.paths, noteId, note, meta, sectionIndex);
      const extracted = extractPlainTextFromLexical(note);
      this.index.upsertNote(meta, extracted);
    }

    const eventFiles = await listEventFiles(this.paths);
    for (const eventFile of eventFiles) {
      const events = await readEventsFromFile(eventFile);
      for (const event of events) {
        const parsed = remEventSchema.parse(event);
        this.index.insertEvent(parsed);
      }
    }

    return this.status();
  }
}

export const coreVersion = "0.1.0";

let defaultCorePromise: Promise<RemCore> | undefined;

async function getDefaultCore(): Promise<RemCore> {
  defaultCorePromise ??= RemCore.create();
  return defaultCorePromise;
}

export async function getCoreStatus(): Promise<CoreStatus> {
  const core = await getDefaultCore();
  return core.status();
}

export async function saveNoteViaCore(input: SaveNoteInput): Promise<SaveNoteResult> {
  const core = await getDefaultCore();
  return core.saveNote(input);
}

export async function getCanonicalNoteViaCore(noteId: string): Promise<CoreCanonicalNote | null> {
  const core = await getDefaultCore();
  return core.getCanonicalNote(noteId);
}

export async function getNoteViaCore(
  noteId: string,
  format: NoteFormat = "lexical",
): Promise<CoreFormattedNote | null> {
  const core = await getDefaultCore();
  return core.getNote(noteId, format);
}

export async function listSectionsViaCore(noteId: string): Promise<NoteSection[] | null> {
  const core = await getDefaultCore();
  return core.listSections(noteId);
}

export async function findSectionViaCore(
  input: CoreSectionLookupInput,
): Promise<NoteSection | null> {
  const core = await getDefaultCore();
  return core.findSection(input);
}

export async function searchNotesViaCore(query: string, limit = 20): Promise<CoreSearchResult[]> {
  const core = await getDefaultCore();
  return core.searchNotes(query, limit);
}

export async function rebuildIndexViaCore(): Promise<CoreStatus> {
  const core = await getDefaultCore();
  return core.rebuildIndex();
}
