import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
  NoteMeta,
  NoteSection,
  PluginEntityLink,
  PluginEntityMeta,
  PluginEntityRecord,
  PluginManifest,
  Proposal,
  ProposalStatus,
  RemEvent,
} from "@rem/schemas";

export interface IndexStats {
  noteCount: number;
  proposalCount: number;
  eventCount: number;
  pluginCount: number;
  entityCount: number;
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

export interface IndexedPluginManifest {
  namespace: string;
  schemaVersion: string;
  registeredAt: string;
  updatedAt: string;
  manifest: PluginManifest;
}

export interface IndexedEntity {
  id: string;
  namespace: string;
  entityType: string;
  schemaVersion: string;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
}

export interface EntityQueryInput {
  namespace?: string;
  entityType?: string;
  schemaVersion?: string;
  limit?: number;
}

export interface IndexedEntityLink {
  namespace: string;
  entityType: string;
  entityId: string;
  kind: "note" | "entity";
  noteId: string | null;
  targetNamespace: string | null;
  targetEntityType: string | null;
  targetEntityId: string | null;
}

export interface EntityLinkQueryInput {
  namespace?: string;
  entityType?: string;
  entityId?: string;
  kind?: IndexedEntityLink["kind"];
  noteId?: string;
  targetNamespace?: string;
  targetEntityType?: string;
  targetEntityId?: string;
  limit?: number;
}

export interface EntitySearchResult {
  namespace: string;
  entityType: string;
  entityId: string;
  schemaVersion: string;
  updatedAt: string;
  snippet: string;
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

function readValueByPath(payload: Record<string, unknown>, pathValue: string): unknown {
  const segments = pathValue
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return undefined;
  }

  let current: unknown = payload;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function collectStringLeaves(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      output.push(normalized);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, output);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(nested, output);
    }
  }
}

function buildEntitySearchText(payload: Record<string, unknown>, textFields?: string[]): string {
  const collected: string[] = [];
  if (textFields && textFields.length > 0) {
    for (const textField of dedupeStrings(textFields)) {
      collectStringLeaves(readValueByPath(payload, textField), collected);
    }
  } else {
    collectStringLeaves(payload, collected);
  }

  return collected.join("\n");
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

      CREATE TABLE IF NOT EXISTS plugins (
        namespace TEXT PRIMARY KEY,
        schema_version TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        manifest_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_plugins_updated ON plugins(updated_at DESC);

      CREATE TABLE IF NOT EXISTS entities (
        namespace TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (namespace, entity_type, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_entities_namespace_type_updated ON entities(namespace, entity_type, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_entities_schema_version ON entities(schema_version);

      CREATE TABLE IF NOT EXISTS entity_links (
        namespace TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        link_kind TEXT NOT NULL,
        note_id TEXT,
        target_namespace TEXT,
        target_entity_type TEXT,
        target_entity_id TEXT,
        PRIMARY KEY (
          namespace,
          entity_type,
          entity_id,
          link_kind,
          note_id,
          target_namespace,
          target_entity_type,
          target_entity_id
        ),
        FOREIGN KEY (namespace, entity_type, entity_id) REFERENCES entities(namespace, entity_type, entity_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entity_links_note ON entity_links(note_id);
      CREATE INDEX IF NOT EXISTS idx_entity_links_target ON entity_links(target_namespace, target_entity_type, target_entity_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        namespace UNINDEXED,
        entity_type UNINDEXED,
        entity_id UNINDEXED,
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

  upsertEntity(entity: PluginEntityRecord, meta: PluginEntityMeta, textFields?: string[]): void {
    const dataJson = JSON.stringify(entity.data);
    const searchableText = buildEntitySearchText(entity.data, textFields);
    const links = new Map<string, PluginEntityLink>();

    for (const link of meta.links ?? []) {
      if (link.kind === "note") {
        links.set(`note:${link.noteId}`, link);
        continue;
      }

      links.set(`entity:${link.namespace}:${link.entityType}:${link.entityId}`, link);
    }

    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO entities (
            namespace,
            entity_type,
            entity_id,
            schema_version,
            created_at,
            updated_at,
            data_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(namespace, entity_type, entity_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            updated_at = excluded.updated_at,
            data_json = excluded.data_json`,
        )
        .run(
          entity.namespace,
          entity.entityType,
          entity.id,
          entity.schemaVersion,
          meta.createdAt,
          meta.updatedAt,
          dataJson,
        );

      this.db
        .query(
          `DELETE FROM entity_links
          WHERE namespace = ? AND entity_type = ? AND entity_id = ?`,
        )
        .run(entity.namespace, entity.entityType, entity.id);

      for (const link of links.values()) {
        if (link.kind === "note") {
          this.db
            .query(
              `INSERT INTO entity_links (
                namespace,
                entity_type,
                entity_id,
                link_kind,
                note_id,
                target_namespace,
                target_entity_type,
                target_entity_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              entity.namespace,
              entity.entityType,
              entity.id,
              "note",
              link.noteId,
              null,
              null,
              null,
            );
          continue;
        }

        this.db
          .query(
            `INSERT INTO entity_links (
              namespace,
              entity_type,
              entity_id,
              link_kind,
              note_id,
              target_namespace,
              target_entity_type,
              target_entity_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entity.namespace,
            entity.entityType,
            entity.id,
            "entity",
            null,
            link.namespace,
            link.entityType,
            link.entityId,
          );
      }

      this.db
        .query(
          `DELETE FROM entities_fts
          WHERE namespace = ? AND entity_type = ? AND entity_id = ?`,
        )
        .run(entity.namespace, entity.entityType, entity.id);

      this.db
        .query(
          `INSERT INTO entities_fts (
            namespace,
            entity_type,
            entity_id,
            plain_text
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(entity.namespace, entity.entityType, entity.id, searchableText);
    })();
  }

  listEntities(input?: EntityQueryInput): IndexedEntity[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    const limit = Math.max(1, Math.min(input?.limit ?? 100, 1000));

    if (input?.namespace) {
      clauses.push("namespace = ?");
      params.push(input.namespace);
    }

    if (input?.entityType) {
      clauses.push("entity_type = ?");
      params.push(input.entityType);
    }

    if (input?.schemaVersion) {
      clauses.push("schema_version = ?");
      params.push(input.schemaVersion);
    }

    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = this.db
      .query(
        `SELECT
          namespace,
          entity_type AS entityType,
          entity_id AS entityId,
          schema_version AS schemaVersion,
          created_at AS createdAt,
          updated_at AS updatedAt,
          data_json AS dataJson
        FROM entities
        ${whereClause}
        ORDER BY namespace ASC, entity_type ASC, entity_id ASC
        LIMIT ?`,
      )
      .all(...params) as Array<{
      namespace: string;
      entityType: string;
      entityId: string;
      schemaVersion: string;
      createdAt: string;
      updatedAt: string;
      dataJson: string;
    }>;

    return rows.map((row) => ({
      id: row.entityId,
      namespace: row.namespace,
      entityType: row.entityType,
      schemaVersion: row.schemaVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      data: parsePayloadJson(row.dataJson),
    }));
  }

  listEntityLinks(input?: EntityLinkQueryInput): IndexedEntityLink[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    const limit = Math.max(1, Math.min(input?.limit ?? 1000, 5000));

    if (input?.namespace) {
      clauses.push("namespace = ?");
      params.push(input.namespace);
    }

    if (input?.entityType) {
      clauses.push("entity_type = ?");
      params.push(input.entityType);
    }

    if (input?.entityId) {
      clauses.push("entity_id = ?");
      params.push(input.entityId);
    }

    if (input?.kind) {
      clauses.push("link_kind = ?");
      params.push(input.kind);
    }

    if (input?.noteId) {
      clauses.push("note_id = ?");
      params.push(input.noteId);
    }

    if (input?.targetNamespace) {
      clauses.push("target_namespace = ?");
      params.push(input.targetNamespace);
    }

    if (input?.targetEntityType) {
      clauses.push("target_entity_type = ?");
      params.push(input.targetEntityType);
    }

    if (input?.targetEntityId) {
      clauses.push("target_entity_id = ?");
      params.push(input.targetEntityId);
    }

    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    return this.db
      .query(
        `SELECT
          namespace,
          entity_type AS entityType,
          entity_id AS entityId,
          link_kind AS kind,
          note_id AS noteId,
          target_namespace AS targetNamespace,
          target_entity_type AS targetEntityType,
          target_entity_id AS targetEntityId
        FROM entity_links
        ${whereClause}
        ORDER BY namespace ASC, entity_type ASC, entity_id ASC
        LIMIT ?`,
      )
      .all(...params) as IndexedEntityLink[];
  }

  searchEntities(query: string, input?: EntityQueryInput): EntitySearchResult[] {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    const whereClauses = ["entities_fts MATCH ?"];
    const params: SQLQueryBindings[] = [normalized];
    const limit = Math.max(1, Math.min(input?.limit ?? 20, 1000));

    if (input?.namespace) {
      whereClauses.push("entities.namespace = ?");
      params.push(input.namespace);
    }

    if (input?.entityType) {
      whereClauses.push("entities.entity_type = ?");
      params.push(input.entityType);
    }

    if (input?.schemaVersion) {
      whereClauses.push("entities.schema_version = ?");
      params.push(input.schemaVersion);
    }

    params.push(limit);

    return this.db
      .query(
        `SELECT
          entities.namespace AS namespace,
          entities.entity_type AS entityType,
          entities.entity_id AS entityId,
          entities.schema_version AS schemaVersion,
          entities.updated_at AS updatedAt,
          snippet(entities_fts, 3, '[', ']', '…', 20) AS snippet
        FROM entities_fts
        JOIN entities
          ON entities.namespace = entities_fts.namespace
          AND entities.entity_type = entities_fts.entity_type
          AND entities.entity_id = entities_fts.entity_id
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY bm25(entities_fts), entities.updated_at DESC
        LIMIT ?`,
      )
      .all(...params) as EntitySearchResult[];
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
          (SELECT COUNT(*) FROM plugins) AS pluginCount,
          (SELECT COUNT(*) FROM entities) AS entityCount`,
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
