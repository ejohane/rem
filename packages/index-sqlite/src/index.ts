import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
  DraftMeta,
  LexicalState,
  NoteMeta,
  NoteSection,
  PluginManifest,
  Proposal,
  ProposalStatus,
  RemEvent,
} from "@rem/schemas";

export interface IndexStats {
  noteCount: number;
  proposalCount: number;
  eventCount: number;
  draftCount: number;
  pluginCount: number;
}

export interface SearchResult {
  id: string;
  title: string;
  updatedAt: string;
  snippet: string;
}

export interface SearchFilters {
  limit?: number;
  tags?: string[];
  noteTypes?: string[];
  pluginNamespaces?: string[];
  createdSince?: string;
  createdUntil?: string;
  updatedSince?: string;
  updatedUntil?: string;
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

export interface IndexedDraftSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  authorKind: RemEvent["actor"]["kind"];
  authorId: string | null;
  targetNoteId: string | null;
  title: string;
  tags: string[];
}

export interface IndexedDraftRecord {
  id: string;
  note: LexicalState;
  meta: DraftMeta;
}

export interface IndexedPluginManifest {
  namespace: string;
  schemaVersion: string;
  registeredAt: string;
  updatedAt: string;
  manifest: PluginManifest;
}

export interface EventQueryInput {
  since?: string;
  limit?: number;
  type?: string;
  actorKind?: RemEvent["actor"]["kind"];
  actorId?: string;
  entityKind?: RemEvent["entity"]["kind"];
  entityId?: string;
}

export interface IndexedEvent {
  eventId: string;
  timestamp: string;
  type: string;
  actorKind: RemEvent["actor"]["kind"];
  actorId: string | null;
  entityKind: RemEvent["entity"]["kind"];
  entityId: string;
  payload: Record<string, unknown>;
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

function parsePayloadJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed payloads and return empty object.
  }

  return {};
}

function dedupeStrings(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return parsed;
    }
  } catch {
    // Ignore malformed arrays and return empty list.
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

      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        author_id TEXT,
        target_note_id TEXT,
        title TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        note_json TEXT NOT NULL,
        meta_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC);

      CREATE TABLE IF NOT EXISTS plugins (
        namespace TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        manifest_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plugins_updated ON plugins(updated_at DESC);

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

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type_timestamp ON events(type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_actor_timestamp ON events(actor_kind, actor_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_entity_timestamp ON events(entity_kind, entity_id, timestamp DESC);
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

  upsertDraft(draftId: string, note: LexicalState, meta: DraftMeta): void {
    this.db
      .query(
        `INSERT INTO drafts (
          id,
          created_at,
          updated_at,
          author_kind,
          author_id,
          target_note_id,
          title,
          tags_json,
          note_json,
          meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          author_kind = excluded.author_kind,
          author_id = excluded.author_id,
          target_note_id = excluded.target_note_id,
          title = excluded.title,
          tags_json = excluded.tags_json,
          note_json = excluded.note_json,
          meta_json = excluded.meta_json`,
      )
      .run(
        draftId,
        meta.createdAt,
        meta.updatedAt,
        meta.author.kind,
        meta.author.id ?? null,
        meta.targetNoteId ?? null,
        meta.title,
        JSON.stringify(meta.tags),
        JSON.stringify(note),
        JSON.stringify(meta),
      );
  }

  listDrafts(limit = 100): IndexedDraftSummary[] {
    const normalizedLimit = Math.max(1, Math.min(limit, 1000));
    const rows = this.db
      .query(
        `SELECT
          id,
          created_at AS createdAt,
          updated_at AS updatedAt,
          author_kind AS authorKind,
          author_id AS authorId,
          target_note_id AS targetNoteId,
          title,
          tags_json AS tagsJson
        FROM drafts
        ORDER BY updated_at DESC
        LIMIT ?`,
      )
      .all(normalizedLimit) as Array<{
      id: string;
      createdAt: string;
      updatedAt: string;
      authorKind: RemEvent["actor"]["kind"];
      authorId: string | null;
      targetNoteId: string | null;
      title: string;
      tagsJson: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      authorKind: row.authorKind,
      authorId: row.authorId,
      targetNoteId: row.targetNoteId,
      title: row.title,
      tags: parseStringArray(row.tagsJson),
    }));
  }

  getDraft(draftId: string): IndexedDraftRecord | null {
    const row = this.db
      .query(
        `SELECT
          id,
          note_json AS noteJson,
          meta_json AS metaJson
        FROM drafts
        WHERE id = ?
        LIMIT 1`,
      )
      .get(draftId) as {
      id: string;
      noteJson: string;
      metaJson: string;
    } | null;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      note: JSON.parse(row.noteJson) as LexicalState,
      meta: JSON.parse(row.metaJson) as DraftMeta,
    };
  }

  upsertPluginManifest(
    namespace: string,
    schemaVersion: string,
    registeredAt: string,
    updatedAt: string,
    manifest: PluginManifest,
  ): void {
    this.db
      .query(
        `INSERT INTO plugins (
          namespace,
          schema_version,
          registered_at,
          updated_at,
          manifest_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET
          schema_version = excluded.schema_version,
          updated_at = excluded.updated_at,
          manifest_json = excluded.manifest_json`,
      )
      .run(namespace, schemaVersion, registeredAt, updatedAt, JSON.stringify(manifest));
  }

  listPluginManifests(limit = 100): IndexedPluginManifest[] {
    const normalizedLimit = Math.max(1, Math.min(limit, 1000));
    const rows = this.db
      .query(
        `SELECT
          namespace,
          schema_version AS schemaVersion,
          registered_at AS registeredAt,
          updated_at AS updatedAt,
          manifest_json AS manifestJson
        FROM plugins
        ORDER BY namespace ASC
        LIMIT ?`,
      )
      .all(normalizedLimit) as Array<{
      namespace: string;
      schemaVersion: string;
      registeredAt: string;
      updatedAt: string;
      manifestJson: string;
    }>;

    return rows.map((row) => ({
      namespace: row.namespace,
      schemaVersion: row.schemaVersion,
      registeredAt: row.registeredAt,
      updatedAt: row.updatedAt,
      manifest: JSON.parse(row.manifestJson) as PluginManifest,
    }));
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

  listEvents(input?: EventQueryInput): IndexedEvent[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    const limit = Math.max(1, Math.min(input?.limit ?? 100, 1000));

    if (input?.since) {
      clauses.push("timestamp >= ?");
      params.push(input.since);
    }

    if (input?.type) {
      clauses.push("type = ?");
      params.push(input.type);
    }

    if (input?.actorKind) {
      clauses.push("actor_kind = ?");
      params.push(input.actorKind);
    }

    if (input?.actorId) {
      clauses.push("actor_id = ?");
      params.push(input.actorId);
    }

    if (input?.entityKind) {
      clauses.push("entity_kind = ?");
      params.push(input.entityKind);
    }

    if (input?.entityId) {
      clauses.push("entity_id = ?");
      params.push(input.entityId);
    }

    params.push(limit);

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(
        `SELECT
          event_id AS eventId,
          timestamp,
          type,
          actor_kind AS actorKind,
          actor_id AS actorId,
          entity_kind AS entityKind,
          entity_id AS entityId,
          payload_json AS payloadJson
        FROM events
        ${whereClause}
        ORDER BY timestamp DESC, event_id DESC
        LIMIT ?`,
      )
      .all(...params) as Array<{
      eventId: string;
      timestamp: string;
      type: string;
      actorKind: RemEvent["actor"]["kind"];
      actorId: string | null;
      entityKind: RemEvent["entity"]["kind"];
      entityId: string;
      payloadJson: string;
    }>;

    return rows.map((row) => ({
      eventId: row.eventId,
      timestamp: row.timestamp,
      type: row.type,
      actorKind: row.actorKind,
      actorId: row.actorId,
      entityKind: row.entityKind,
      entityId: row.entityId,
      payload: parsePayloadJson(row.payloadJson),
    }));
  }

  search(query: string, filters?: SearchFilters): SearchResult[] {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    const whereClauses = ["notes_fts MATCH ?"];
    const params: SQLQueryBindings[] = [normalized];
    const limit = Math.max(1, Math.min(filters?.limit ?? 20, 1000));

    if (filters?.updatedSince) {
      whereClauses.push("notes.updated_at >= ?");
      params.push(filters.updatedSince);
    }

    if (filters?.updatedUntil) {
      whereClauses.push("notes.updated_at <= ?");
      params.push(filters.updatedUntil);
    }

    if (filters?.createdSince) {
      whereClauses.push("notes.created_at >= ?");
      params.push(filters.createdSince);
    }

    if (filters?.createdUntil) {
      whereClauses.push("notes.created_at <= ?");
      params.push(filters.createdUntil);
    }

    for (const tag of dedupeStrings(filters?.tags)) {
      whereClauses.push(
        "EXISTS (SELECT 1 FROM json_each(notes.tags_json) WHERE json_each.value = ?)",
      );
      params.push(tag);
    }

    for (const noteType of dedupeStrings(filters?.noteTypes)) {
      whereClauses.push("json_extract(notes.meta_json, '$.noteType') = ?");
      params.push(noteType);
    }

    for (const pluginNamespace of dedupeStrings(filters?.pluginNamespaces)) {
      whereClauses.push(
        `EXISTS (
          SELECT 1
          FROM json_each(COALESCE(json_extract(notes.meta_json, '$.plugins'), '{}'))
          WHERE json_each.key = ?
        )`,
      );
      params.push(pluginNamespace);
    }

    params.push(limit);

    return this.db
      .query(
        `SELECT
          notes.id AS id,
          notes.title AS title,
          notes.updated_at AS updatedAt,
          snippet(notes_fts, 2, '[', ']', '…', 20) AS snippet
        FROM notes_fts
        JOIN notes ON notes.id = notes_fts.note_id
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY bm25(notes_fts), notes.updated_at DESC
        LIMIT ?`,
      )
      .all(...params) as SearchResult[];
  }

  getStats(): IndexStats {
    return this.db
      .query(
        `SELECT
          (SELECT COUNT(*) FROM notes) AS noteCount,
          (SELECT COUNT(*) FROM proposals) AS proposalCount,
          (SELECT COUNT(*) FROM events) AS eventCount,
          (SELECT COUNT(*) FROM drafts) AS draftCount,
          (SELECT COUNT(*) FROM plugins) AS pluginCount`,
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
