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
  type DraftMeta,
  type LexicalState,
  type NoteMeta,
  type NoteSection,
  type NoteSectionIndex,
  type PluginManifest,
  type PluginMeta,
  type Proposal,
  type ProposalContent,
  type ProposalMeta,
  type ProposalStatus,
  type ProposalTarget,
  type ProposalType,
  type RemEvent,
  actorSchema,
  agentActorSchema,
  draftMetaSchema,
  humanActorSchema,
  lexicalStateSchema,
  noteMetaSchema,
  noteSectionIndexSchema,
  pluginManifestSchema,
  pluginMetaSchema,
  proposalContentSchema,
  proposalMetaSchema,
  proposalSchema,
  proposalStatusSchema,
  proposalTypeSchema,
  remEventSchema,
  sectionTargetSchema,
} from "@rem/schemas";
import type { ServiceStatus } from "@rem/shared";
import {
  type StorePaths,
  appendEvent,
  ensureStoreLayout,
  listDraftIds,
  listEventFiles,
  listNoteIds,
  listProposalIds,
  listPlugins as listStoredPlugins,
  loadDraft,
  loadNote,
  loadProposal,
  loadPlugin as loadStoredPlugin,
  readEventsFromFile,
  resolveStorePaths,
  saveDraft as saveDraftToStore,
  saveNote,
  savePlugin as savePluginToStore,
  saveProposal,
  updateProposalStatus,
} from "@rem/store-fs";

const CORE_SCHEMA_VERSION = "v1";

type LexicalRootLike = {
  root?: {
    children?: unknown;
    [key: string]: unknown;
  };
};

type AnnotationOperations = {
  annotationNodes: unknown[];
  tagsToAdd: string[];
  tagsToRemove: string[];
  titleOverride?: string;
};

export interface CoreStatus extends ServiceStatus {
  storeRoot: string;
  notes: number;
  proposals: number;
  events: number;
  drafts: number;
  plugins: number;
  lastIndexedEventAt: string | null;
  healthHints: string[];
}

export interface SaveNoteInput {
  id?: string;
  title: string;
  noteType?: string;
  lexicalState: unknown;
  tags?: string[];
  plugins?: Record<string, unknown>;
  actor?: Actor;
}

export interface SaveNoteResult {
  noteId: string;
  eventId: string;
  created: boolean;
  meta: NoteMeta;
}

export interface SaveDraftInput {
  id?: string;
  lexicalState: unknown;
  title?: string;
  tags?: string[];
  targetNoteId?: string;
  author?: Actor;
}

export interface SaveDraftResult {
  draftId: string;
  eventId: string;
  created: boolean;
  meta: DraftMeta;
}

export interface ListDraftsInput {
  limit?: number;
}

export interface CoreDraftSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  author: {
    kind: Actor["kind"];
    id?: string;
  };
  targetNoteId?: string;
  title: string;
  tags: string[];
}

export interface CoreDraftRecord {
  draftId: string;
  lexicalState: LexicalState;
  meta: DraftMeta;
}

export interface CoreSearchResult {
  id: string;
  title: string;
  updatedAt: string;
  snippet: string;
}

export interface SearchNotesInput {
  limit?: number;
  tags?: string[];
  noteTypes?: string[];
  pluginNamespaces?: string[];
  updatedSince?: string;
  updatedUntil?: string;
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

export interface CreateProposalInput {
  id?: string;
  actor: Actor;
  target: ProposalTarget;
  proposalType: ProposalType;
  content: {
    format: ProposalContent["format"];
    content: unknown;
    schemaVersion?: string;
  };
  rationale?: string;
  confidence?: number;
  source?: string;
}

export interface CoreProposalRecord {
  proposal: Proposal;
  content: ProposalContent;
  meta: ProposalMeta;
}

export interface CreateProposalResult {
  proposalId: string;
  eventId: string;
  record: CoreProposalRecord;
}

export interface ListProposalsInput {
  status?: ProposalStatus;
}

export interface ListEventsInput {
  since?: string;
  limit?: number;
  type?: string;
  actorKind?: RemEvent["actor"]["kind"];
  actorId?: string;
  entityKind?: RemEvent["entity"]["kind"];
  entityId?: string;
}

export interface CoreEventRecord {
  eventId: string;
  timestamp: string;
  type: string;
  actor: {
    kind: RemEvent["actor"]["kind"];
    id?: string;
  };
  entity: {
    kind: RemEvent["entity"]["kind"];
    id: string;
  };
  payload: Record<string, unknown>;
}

export interface RegisterPluginInput {
  manifest: PluginManifest;
  registrationKind?: "static" | "dynamic";
  actor?: Actor;
}

export interface RegisterPluginResult {
  namespace: string;
  eventId: string;
  created: boolean;
  manifest: PluginManifest;
  meta: PluginMeta;
}

export interface CorePluginRecord {
  manifest: PluginManifest;
  meta: PluginMeta;
}

export interface ProposalActionInput {
  proposalId: string;
  actor?: Actor;
}

export interface ProposalActionResult {
  proposalId: string;
  noteId: string;
  status: ProposalStatus;
  eventId: string;
  noteEventId?: string;
}

export interface RemCoreOptions {
  storeRoot?: string;
}

function extractRootChildren(lexicalState: unknown): unknown[] {
  const state = lexicalState as LexicalRootLike;
  if (!state?.root || !Array.isArray(state.root.children)) {
    return [];
  }

  return state.root.children;
}

function textToReplacementNodes(text: string): unknown[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const normalized = lines.length > 0 ? lines : [""];

  return normalized.map((line) => ({
    type: "paragraph",
    version: 1,
    children: [
      {
        type: "text",
        version: 1,
        text: line,
      },
    ],
  }));
}

function proposalContentToReplacementNodes(content: ProposalContent): unknown[] {
  if (content.format === "text") {
    return textToReplacementNodes(content.content as string);
  }

  if (content.format === "lexical") {
    const parsed = lexicalStateSchema.parse(content.content);
    return extractRootChildren(parsed);
  }

  const jsonPayload = content.content as LexicalRootLike;
  if (jsonPayload && typeof jsonPayload === "object" && Array.isArray(jsonPayload.root?.children)) {
    return jsonPayload.root.children;
  }

  throw new Error("JSON proposal content must include root.children for section replacement");
}

function dedupeNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function parseStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return dedupeNonEmptyStrings(raw.filter((value): value is string => typeof value === "string"));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function doesValueMatchPluginType(
  value: unknown,
  type: "string" | "number" | "boolean" | "object" | "array",
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function assertPluginPayloadMatchesSchema(
  namespace: string,
  payload: unknown,
  schema: PluginManifest["payloadSchema"],
): void {
  if (!isPlainObject(payload)) {
    throw new Error(`Plugin payload for ${namespace} must be an object`);
  }

  for (const requiredField of schema.required) {
    if (!(requiredField in payload)) {
      throw new Error(`Plugin payload for ${namespace} missing required field: ${requiredField}`);
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    const field = schema.properties[key];

    if (!field) {
      if (!schema.additionalProperties) {
        throw new Error(`Plugin payload for ${namespace} has unknown field: ${key}`);
      }
      continue;
    }

    if (!doesValueMatchPluginType(value, field.type)) {
      throw new Error(`Plugin payload for ${namespace}.${key} must be ${field.type}`);
    }

    if (field.type === "array" && field.items && Array.isArray(value)) {
      const itemType = field.items.type;
      const invalidItem = value.find((item) => !doesValueMatchPluginType(item, itemType));
      if (invalidItem !== undefined) {
        throw new Error(`Plugin payload for ${namespace}.${key} must contain ${itemType} values`);
      }
    }
  }
}

function proposalContentToAnnotationOperations(content: ProposalContent): AnnotationOperations {
  if (content.format === "text") {
    return {
      annotationNodes: textToReplacementNodes(content.content as string),
      tagsToAdd: [],
      tagsToRemove: [],
    };
  }

  if (content.format === "lexical") {
    const parsed = lexicalStateSchema.parse(content.content);
    return {
      annotationNodes: extractRootChildren(parsed),
      tagsToAdd: [],
      tagsToRemove: [],
    };
  }

  const payload = content.content;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Annotate proposal JSON content must be an object");
  }

  const jsonPayload = payload as {
    root?: { children?: unknown };
    tagsToAdd?: unknown;
    tagsToRemove?: unknown;
    tags?: { add?: unknown; remove?: unknown };
    setTitle?: unknown;
    title?: unknown;
  };

  const annotationNodes = Array.isArray(jsonPayload.root?.children)
    ? jsonPayload.root.children
    : [];
  const tagsToAdd = dedupeNonEmptyStrings([
    ...parseStringList(jsonPayload.tagsToAdd),
    ...parseStringList(jsonPayload.tags?.add),
  ]);
  const tagsToRemove = dedupeNonEmptyStrings([
    ...parseStringList(jsonPayload.tagsToRemove),
    ...parseStringList(jsonPayload.tags?.remove),
  ]);

  const rawTitle = jsonPayload.setTitle ?? jsonPayload.title;
  const titleOverride =
    typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : undefined;

  if (
    annotationNodes.length === 0 &&
    tagsToAdd.length === 0 &&
    tagsToRemove.length === 0 &&
    !titleOverride
  ) {
    throw new Error(
      "Annotate proposal JSON content must include root.children, tagsToAdd/tagsToRemove, or setTitle/title",
    );
  }

  return {
    annotationNodes,
    tagsToAdd,
    tagsToRemove,
    titleOverride,
  };
}

function replaceSectionInLexicalState(
  lexicalState: unknown,
  section: NoteSection,
  replacementNodes: unknown[],
): unknown {
  const parsed = lexicalStateSchema.parse(lexicalState) as LexicalRootLike;
  const root = parsed.root;

  if (!root || !Array.isArray(root.children)) {
    throw new Error("Target note has invalid lexical root children");
  }

  if (section.startNodeIndex > section.endNodeIndex) {
    throw new Error(`Invalid section bounds for ${section.sectionId}`);
  }

  const nextChildren = [...root.children];
  if (section.endNodeIndex >= nextChildren.length) {
    throw new Error(`Section ${section.sectionId} is out of bounds for target note`);
  }

  nextChildren.splice(
    section.startNodeIndex,
    section.endNodeIndex - section.startNodeIndex + 1,
    ...replacementNodes,
  );

  return {
    ...parsed,
    root: {
      ...root,
      children: nextChildren,
    },
  };
}

function appendToSectionInLexicalState(
  lexicalState: unknown,
  section: NoteSection,
  annotationNodes: unknown[],
): unknown {
  const parsed = lexicalStateSchema.parse(lexicalState) as LexicalRootLike;
  const root = parsed.root;

  if (!root || !Array.isArray(root.children)) {
    throw new Error("Target note has invalid lexical root children");
  }

  if (section.startNodeIndex > section.endNodeIndex) {
    throw new Error(`Invalid section bounds for ${section.sectionId}`);
  }

  const nextChildren = [...root.children];
  if (section.endNodeIndex >= nextChildren.length) {
    throw new Error(`Section ${section.sectionId} is out of bounds for target note`);
  }

  nextChildren.splice(section.endNodeIndex + 1, 0, ...annotationNodes);

  return {
    ...parsed,
    root: {
      ...root,
      children: nextChildren,
    },
  };
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

  private async validatePluginPayloads(plugins: Record<string, unknown>): Promise<void> {
    const namespaces = Object.keys(plugins);
    if (namespaces.length === 0) {
      return;
    }

    for (const namespace of namespaces) {
      const payload = plugins[namespace];
      const stored = await loadStoredPlugin(this.paths, namespace);
      if (!stored) {
        throw new Error(`Plugin not registered: ${namespace}`);
      }

      assertPluginPayloadMatchesSchema(namespace, payload, stored.manifest.payloadSchema);
    }
  }

  async status(): Promise<CoreStatus> {
    const stats = this.index.getStats();
    const latestEvent = this.index.listEvents({ limit: 1 })[0];
    const healthHints: string[] = [];

    if (stats.eventCount === 0) {
      healthHints.push("No indexed events yet; save a note or proposal to populate history.");
    }

    if (stats.eventCount > 0 && stats.noteCount === 0) {
      healthHints.push(
        "Events are indexed but no notes are indexed; run rebuild-index if unexpected.",
      );
    }

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      storeRoot: this.paths.root,
      notes: stats.noteCount,
      proposals: stats.proposalCount,
      events: stats.eventCount,
      drafts: stats.draftCount,
      plugins: stats.pluginCount,
      lastIndexedEventAt: latestEvent?.timestamp ?? null,
      healthHints,
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
    const plugins = input.plugins ?? existing?.meta.plugins ?? {};
    await this.validatePluginPayloads(plugins);

    const meta = noteMetaSchema.parse({
      id: noteId,
      schemaVersion: CORE_SCHEMA_VERSION,
      title: input.title,
      noteType: input.noteType ?? existing?.meta.noteType ?? "note",
      createdAt,
      updatedAt: nowIso,
      author: actor,
      tags: input.tags ?? [],
      plugins,
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
    this.index.upsertSections(noteId, sectionIndex.sections);

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

  async saveDraft(input: SaveDraftInput): Promise<SaveDraftResult> {
    const author = actorSchema.parse(input.author ?? { kind: "agent", id: "core-agent" });
    const note = lexicalStateSchema.parse(input.lexicalState);
    const nowIso = new Date().toISOString();

    const draftId = input.id ?? randomUUID();
    const existing = await loadDraft(this.paths, draftId);
    const created = !existing;
    const createdAt = existing?.meta.createdAt ?? nowIso;

    const meta = draftMetaSchema.parse({
      id: draftId,
      schemaVersion: CORE_SCHEMA_VERSION,
      createdAt,
      updatedAt: nowIso,
      author,
      targetNoteId: input.targetNoteId ?? existing?.meta.targetNoteId,
      title: input.title ?? existing?.meta.title ?? "",
      tags: input.tags ?? existing?.meta.tags ?? [],
    });

    await saveDraftToStore(this.paths, draftId, note, meta);
    this.index.upsertDraft(draftId, note, meta);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: created ? "draft.created" : "draft.updated",
      actor: author,
      entity: {
        kind: "draft",
        id: draftId,
      },
      payload: {
        draftId,
        title: meta.title,
        targetNoteId: meta.targetNoteId,
        tags: meta.tags,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      draftId,
      eventId: event.eventId,
      created,
      meta,
    };
  }

  async getDraft(draftId: string): Promise<CoreDraftRecord | null> {
    const loaded = await loadDraft(this.paths, draftId);
    if (!loaded) {
      return null;
    }

    return {
      draftId,
      lexicalState: lexicalStateSchema.parse(loaded.note),
      meta: draftMetaSchema.parse(loaded.meta),
    };
  }

  async listDrafts(input?: ListDraftsInput): Promise<CoreDraftSummary[]> {
    const drafts = this.index.listDrafts(input?.limit);
    return drafts.map((draft) => ({
      id: draft.id,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      author: {
        kind: draft.authorKind,
        id: draft.authorId ?? undefined,
      },
      targetNoteId: draft.targetNoteId ?? undefined,
      title: draft.title,
      tags: draft.tags,
    }));
  }

  async searchNotes(query: string, input?: SearchNotesInput | number): Promise<CoreSearchResult[]> {
    const normalizedInput =
      typeof input === "number"
        ? {
            limit: input,
          }
        : input;

    return this.index.search(query, normalizedInput);
  }

  async listEvents(input?: ListEventsInput): Promise<CoreEventRecord[]> {
    const indexedEvents = this.index.listEvents(input);
    return indexedEvents.map((event) => ({
      eventId: event.eventId,
      timestamp: event.timestamp,
      type: event.type,
      actor: {
        kind: event.actorKind,
        id: event.actorId ?? undefined,
      },
      entity: {
        kind: event.entityKind,
        id: event.entityId,
      },
      payload: event.payload,
    }));
  }

  async registerPlugin(input: RegisterPluginInput): Promise<RegisterPluginResult> {
    const manifest = pluginManifestSchema.parse(input.manifest);
    const actor = actorSchema.parse(input.actor ?? { kind: "human", id: "plugin-admin" });
    const existing = await loadStoredPlugin(this.paths, manifest.namespace);
    const nowIso = new Date().toISOString();

    const meta = pluginMetaSchema.parse({
      namespace: manifest.namespace,
      schemaVersion: manifest.schemaVersion,
      registeredAt: existing?.meta.registeredAt ?? nowIso,
      updatedAt: nowIso,
      registrationKind: input.registrationKind ?? "dynamic",
    });

    await savePluginToStore(this.paths, manifest, meta);
    this.index.upsertPluginManifest(
      manifest.namespace,
      manifest.schemaVersion,
      meta.registeredAt,
      meta.updatedAt,
      manifest,
    );

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: existing ? "plugin.updated" : "plugin.registered",
      actor,
      entity: {
        kind: "plugin",
        id: manifest.namespace,
      },
      payload: {
        namespace: manifest.namespace,
        schemaVersion: manifest.schemaVersion,
        registrationKind: meta.registrationKind,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      namespace: manifest.namespace,
      eventId: event.eventId,
      created: !existing,
      manifest,
      meta,
    };
  }

  async listPlugins(limit = 100): Promise<CorePluginRecord[]> {
    const indexed = this.index.listPluginManifests(limit);
    if (indexed.length === 0) {
      const stored = await listStoredPlugins(this.paths);
      return stored.map((plugin) => ({
        manifest: plugin.manifest,
        meta: plugin.meta,
      }));
    }

    return indexed.map((plugin) => ({
      manifest: plugin.manifest,
      meta: pluginMetaSchema.parse({
        namespace: plugin.namespace,
        schemaVersion: plugin.schemaVersion,
        registeredAt: plugin.registeredAt,
        updatedAt: plugin.updatedAt,
      }),
    }));
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
    const indexedSections = this.index.listSections(noteId);
    if (indexedSections.length > 0) {
      return indexedSections;
    }

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

  async createProposal(input: CreateProposalInput): Promise<CreateProposalResult> {
    const actor = agentActorSchema.parse(input.actor);
    const target = sectionTargetSchema.parse(input.target);
    const proposalType = proposalTypeSchema.parse(input.proposalType);
    const nowIso = new Date().toISOString();

    const targetNote = await this.getCanonicalNote(target.noteId);
    if (!targetNote) {
      throw new Error(`Target note not found: ${target.noteId}`);
    }

    const targetSection = await this.findSection({
      noteId: target.noteId,
      sectionId: target.sectionId,
      fallbackPath: target.fallbackPath,
    });

    if (!targetSection) {
      throw new Error(`Target section not found: ${target.sectionId}`);
    }

    const proposalId = input.id ?? randomUUID();

    const proposal = proposalSchema.parse({
      id: proposalId,
      schemaVersion: CORE_SCHEMA_VERSION,
      status: "open",
      createdAt: nowIso,
      updatedAt: nowIso,
      actor,
      target,
      proposalType,
      contentRef: "content.json",
      rationale: input.rationale,
      confidence: input.confidence,
      source: input.source,
    });

    const content = proposalContentSchema.parse({
      schemaVersion: input.content.schemaVersion ?? CORE_SCHEMA_VERSION,
      format: input.content.format,
      content: input.content.content,
    });

    const meta = proposalMetaSchema.parse({
      id: proposalId,
      schemaVersion: CORE_SCHEMA_VERSION,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: actor,
      source: input.source,
    });

    await saveProposal(this.paths, proposal, content, meta);
    this.index.upsertProposal(proposal);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "proposal.created",
      actor,
      entity: {
        kind: "proposal",
        id: proposalId,
      },
      payload: {
        proposalId,
        noteId: proposal.target.noteId,
        sectionId: proposal.target.sectionId,
        proposalType: proposal.proposalType,
        status: proposal.status,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      proposalId,
      eventId: event.eventId,
      record: {
        proposal,
        content,
        meta,
      },
    };
  }

  async listProposals(input?: ListProposalsInput): Promise<CoreProposalRecord[]> {
    const statusFilter = input?.status ? proposalStatusSchema.parse(input.status) : undefined;
    const indexed = this.index.listProposals(statusFilter);
    const records = await Promise.all(indexed.map(async (item) => this.getProposal(item.id)));
    return records.filter((item): item is CoreProposalRecord => item !== null);
  }

  async getProposal(proposalId: string): Promise<CoreProposalRecord | null> {
    const loaded = await loadProposal(this.paths, proposalId);
    if (!loaded) {
      return null;
    }

    return {
      proposal: loaded.proposal,
      content: loaded.content,
      meta: loaded.meta,
    };
  }

  async acceptProposal(input: ProposalActionInput): Promise<ProposalActionResult | null> {
    const actor = humanActorSchema.parse(input.actor ?? { kind: "human" });
    const record = await this.getProposal(input.proposalId);
    if (!record) {
      return null;
    }

    if (record.proposal.status !== "open") {
      throw new Error(`Cannot accept proposal in status ${record.proposal.status}`);
    }

    const targetNote = await this.getCanonicalNote(record.proposal.target.noteId);
    if (!targetNote) {
      throw new Error(`Target note not found: ${record.proposal.target.noteId}`);
    }

    const targetSection = await this.findSection({
      noteId: record.proposal.target.noteId,
      sectionId: record.proposal.target.sectionId,
      fallbackPath: record.proposal.target.fallbackPath,
    });

    if (!targetSection) {
      throw new Error(`Target section not found: ${record.proposal.target.sectionId}`);
    }

    const nowIso = new Date().toISOString();
    let nextLexicalState = lexicalStateSchema.parse(targetNote.lexicalState);
    let nextMeta = noteMetaSchema.parse({
      ...targetNote.meta,
      updatedAt: nowIso,
      author: actor,
    });

    let applyDetails: Record<string, unknown>;

    if (record.proposal.proposalType === "replace_section") {
      const replacementNodes = proposalContentToReplacementNodes(record.content);
      nextLexicalState = lexicalStateSchema.parse(
        replaceSectionInLexicalState(targetNote.lexicalState, targetSection, replacementNodes),
      );
      applyDetails = {
        applyMode: "replace_section",
        replacementNodeCount: replacementNodes.length,
      };
    } else if (record.proposal.proposalType === "annotate") {
      const annotationOps = proposalContentToAnnotationOperations(record.content);
      if (annotationOps.annotationNodes.length > 0) {
        nextLexicalState = lexicalStateSchema.parse(
          appendToSectionInLexicalState(
            targetNote.lexicalState,
            targetSection,
            annotationOps.annotationNodes,
          ),
        );
      }

      const removedTagSet = new Set(annotationOps.tagsToRemove);
      const mergedTags = dedupeNonEmptyStrings([
        ...targetNote.meta.tags.filter((tag) => !removedTagSet.has(tag)),
        ...annotationOps.tagsToAdd,
      ]);

      nextMeta = noteMetaSchema.parse({
        ...targetNote.meta,
        updatedAt: nowIso,
        author: actor,
        title: annotationOps.titleOverride ?? targetNote.meta.title,
        tags: mergedTags,
      });

      applyDetails = {
        applyMode: "annotate",
        annotationNodeCount: annotationOps.annotationNodes.length,
        tagsAdded: annotationOps.tagsToAdd,
        tagsRemoved: annotationOps.tagsToRemove,
        titleUpdated:
          annotationOps.titleOverride !== undefined &&
          annotationOps.titleOverride !== targetNote.meta.title,
      };
    } else {
      throw new Error(`Unsupported proposal type for accept: ${record.proposal.proposalType}`);
    }

    const nextSectionIndex = noteSectionIndexSchema.parse(
      buildSectionIndexFromLexical(targetNote.noteId, nextLexicalState, {
        schemaVersion: CORE_SCHEMA_VERSION,
      }),
    );

    await saveNote(this.paths, targetNote.noteId, nextLexicalState, nextMeta, nextSectionIndex);
    this.index.upsertNote(nextMeta, extractPlainTextFromLexical(nextLexicalState));
    this.index.upsertSections(targetNote.noteId, nextSectionIndex.sections);

    const nextProposal = await updateProposalStatus(
      this.paths,
      input.proposalId,
      "accepted",
      nowIso,
    );
    if (!nextProposal) {
      throw new Error(`Proposal not found during accept transition: ${input.proposalId}`);
    }
    this.index.upsertProposal(nextProposal.proposal);

    const acceptedEvent = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "proposal.accepted",
      actor,
      entity: {
        kind: "proposal",
        id: input.proposalId,
      },
      payload: {
        proposalId: input.proposalId,
        noteId: targetNote.noteId,
        sectionId: nextProposal.proposal.target.sectionId,
        proposalType: nextProposal.proposal.proposalType,
        status: nextProposal.proposal.status,
        ...applyDetails,
      },
    });

    const noteUpdatedEvent = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "note.updated",
      actor,
      entity: {
        kind: "note",
        id: targetNote.noteId,
      },
      payload: {
        noteId: targetNote.noteId,
        title: nextMeta.title,
        tags: nextMeta.tags,
        sourceProposalId: input.proposalId,
        sourceProposalType: nextProposal.proposal.proposalType,
        ...applyDetails,
      },
    });

    await appendEvent(this.paths, acceptedEvent);
    await appendEvent(this.paths, noteUpdatedEvent);
    this.index.insertEvent(acceptedEvent);
    this.index.insertEvent(noteUpdatedEvent);

    return {
      proposalId: input.proposalId,
      noteId: targetNote.noteId,
      status: "accepted",
      eventId: acceptedEvent.eventId,
      noteEventId: noteUpdatedEvent.eventId,
    };
  }

  async rejectProposal(input: ProposalActionInput): Promise<ProposalActionResult | null> {
    const actor = humanActorSchema.parse(input.actor ?? { kind: "human" });
    const record = await this.getProposal(input.proposalId);
    if (!record) {
      return null;
    }

    if (record.proposal.status !== "open") {
      throw new Error(`Cannot reject proposal in status ${record.proposal.status}`);
    }

    const nowIso = new Date().toISOString();
    const nextProposal = await updateProposalStatus(
      this.paths,
      input.proposalId,
      "rejected",
      nowIso,
    );

    if (!nextProposal) {
      throw new Error(`Proposal not found during reject transition: ${input.proposalId}`);
    }
    this.index.upsertProposal(nextProposal.proposal);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "proposal.rejected",
      actor,
      entity: {
        kind: "proposal",
        id: input.proposalId,
      },
      payload: {
        proposalId: input.proposalId,
        noteId: nextProposal.proposal.target.noteId,
        sectionId: nextProposal.proposal.target.sectionId,
        proposalType: nextProposal.proposal.proposalType,
        status: nextProposal.proposal.status,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      proposalId: input.proposalId,
      noteId: nextProposal.proposal.target.noteId,
      status: "rejected",
      eventId: event.eventId,
    };
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
      this.index.upsertSections(noteId, sectionIndex.sections);
    }

    const proposalIds = await listProposalIds(this.paths);
    for (const proposalId of proposalIds) {
      const proposal = await loadProposal(this.paths, proposalId);
      if (!proposal) {
        continue;
      }
      this.index.upsertProposal(proposal.proposal);
    }

    const draftIds = await listDraftIds(this.paths);
    for (const draftId of draftIds) {
      const draft = await loadDraft(this.paths, draftId);
      if (!draft) {
        continue;
      }

      const parsedNote = lexicalStateSchema.parse(draft.note);
      const parsedMeta = draftMetaSchema.parse(draft.meta);
      this.index.upsertDraft(draftId, parsedNote, parsedMeta);
    }

    const plugins = await listStoredPlugins(this.paths);
    for (const plugin of plugins) {
      const manifest = pluginManifestSchema.parse(plugin.manifest);
      const meta = pluginMetaSchema.parse(plugin.meta);
      this.index.upsertPluginManifest(
        manifest.namespace,
        manifest.schemaVersion,
        meta.registeredAt,
        meta.updatedAt,
        manifest,
      );
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

export async function saveDraftViaCore(input: SaveDraftInput): Promise<SaveDraftResult> {
  const core = await getDefaultCore();
  return core.saveDraft(input);
}

export async function getDraftViaCore(draftId: string): Promise<CoreDraftRecord | null> {
  const core = await getDefaultCore();
  return core.getDraft(draftId);
}

export async function listDraftsViaCore(input?: ListDraftsInput): Promise<CoreDraftSummary[]> {
  const core = await getDefaultCore();
  return core.listDrafts(input);
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

export async function createProposalViaCore(
  input: CreateProposalInput,
): Promise<CreateProposalResult> {
  const core = await getDefaultCore();
  return core.createProposal(input);
}

export async function listProposalsViaCore(
  input?: ListProposalsInput,
): Promise<CoreProposalRecord[]> {
  const core = await getDefaultCore();
  return core.listProposals(input);
}

export async function getProposalViaCore(proposalId: string): Promise<CoreProposalRecord | null> {
  const core = await getDefaultCore();
  return core.getProposal(proposalId);
}

export async function acceptProposalViaCore(
  input: ProposalActionInput,
): Promise<ProposalActionResult | null> {
  const core = await getDefaultCore();
  return core.acceptProposal(input);
}

export async function rejectProposalViaCore(
  input: ProposalActionInput,
): Promise<ProposalActionResult | null> {
  const core = await getDefaultCore();
  return core.rejectProposal(input);
}

export async function searchNotesViaCore(
  query: string,
  input?: SearchNotesInput | number,
): Promise<CoreSearchResult[]> {
  const core = await getDefaultCore();
  return core.searchNotes(query, input);
}

export async function listEventsViaCore(input?: ListEventsInput): Promise<CoreEventRecord[]> {
  const core = await getDefaultCore();
  return core.listEvents(input);
}

export async function registerPluginViaCore(
  input: RegisterPluginInput,
): Promise<RegisterPluginResult> {
  const core = await getDefaultCore();
  return core.registerPlugin(input);
}

export async function listPluginsViaCore(limit = 100): Promise<CorePluginRecord[]> {
  const core = await getDefaultCore();
  return core.listPlugins(limit);
}

export async function rebuildIndexViaCore(): Promise<CoreStatus> {
  const core = await getDefaultCore();
  return core.rebuildIndex();
}
