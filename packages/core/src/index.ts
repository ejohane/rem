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
  type Proposal,
  type ProposalContent,
  type ProposalMeta,
  type ProposalStatus,
  type ProposalTarget,
  type ProposalType,
  actorSchema,
  agentActorSchema,
  humanActorSchema,
  lexicalStateSchema,
  noteMetaSchema,
  noteSectionIndexSchema,
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
  listEventFiles,
  listNoteIds,
  listProposalIds,
  loadNote,
  loadProposal,
  readEventsFromFile,
  resolveStorePaths,
  saveNote,
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

    if (record.proposal.proposalType !== "replace_section") {
      throw new Error(`Unsupported proposal type for accept: ${record.proposal.proposalType}`);
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

    const replacementNodes = proposalContentToReplacementNodes(record.content);
    const nextLexicalState = lexicalStateSchema.parse(
      replaceSectionInLexicalState(targetNote.lexicalState, targetSection, replacementNodes),
    );

    const nowIso = new Date().toISOString();

    const nextMeta = noteMetaSchema.parse({
      ...targetNote.meta,
      updatedAt: nowIso,
      author: actor,
    });

    const nextSectionIndex = noteSectionIndexSchema.parse(
      buildSectionIndexFromLexical(targetNote.noteId, nextLexicalState, {
        schemaVersion: CORE_SCHEMA_VERSION,
      }),
    );

    await saveNote(this.paths, targetNote.noteId, nextLexicalState, nextMeta, nextSectionIndex);
    this.index.upsertNote(nextMeta, extractPlainTextFromLexical(nextLexicalState));

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
        status: nextProposal.proposal.status,
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

export async function searchNotesViaCore(query: string, limit = 20): Promise<CoreSearchResult[]> {
  const core = await getDefaultCore();
  return core.searchNotes(query, limit);
}

export async function rebuildIndexViaCore(): Promise<CoreStatus> {
  const core = await getDefaultCore();
  return core.rebuildIndex();
}
