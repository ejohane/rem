import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { NoteMeta, NoteSection, Proposal, ProposalStatus, RemEvent } from "@rem/schemas";

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

export interface IndexedSection {
  noteId: string;
  sectionId: string;
  fallbackPath: string[];
  headingText: string;
  headingLevel: number;
  startNodeIndex: number;
  endNodeIndex: number;
  position: number;
}

export interface IndexedProposal {
  id: string;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  actorId: string;
  noteId: string;
  sectionId: string;
  proposalType: string;
  rationale: string | null;
}

function parseFallbackPath(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Ignore malformed fallback path payloads and return empty fallback path.
  }

  return [];
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

      CREATE TABLE IF NOT EXISTS sections (
        note_id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        fallback_path_json TEXT NOT NULL,
        heading_text TEXT NOT NULL,
        heading_level INTEGER NOT NULL,
        start_node_index INTEGER NOT NULL,
        end_node_index INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (note_id, section_id)
      );

      CREATE INDEX IF NOT EXISTS idx_sections_note_position ON sections(note_id, position);

      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        note_id TEXT NOT NULL,
        section_id TEXT NOT NULL,
        proposal_type TEXT NOT NULL,
        rationale TEXT,
        proposal_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposals_status_updated ON proposals(status, updated_at DESC);

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

  upsertSections(noteId: string, sections: NoteSection[]): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM sections WHERE note_id = ?").run(noteId);

      for (const section of sections) {
        this.db
          .query(
            `INSERT INTO sections (
              note_id,
              section_id,
              fallback_path_json,
              heading_text,
              heading_level,
              start_node_index,
              end_node_index,
              position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(note_id, section_id) DO UPDATE SET
              fallback_path_json = excluded.fallback_path_json,
              heading_text = excluded.heading_text,
              heading_level = excluded.heading_level,
              start_node_index = excluded.start_node_index,
              end_node_index = excluded.end_node_index,
              position = excluded.position`,
          )
          .run(
            section.noteId,
            section.sectionId,
            JSON.stringify(section.fallbackPath),
            section.headingText,
            section.headingLevel,
            section.startNodeIndex,
            section.endNodeIndex,
            section.position,
          );
      }
    })();
  }

  listSections(noteId: string): IndexedSection[] {
    const rows = this.db
      .query(
        `SELECT
          note_id AS noteId,
          section_id AS sectionId,
          fallback_path_json AS fallbackPathJson,
          heading_text AS headingText,
          heading_level AS headingLevel,
          start_node_index AS startNodeIndex,
          end_node_index AS endNodeIndex,
          position AS position
        FROM sections
        WHERE note_id = ?
        ORDER BY position ASC`,
      )
      .all(noteId) as Array<{
      noteId: string;
      sectionId: string;
      fallbackPathJson: string;
      headingText: string;
      headingLevel: number;
      startNodeIndex: number;
      endNodeIndex: number;
      position: number;
    }>;

    return rows.map((row) => ({
      noteId: row.noteId,
      sectionId: row.sectionId,
      fallbackPath: parseFallbackPath(row.fallbackPathJson),
      headingText: row.headingText,
      headingLevel: row.headingLevel,
      startNodeIndex: row.startNodeIndex,
      endNodeIndex: row.endNodeIndex,
      position: row.position,
    }));
  }

  upsertProposal(proposal: Proposal): void {
    this.db
      .query(
        `INSERT INTO proposals (
          id,
          status,
          created_at,
          updated_at,
          actor_id,
          note_id,
          section_id,
          proposal_type,
          rationale,
          proposal_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          actor_id = excluded.actor_id,
          note_id = excluded.note_id,
          section_id = excluded.section_id,
          proposal_type = excluded.proposal_type,
          rationale = excluded.rationale,
          proposal_json = excluded.proposal_json`,
      )
      .run(
        proposal.id,
        proposal.status,
        proposal.createdAt,
        proposal.updatedAt,
        proposal.actor.id,
        proposal.target.noteId,
        proposal.target.sectionId,
        proposal.proposalType,
        proposal.rationale ?? null,
        JSON.stringify(proposal),
      );
  }

  listProposals(status?: ProposalStatus, limit = 100): IndexedProposal[] {
    if (status) {
      return this.db
        .query(
          `SELECT
            id,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt,
            actor_id AS actorId,
            note_id AS noteId,
            section_id AS sectionId,
            proposal_type AS proposalType,
            rationale
          FROM proposals
          WHERE status = ?
          ORDER BY updated_at DESC
          LIMIT ?`,
        )
        .all(status, limit) as IndexedProposal[];
    }

    return this.db
      .query(
        `SELECT
          id,
          status,
          created_at AS createdAt,
          updated_at AS updatedAt,
          actor_id AS actorId,
          note_id AS noteId,
          section_id AS sectionId,
          proposal_type AS proposalType,
          rationale
        FROM proposals
        ORDER BY updated_at DESC
        LIMIT ?`,
      )
      .all(limit) as IndexedProposal[];
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
          (SELECT COUNT(*) FROM proposals) AS proposalCount,
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
