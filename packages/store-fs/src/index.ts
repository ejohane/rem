import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import {
  type DraftMeta,
  type LexicalState,
  type NoteMeta,
  type Proposal,
  type ProposalContent,
  type ProposalMeta,
  type ProposalStatus,
  type RemEvent,
  draftMetaSchema,
  isProposalStatusTransitionAllowed,
  lexicalStateSchema,
  noteMetaSchema,
  proposalContentSchema,
  proposalMetaSchema,
  proposalSchema,
  proposalStatusSchema,
  remEventSchema,
} from "@rem/schemas";

export interface StorePaths {
  root: string;
  notesDir: string;
  proposalsDir: string;
  draftsDir: string;
  eventsDir: string;
  indexDir: string;
  dbPath: string;
}

export interface StoredNote {
  note: LexicalState;
  meta: NoteMeta;
}

export interface StoredProposal {
  proposal: Proposal;
  content: ProposalContent;
  meta: ProposalMeta;
}

export interface StoredDraft {
  note: LexicalState;
  meta: DraftMeta;
}

function isSkippableDirectorySyncError(error: unknown): boolean {
  const errorCode = (error as NodeJS.ErrnoException).code;
  if (!errorCode) {
    return false;
  }

  return (
    errorCode === "EINVAL" ||
    errorCode === "ENOTSUP" ||
    errorCode === "EACCES" ||
    errorCode === "EPERM" ||
    errorCode === "UNKNOWN"
  );
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
  } catch (error) {
    if (!isSkippableDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function resolveEntityDir(rootDir: string, entityId: string): string {
  if (!entityId || entityId.includes(path.sep) || entityId.includes("..")) {
    throw new Error(`Invalid entity id: ${entityId}`);
  }

  return path.join(rootDir, entityId);
}

function resolveEntityFile(entityDir: string, fileName: string): string {
  if (!fileName || fileName.includes(path.sep) || fileName.includes("..")) {
    throw new Error(`Invalid file name: ${fileName}`);
  }

  return path.join(entityDir, fileName);
}

export function resolveStorePaths(root: string): StorePaths {
  const normalizedRoot = path.resolve(root);

  return {
    root: normalizedRoot,
    notesDir: path.join(normalizedRoot, "notes"),
    proposalsDir: path.join(normalizedRoot, "proposals"),
    draftsDir: path.join(normalizedRoot, "drafts"),
    eventsDir: path.join(normalizedRoot, "events"),
    indexDir: path.join(normalizedRoot, "index"),
    dbPath: path.join(normalizedRoot, "index", "rem.db"),
  };
}

export async function ensureStoreLayout(paths: StorePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.notesDir, { recursive: true }),
    mkdir(paths.proposalsDir, { recursive: true }),
    mkdir(paths.draftsDir, { recursive: true }),
    mkdir(paths.eventsDir, { recursive: true }),
    mkdir(paths.indexDir, { recursive: true }),
  ]);
}

async function writeAtomicFile(filePath: string, content: string): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await mkdir(directoryPath, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tempPath, "w");

  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tempPath, filePath);
  await syncDirectory(directoryPath);
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
  const parsedNote = lexicalStateSchema.parse(note);
  const parsedMeta = noteMetaSchema.parse(meta);
  if (parsedMeta.id !== noteId) {
    throw new Error(`Note meta id ${parsedMeta.id} does not match note id ${noteId}`);
  }

  const noteDir = resolveEntityDir(paths.notesDir, noteId);
  await mkdir(noteDir, { recursive: true });

  await Promise.all([
    writeJsonAtomic(resolveEntityFile(noteDir, "note.json"), parsedNote),
    writeJsonAtomic(resolveEntityFile(noteDir, "meta.json"), parsedMeta),
  ]);
}

export async function loadNote(paths: StorePaths, noteId: string): Promise<StoredNote | null> {
  const noteDir = resolveEntityDir(paths.notesDir, noteId);
  const notePath = resolveEntityFile(noteDir, "note.json");
  const metaPath = resolveEntityFile(noteDir, "meta.json");

  try {
    const [noteRaw, metaRaw] = await Promise.all([
      readFile(notePath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);

    return {
      note: lexicalStateSchema.parse(JSON.parse(noteRaw)),
      meta: noteMetaSchema.parse(JSON.parse(metaRaw)),
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function listEntityIds(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function listNoteIds(paths: StorePaths): Promise<string[]> {
  return listEntityIds(paths.notesDir);
}

export async function saveProposal(
  paths: StorePaths,
  proposal: Proposal,
  content: ProposalContent,
  meta: ProposalMeta,
): Promise<void> {
  const parsedProposal = proposalSchema.parse(proposal);
  const parsedContent = proposalContentSchema.parse(content);
  const parsedMeta = proposalMetaSchema.parse(meta);

  if (parsedProposal.id !== parsedMeta.id) {
    throw new Error(
      `Proposal meta id ${parsedMeta.id} does not match proposal id ${parsedProposal.id}`,
    );
  }

  const proposalDir = resolveEntityDir(paths.proposalsDir, parsedProposal.id);
  await mkdir(proposalDir, { recursive: true });

  await Promise.all([
    writeJsonAtomic(resolveEntityFile(proposalDir, "proposal.json"), parsedProposal),
    writeJsonAtomic(resolveEntityFile(proposalDir, parsedProposal.contentRef), parsedContent),
    writeJsonAtomic(resolveEntityFile(proposalDir, "meta.json"), parsedMeta),
  ]);
}

export async function loadProposal(
  paths: StorePaths,
  proposalId: string,
): Promise<StoredProposal | null> {
  const proposalDir = resolveEntityDir(paths.proposalsDir, proposalId);
  const proposalPath = resolveEntityFile(proposalDir, "proposal.json");
  const metaPath = resolveEntityFile(proposalDir, "meta.json");

  try {
    const [proposalRaw, metaRaw] = await Promise.all([
      readFile(proposalPath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);

    const parsedProposal = proposalSchema.parse(JSON.parse(proposalRaw));
    const parsedMeta = proposalMetaSchema.parse(JSON.parse(metaRaw));
    const contentPath = resolveEntityFile(proposalDir, parsedProposal.contentRef);
    const contentRaw = await readFile(contentPath, "utf8");

    return {
      proposal: parsedProposal,
      content: proposalContentSchema.parse(JSON.parse(contentRaw)),
      meta: parsedMeta,
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function listProposalIds(paths: StorePaths): Promise<string[]> {
  return listEntityIds(paths.proposalsDir);
}

export async function listProposals(paths: StorePaths): Promise<Proposal[]> {
  const ids = await listProposalIds(paths);
  const proposals = await Promise.all(
    ids.map(async (id) => (await loadProposal(paths, id))?.proposal ?? null),
  );

  return proposals
    .filter((proposal): proposal is Proposal => proposal !== null)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function updateProposalStatus(
  paths: StorePaths,
  proposalId: string,
  nextStatus: ProposalStatus,
  updatedAt = new Date().toISOString(),
): Promise<StoredProposal | null> {
  const parsedNextStatus = proposalStatusSchema.parse(nextStatus);
  const existing = await loadProposal(paths, proposalId);
  if (!existing) {
    return null;
  }

  if (!isProposalStatusTransitionAllowed(existing.proposal.status, parsedNextStatus)) {
    throw new Error(
      `Invalid proposal status transition: ${existing.proposal.status} -> ${parsedNextStatus}`,
    );
  }

  const updatedProposal = proposalSchema.parse({
    ...existing.proposal,
    status: parsedNextStatus,
    updatedAt,
  });

  const updatedMeta = proposalMetaSchema.parse({
    ...existing.meta,
    updatedAt,
  });

  await saveProposal(paths, updatedProposal, existing.content, updatedMeta);

  return {
    proposal: updatedProposal,
    content: existing.content,
    meta: updatedMeta,
  };
}

export async function saveDraft(
  paths: StorePaths,
  draftId: string,
  note: LexicalState,
  meta: DraftMeta,
): Promise<void> {
  const parsedNote = lexicalStateSchema.parse(note);
  const parsedMeta = draftMetaSchema.parse(meta);
  if (parsedMeta.id !== draftId) {
    throw new Error(`Draft meta id ${parsedMeta.id} does not match draft id ${draftId}`);
  }

  const draftDir = resolveEntityDir(paths.draftsDir, draftId);
  await mkdir(draftDir, { recursive: true });

  await Promise.all([
    writeJsonAtomic(resolveEntityFile(draftDir, "note.json"), parsedNote),
    writeJsonAtomic(resolveEntityFile(draftDir, "meta.json"), parsedMeta),
  ]);
}

export async function loadDraft(paths: StorePaths, draftId: string): Promise<StoredDraft | null> {
  const draftDir = resolveEntityDir(paths.draftsDir, draftId);
  const notePath = resolveEntityFile(draftDir, "note.json");
  const metaPath = resolveEntityFile(draftDir, "meta.json");

  try {
    const [noteRaw, metaRaw] = await Promise.all([
      readFile(notePath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);

    return {
      note: lexicalStateSchema.parse(JSON.parse(noteRaw)),
      meta: draftMetaSchema.parse(JSON.parse(metaRaw)),
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function listDraftIds(paths: StorePaths): Promise<string[]> {
  return listEntityIds(paths.draftsDir);
}

export async function appendEvent(paths: StorePaths, event: RemEvent): Promise<string> {
  const parsedEvent = remEventSchema.parse(event);
  const day = parsedEvent.timestamp.slice(0, 10);
  const month = parsedEvent.timestamp.slice(0, 7);
  const monthDir = path.join(paths.eventsDir, month);
  const filePath = path.join(monthDir, `${day}.jsonl`);

  await mkdir(monthDir, { recursive: true });
  await syncDirectory(paths.eventsDir);

  const handle = await open(filePath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(parsedEvent)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await syncDirectory(monthDir);
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
  const lines = raw.split("\n");
  const nonEmptyLineIndexes = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line.length > 0)
    .map((entry) => entry.index);

  const lastNonEmptyLineIndex = nonEmptyLineIndexes[nonEmptyLineIndexes.length - 1];
  const events: RemEvent[] = [];

  for (const lineIndex of nonEmptyLineIndexes) {
    const line = lines[lineIndex]?.trim() ?? "";

    try {
      events.push(remEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      // If the process crashed during append, the final JSONL line may be truncated.
      if (lineIndex === lastNonEmptyLineIndex) {
        continue;
      }

      throw new Error(`Invalid event JSON at ${filePath}:${lineIndex + 1}`, {
        cause: error,
      });
    }
  }

  return events;
}
