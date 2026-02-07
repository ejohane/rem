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
