import type { LexicalNodeLike, LexicalStateLike } from "./lexical";

export interface CanonicalSectionRecord {
  sectionId: string;
  fallbackPath: string[];
  startNodeIndex: number;
  endNodeIndex: number;
}

export interface CanonicalNoteRecord {
  lexicalState: LexicalStateLike;
  sectionIndex: {
    sections: CanonicalSectionRecord[];
  };
}

export interface ProposalContentRecord {
  format: "lexical" | "text" | "json";
  content: unknown;
}

export interface ProposalEntityReference {
  namespace: string;
  entityType: string;
  entityId: string;
}

function extractNodeText(node: LexicalNodeLike): string {
  const parts: string[] = [];

  if (typeof node.text === "string" && node.text.length > 0) {
    parts.push(node.text);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const text = extractNodeText(child);
      if (text.length > 0) {
        parts.push(text);
      }
    }
  }

  return parts.join("").trim();
}

function findSection(
  note: CanonicalNoteRecord,
  sectionId: string,
  fallbackPath?: string[],
): CanonicalSectionRecord | null {
  const direct = note.sectionIndex.sections.find((section) => section.sectionId === sectionId);
  if (direct) {
    return direct;
  }

  if (!fallbackPath || fallbackPath.length === 0) {
    return null;
  }

  const key = fallbackPath.join("\u001f");
  return (
    note.sectionIndex.sections.find((section) => section.fallbackPath.join("\u001f") === key) ??
    null
  );
}

export function extractSectionContext(
  note: CanonicalNoteRecord,
  sectionId: string,
  fallbackPath?: string[],
): string | null {
  const section = findSection(note, sectionId, fallbackPath);
  if (!section) {
    return null;
  }

  const children = note.lexicalState.root?.children;
  if (!Array.isArray(children)) {
    return null;
  }

  const slice = children.slice(section.startNodeIndex, section.endNodeIndex + 1);
  const lines = slice.map((node) => extractNodeText(node)).filter((line) => line.length > 0);

  return lines.join("\n").trim();
}

const SUPPORTED_ENTITY_TYPES = new Set(["person", "meeting"]);
const SIMPLE_ENTITY_REFERENCE_PATTERN = /(?<!\/)\b(person|meeting):([a-zA-Z0-9._:-]+)\b/g;
const NAMESPACED_ENTITY_REFERENCE_PATTERN =
  /\b([a-z0-9]+(?:[._-][a-z0-9]+)*)\/(person|meeting):([a-zA-Z0-9._:-]+)\b/g;

function appendReference(
  references: Map<string, ProposalEntityReference>,
  reference: ProposalEntityReference,
): void {
  if (!SUPPORTED_ENTITY_TYPES.has(reference.entityType)) {
    return;
  }

  const namespace = reference.namespace.trim();
  const entityType = reference.entityType.trim();
  const entityId = reference.entityId.trim();
  if (!namespace || !entityType || !entityId) {
    return;
  }

  const normalized: ProposalEntityReference = {
    namespace,
    entityType,
    entityId,
  };
  references.set(`${namespace}:${entityType}:${entityId}`, normalized);
}

function sortEntityReferences(
  references: Map<string, ProposalEntityReference>,
): ProposalEntityReference[] {
  return [...references.values()].sort((left, right) => {
    if (left.namespace !== right.namespace) {
      return left.namespace.localeCompare(right.namespace);
    }
    if (left.entityType !== right.entityType) {
      return left.entityType.localeCompare(right.entityType);
    }

    return left.entityId.localeCompare(right.entityId);
  });
}

function extractTextFromLexicalState(lexicalState: LexicalStateLike): string {
  const children = lexicalState.root?.children;
  if (!Array.isArray(children)) {
    return "";
  }

  return children
    .map((node) => extractNodeText(node))
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

function collectStringLeaves(value: unknown, parts: string[], seen: Set<unknown>): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringLeaves(item, parts, seen);
    }
    return;
  }

  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }

  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectStringLeaves(nested, parts, seen);
  }
}

function collectStructuredEntityReferences(
  value: unknown,
  references: Map<string, ProposalEntityReference>,
  seen: Set<unknown>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredEntityReferences(item, references, seen);
    }
    return;
  }

  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }

  seen.add(value);
  const record = value as Record<string, unknown>;
  const namespace = typeof record.namespace === "string" ? record.namespace : null;
  const entityType = typeof record.entityType === "string" ? record.entityType : null;
  const entityId = typeof record.entityId === "string" ? record.entityId : null;
  if (namespace && entityType && entityId) {
    appendReference(references, {
      namespace,
      entityType,
      entityId,
    });
  }

  for (const nested of Object.values(record)) {
    collectStructuredEntityReferences(nested, references, seen);
  }
}

export function extractEntityReferencesFromText(text: string): ProposalEntityReference[] {
  const references = new Map<string, ProposalEntityReference>();

  for (const match of text.matchAll(NAMESPACED_ENTITY_REFERENCE_PATTERN)) {
    const namespaceToken = match[1];
    const entityTypeToken = match[2];
    const entityIdToken = match[3];
    if (!namespaceToken || !entityTypeToken || !entityIdToken) {
      continue;
    }

    appendReference(references, {
      namespace: namespaceToken,
      entityType: entityTypeToken,
      entityId: entityIdToken,
    });
  }

  for (const match of text.matchAll(SIMPLE_ENTITY_REFERENCE_PATTERN)) {
    const entityTypeToken = match[1];
    const entityIdToken = match[2];
    if (!entityTypeToken || !entityIdToken) {
      continue;
    }

    appendReference(references, {
      namespace: entityTypeToken,
      entityType: entityTypeToken,
      entityId: entityIdToken,
    });
  }

  return sortEntityReferences(references);
}

export function extractEntityReferencesFromProposalContent(
  content: ProposalContentRecord,
): ProposalEntityReference[] {
  const references = new Map<string, ProposalEntityReference>();

  if (content.format === "text" && typeof content.content === "string") {
    for (const reference of extractEntityReferencesFromText(content.content)) {
      appendReference(references, reference);
    }
  } else if (
    content.format === "lexical" &&
    content.content &&
    typeof content.content === "object"
  ) {
    const lexicalText = extractTextFromLexicalState(content.content as LexicalStateLike);
    for (const reference of extractEntityReferencesFromText(lexicalText)) {
      appendReference(references, reference);
    }
  } else if (content.format === "json") {
    const textParts: string[] = [];
    collectStringLeaves(content.content, textParts, new Set<unknown>());
    for (const reference of extractEntityReferencesFromText(textParts.join("\n"))) {
      appendReference(references, reference);
    }
  }

  collectStructuredEntityReferences(content.content, references, new Set<unknown>());
  return sortEntityReferences(references);
}

export function collectProposalEntityReferences(input: {
  sectionContext: string | null;
  proposalContent: ProposalContentRecord;
}): ProposalEntityReference[] {
  const references = new Map<string, ProposalEntityReference>();

  for (const reference of extractEntityReferencesFromProposalContent(input.proposalContent)) {
    appendReference(references, reference);
  }

  if (input.sectionContext) {
    for (const reference of extractEntityReferencesFromText(input.sectionContext)) {
      appendReference(references, reference);
    }
  }

  return sortEntityReferences(references);
}

export function formatEntityReferenceLabel(reference: ProposalEntityReference): string {
  return `${reference.namespace}/${reference.entityType}:${reference.entityId}`;
}

export function summarizeEntityContext(
  reference: ProposalEntityReference,
  data: Record<string, unknown>,
): string {
  if (reference.entityType === "person") {
    const fullName =
      typeof data.fullName === "string" && data.fullName.trim().length > 0
        ? data.fullName.trim()
        : typeof data.name === "string" && data.name.trim().length > 0
          ? data.name.trim()
          : reference.entityId;
    const bio = typeof data.bio === "string" && data.bio.trim().length > 0 ? data.bio.trim() : null;
    return bio ? `${fullName} (${bio})` : fullName;
  }

  if (reference.entityType !== "meeting") {
    return formatEntityReferenceLabel(reference);
  }

  const title =
    typeof data.title === "string" && data.title.trim().length > 0
      ? data.title.trim()
      : reference.entityId;
  const attendees = Array.isArray(data.attendees)
    ? data.attendees
        .map((value) => {
          if (typeof value === "string") {
            return value;
          }
          if (!value || typeof value !== "object") {
            return null;
          }
          const candidate = value as Record<string, unknown>;
          if (
            typeof candidate.namespace === "string" &&
            typeof candidate.entityType === "string" &&
            typeof candidate.entityId === "string"
          ) {
            return `${candidate.namespace}/${candidate.entityType}:${candidate.entityId}`;
          }
          return null;
        })
        .filter((value): value is string => value !== null)
    : [];
  if (attendees.length === 0) {
    return title;
  }

  return `${title} · attendees: ${attendees.join(", ")}`;
}
