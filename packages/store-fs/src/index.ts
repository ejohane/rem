import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";

import {
  type LexicalState,
  type NoteMeta,
  type NoteSectionIndex,
  type PluginEntityMeta,
  type PluginEntityRecord,
  type PluginManifest,
  type PluginMeta,
  type Proposal,
  type ProposalContent,
  type ProposalMeta,
  type ProposalStatus,
  type RemEvent,
  isProposalStatusTransitionAllowed,
  lexicalStateSchema,
  noteMetaSchema,
  noteSectionIndexSchema,
  pluginEntityMetaSchema,
  pluginEntityRecordSchema,
  pluginEntityTypeIdSchema,
  pluginManifestSchema,
  pluginMetaSchema,
  pluginNamespaceSchema,
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
  pluginsDir: string;
  entitiesDir: string;
  eventsDir: string;
  indexDir: string;
  dbPath: string;
}

export interface StoredNote {
  note: LexicalState;
  meta: NoteMeta;
  sectionIndex: NoteSectionIndex | null;
}

export interface StoredProposal {
  proposal: Proposal;
  content: ProposalContent;
  meta: ProposalMeta;
}

export interface StoredPlugin {
  manifest: PluginManifest;
  meta: PluginMeta;
}

export interface StoredEntity {
  entity: PluginEntityRecord;
  meta: PluginEntityMeta;
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
    pluginsDir: path.join(normalizedRoot, "plugins"),
    entitiesDir: path.join(normalizedRoot, "entities"),
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
    mkdir(paths.pluginsDir, { recursive: true }),
    mkdir(paths.entitiesDir, { recursive: true }),
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
  sectionIndex?: NoteSectionIndex,
): Promise<void> {
  const parsedNote = lexicalStateSchema.parse(note);
  const parsedMeta = noteMetaSchema.parse(meta);
  if (parsedMeta.id !== noteId) {
    throw new Error(`Note meta id ${parsedMeta.id} does not match note id ${noteId}`);
  }
  const parsedSectionIndex = sectionIndex ? noteSectionIndexSchema.parse(sectionIndex) : null;
  if (parsedSectionIndex && parsedSectionIndex.noteId !== noteId) {
    throw new Error(
      `Section index note id ${parsedSectionIndex.noteId} does not match note id ${noteId}`,
    );
  }

  const noteDir = resolveEntityDir(paths.notesDir, noteId);
  await mkdir(noteDir, { recursive: true });

  const writes = [
    writeJsonAtomic(resolveEntityFile(noteDir, "note.json"), parsedNote),
    writeJsonAtomic(resolveEntityFile(noteDir, "meta.json"), parsedMeta),
  ];
  if (parsedSectionIndex) {
    writes.push(writeJsonAtomic(resolveEntityFile(noteDir, "sections.json"), parsedSectionIndex));
  }

  await Promise.all(writes);
}

export async function loadNote(paths: StorePaths, noteId: string): Promise<StoredNote | null> {
  const noteDir = resolveEntityDir(paths.notesDir, noteId);
  const notePath = resolveEntityFile(noteDir, "note.json");
  const metaPath = resolveEntityFile(noteDir, "meta.json");
  const sectionsPath = resolveEntityFile(noteDir, "sections.json");

  try {
    const [noteRaw, metaRaw] = await Promise.all([
      readFile(notePath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);

    return {
      note: lexicalStateSchema.parse(JSON.parse(noteRaw)),
      meta: noteMetaSchema.parse(JSON.parse(metaRaw)),
      sectionIndex: await (async () => {
        try {
          const sectionsRaw = await readFile(sectionsPath, "utf8");
          return noteSectionIndexSchema.parse(JSON.parse(sectionsRaw));
        } catch (error) {
          const errorCode = (error as NodeJS.ErrnoException).code;
          if (errorCode === "ENOENT") {
            return null;
          }

          throw error;
        }
      })(),
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

export async function savePlugin(
  paths: StorePaths,
  manifest: PluginManifest,
  meta: PluginMeta,
): Promise<void> {
  const parsedManifest = pluginManifestSchema.parse(manifest);
  const parsedMeta = pluginMetaSchema.parse(meta);

  if (parsedManifest.namespace !== parsedMeta.namespace) {
    throw new Error(
      `Plugin meta namespace ${parsedMeta.namespace} does not match manifest namespace ${parsedManifest.namespace}`,
    );
  }

  const pluginDir = resolveEntityDir(paths.pluginsDir, parsedManifest.namespace);
  await mkdir(pluginDir, { recursive: true });

  await Promise.all([
    writeJsonAtomic(resolveEntityFile(pluginDir, "manifest.json"), parsedManifest),
    writeJsonAtomic(resolveEntityFile(pluginDir, "meta.json"), parsedMeta),
  ]);
}

export async function loadPlugin(
  paths: StorePaths,
  namespace: string,
): Promise<StoredPlugin | null> {
  const pluginDir = resolveEntityDir(paths.pluginsDir, namespace);
  const manifestPath = resolveEntityFile(pluginDir, "manifest.json");
  const metaPath = resolveEntityFile(pluginDir, "meta.json");

  try {
    const [manifestRaw, metaRaw] = await Promise.all([
      readFile(manifestPath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);

    return {
      manifest: pluginManifestSchema.parse(JSON.parse(manifestRaw)),
      meta: pluginMetaSchema.parse(JSON.parse(metaRaw)),
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function listPluginNamespaces(paths: StorePaths): Promise<string[]> {
  return listEntityIds(paths.pluginsDir);
}

export async function listPlugins(paths: StorePaths): Promise<StoredPlugin[]> {
  const namespaces = await listPluginNamespaces(paths);
  const loaded = await Promise.all(
    namespaces.map(async (namespace) => loadPlugin(paths, namespace)),
  );

  return loaded
    .filter((plugin): plugin is StoredPlugin => plugin !== null)
    .sort((left, right) => left.manifest.namespace.localeCompare(right.manifest.namespace));
}

function resolvePluginEntityCollectionDir(
  paths: StorePaths,
  namespace: string,
  entityType: string,
): string {
  const parsedNamespace = pluginNamespaceSchema.parse(namespace);
  const parsedEntityType = pluginEntityTypeIdSchema.parse(entityType);

  return resolveEntityDir(paths.entitiesDir, `${parsedNamespace}.${parsedEntityType}`);
}

export async function savePluginEntity(
  paths: StorePaths,
  entity: PluginEntityRecord,
  meta: PluginEntityMeta,
): Promise<void> {
  const parsedEntity = pluginEntityRecordSchema.parse(entity);
  const parsedMeta = pluginEntityMetaSchema.parse(meta);
  const collectionDir = resolvePluginEntityCollectionDir(
    paths,
    parsedEntity.namespace,
    parsedEntity.entityType,
  );
  const entityDir = resolveEntityDir(collectionDir, parsedEntity.id);

  await mkdir(entityDir, { recursive: true });
  await Promise.all([
    writeJsonAtomic(resolveEntityFile(entityDir, "entity.json"), parsedEntity),
    writeJsonAtomic(resolveEntityFile(entityDir, "meta.json"), parsedMeta),
  ]);
}

export async function loadPluginEntity(
  paths: StorePaths,
  namespace: string,
  entityType: string,
  entityId: string,
): Promise<StoredEntity | null> {
  const collectionDir = resolvePluginEntityCollectionDir(paths, namespace, entityType);
  const entityDir = resolveEntityDir(collectionDir, entityId);
  const entityPath = resolveEntityFile(entityDir, "entity.json");
  const metaPath = resolveEntityFile(entityDir, "meta.json");

  try {
    const [entityRaw, metaRaw] = await Promise.all([
      readFile(entityPath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);

    return {
      entity: pluginEntityRecordSchema.parse(JSON.parse(entityRaw)),
      meta: pluginEntityMetaSchema.parse(JSON.parse(metaRaw)),
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function listPluginEntityIds(
  paths: StorePaths,
  namespace: string,
  entityType: string,
): Promise<string[]> {
  const collectionDir = resolvePluginEntityCollectionDir(paths, namespace, entityType);

  try {
    return listEntityIds(collectionDir);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function listPluginEntities(
  paths: StorePaths,
  namespace: string,
  entityType: string,
): Promise<StoredEntity[]> {
  const entityIds = await listPluginEntityIds(paths, namespace, entityType);
  const loaded = await Promise.all(
    entityIds.map((entityId) => loadPluginEntity(paths, namespace, entityType, entityId)),
  );

  return loaded.filter((entity): entity is StoredEntity => entity !== null);
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
