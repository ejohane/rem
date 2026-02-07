import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { NoteMeta, RemEvent } from "@rem/schemas";

export interface IndexStats {
  noteCount: number;
  proposalCount: number;
  eventCount: number;
}

export interface SearchResult {
  id: string;
  title: string;
  updatedAt: string;
  snippet: string;
}

export class RemIndex {
  private readonly db: Database;

  constructor(private readonly dbPath: string) {
    this.db = new Database(dbPath, { create: true, strict: true });
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        meta_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS note_text (
        note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        plain_text TEXT NOT NULL,
        hash TEXT NOT NULL,
        extracted_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        note_id UNINDEXED,
        title,
        plain_text
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertNote(meta: NoteMeta, plainText: string): void {
    const extractedAt = new Date().toISOString();
    const hash = createHash("sha256").update(plainText).digest("hex");
    const tagsJson = JSON.stringify(meta.tags);
    const metaJson = JSON.stringify(meta);

    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO notes (id, title, created_at, updated_at, tags_json, meta_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              updated_at = excluded.updated_at,
              tags_json = excluded.tags_json,
              meta_json = excluded.meta_json`,
        )
        .run(meta.id, meta.title, meta.createdAt, meta.updatedAt, tagsJson, metaJson);

      this.db
        .query(
          `INSERT INTO note_text (note_id, plain_text, hash, extracted_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(note_id) DO UPDATE SET
              plain_text = excluded.plain_text,
              hash = excluded.hash,
              extracted_at = excluded.extracted_at`,
        )
        .run(meta.id, plainText, hash, extractedAt);

      this.db.query("DELETE FROM notes_fts WHERE note_id = ?").run(meta.id);
      this.db
        .query("INSERT INTO notes_fts (note_id, title, plain_text) VALUES (?, ?, ?)")
        .run(meta.id, meta.title, plainText);
    })();
  }

  insertEvent(event: RemEvent): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO events (
          event_id,
          timestamp,
          type,
          actor_kind,
          actor_id,
          entity_kind,
          entity_id,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.timestamp,
        event.type,
        event.actor.kind,
        event.actor.id ?? null,
        event.entity.kind,
        event.entity.id,
        JSON.stringify(event.payload),
      );
  }

  search(query: string, limit = 20): SearchResult[] {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    return this.db
      .query(
        `SELECT
          notes.id AS id,
          notes.title AS title,
          notes.updated_at AS updatedAt,
          snippet(notes_fts, 2, '[', ']', '…', 20) AS snippet
        FROM notes_fts
        JOIN notes ON notes.id = notes_fts.note_id
        WHERE notes_fts MATCH ?
        ORDER BY bm25(notes_fts), notes.updated_at DESC
        LIMIT ?`,
      )
      .all(normalized, limit) as SearchResult[];
  }

  getStats(): IndexStats {
    return this.db
      .query(
        `SELECT
          (SELECT COUNT(*) FROM notes) AS noteCount,
          0 AS proposalCount,
          (SELECT COUNT(*) FROM events) AS eventCount`,
      )
      .get() as IndexStats;
  }
}

export async function resetIndexDatabase(dbPath: string): Promise<void> {
  await mkdir(path.dirname(dbPath), { recursive: true });
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
  ]);
}
