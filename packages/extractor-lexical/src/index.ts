import { createHash } from "node:crypto";

const BLOCK_NODE_TYPES = new Set(["heading", "paragraph", "quote", "list", "listitem", "code"]);

type LexicalLikeNode = {
  type?: unknown;
  text?: unknown;
  tag?: unknown;
  listType?: unknown;
  root?: unknown;
  children?: unknown;
};

type HeadingTrailEntry = {
  level: number;
  text: string;
};

export interface LexicalSection {
  sectionId: string;
  noteId: string;
  headingText: string;
  headingLevel: number;
  fallbackPath: string[];
  startNodeIndex: number;
  endNodeIndex: number;
  position: number;
}

export interface LexicalSectionIndex {
  noteId: string;
  schemaVersion: string;
  generatedAt: string;
  sections: LexicalSection[];
}

export interface BuildSectionIndexOptions {
  schemaVersion?: string;
  generatedAt?: string;
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walkLexicalNodeForText(node: unknown, chunks: string[]): void {
  if (!node || typeof node !== "object") {
    return;
  }

  const lexicalNode = node as LexicalLikeNode;
  const nodeType = typeof lexicalNode.type === "string" ? lexicalNode.type : undefined;

  if (typeof lexicalNode.text === "string") {
    chunks.push(lexicalNode.text);
  }

  if (nodeType === "linebreak") {
    chunks.push("\n");
  }

  if (Array.isArray(lexicalNode.children)) {
    for (const child of lexicalNode.children) {
      walkLexicalNodeForText(child, chunks);
    }
  }

  if (nodeType && BLOCK_NODE_TYPES.has(nodeType)) {
    chunks.push("\n");
  }
}

function getInlineText(node: unknown): string {
  const chunks: string[] = [];
  walkLexicalNodeForText(node, chunks);
  return normalizeExtractedText(chunks.join(""));
}

function normalizeInlineMarkdown(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function markdownHeadingLevel(tag: unknown): number {
  if (typeof tag !== "string") {
    return 2;
  }

  const match = /^h([1-6])$/.exec(tag);
  if (!match) {
    return 2;
  }

  return Number.parseInt(match[1] ?? "2", 10);
}

function renderListMarkdown(node: LexicalLikeNode): string[] {
  if (!Array.isArray(node.children)) {
    return [];
  }

  const ordered = node.listType === "number";
  const lines: string[] = [];

  node.children.forEach((child, index) => {
    if (!child || typeof child !== "object") {
      return;
    }

    const item = child as LexicalLikeNode;
    if (item.type !== "listitem") {
      return;
    }

    const text = normalizeInlineMarkdown(getInlineText(item));
    if (!text) {
      return;
    }

    const prefix = ordered ? `${index + 1}. ` : "- ";
    lines.push(`${prefix}${text}`);
  });

  return lines;
}

function renderMarkdownBlocks(node: unknown, lines: string[]): void {
  if (!node || typeof node !== "object") {
    return;
  }

  const lexicalNode = node as LexicalLikeNode;
  const nodeType = typeof lexicalNode.type === "string" ? lexicalNode.type : undefined;

  if (nodeType === "root" && Array.isArray(lexicalNode.children)) {
    for (const child of lexicalNode.children) {
      renderMarkdownBlocks(child, lines);
    }
    return;
  }

  if (nodeType === "heading") {
    const heading = normalizeInlineMarkdown(getInlineText(lexicalNode));
    if (heading) {
      const level = markdownHeadingLevel(lexicalNode.tag);
      lines.push(`${"#".repeat(level)} ${heading}`);
    }
    return;
  }

  if (nodeType === "quote") {
    const quote = normalizeInlineMarkdown(getInlineText(lexicalNode));
    if (quote) {
      lines.push(`> ${quote}`);
    }
    return;
  }

  if (nodeType === "code") {
    const code = getInlineText(lexicalNode);
    if (code) {
      lines.push("```");
      lines.push(code);
      lines.push("```");
    }
    return;
  }

  if (nodeType === "list") {
    lines.push(...renderListMarkdown(lexicalNode));
    return;
  }

  if (nodeType === "paragraph") {
    const paragraph = normalizeInlineMarkdown(getInlineText(lexicalNode));
    if (paragraph) {
      lines.push(paragraph);
    }
    return;
  }

  if (Array.isArray(lexicalNode.children)) {
    for (const child of lexicalNode.children) {
      renderMarkdownBlocks(child, lines);
    }
    return;
  }

  const fallback = normalizeInlineMarkdown(getInlineText(lexicalNode));
  if (fallback) {
    lines.push(fallback);
  }
}

function resolveLexicalRoot(lexicalState: unknown): unknown {
  if (
    lexicalState &&
    typeof lexicalState === "object" &&
    "root" in (lexicalState as LexicalLikeNode)
  ) {
    return (lexicalState as LexicalLikeNode).root;
  }

  return lexicalState;
}

function getRootChildren(lexicalState: unknown): unknown[] {
  const root = resolveLexicalRoot(lexicalState);
  if (!root || typeof root !== "object") {
    return [];
  }

  const rootNode = root as LexicalLikeNode;
  if (!Array.isArray(rootNode.children)) {
    return [];
  }

  return rootNode.children;
}

function buildSectionId(noteId: string, key: string, occurrence: number): string {
  const hash = createHash("sha256").update(`${noteId}:${key}:${occurrence}`).digest("hex");
  return `sec_${hash.slice(0, 16)}`;
}

function addSection(
  sections: LexicalSection[],
  keyOccurrences: Map<string, number>,
  noteId: string,
  headingText: string,
  headingLevel: number,
  fallbackPath: string[],
  startNodeIndex: number,
  endNodeIndex: number,
): void {
  const normalizedHeading = normalizeInlineMarkdown(headingText) || "Untitled Section";
  const key = fallbackPath.length > 0 ? fallbackPath.join("\u001f") : "__preamble__";
  const occurrence = (keyOccurrences.get(key) ?? 0) + 1;
  keyOccurrences.set(key, occurrence);

  sections.push({
    sectionId: buildSectionId(noteId, key, occurrence),
    noteId,
    headingText: normalizedHeading,
    headingLevel,
    fallbackPath,
    startNodeIndex,
    endNodeIndex,
    position: sections.length,
  });
}

export function buildSectionIndexFromLexical(
  noteId: string,
  lexicalState: unknown,
  options?: BuildSectionIndexOptions,
): LexicalSectionIndex {
  const schemaVersion = options?.schemaVersion ?? "v1";
  const generatedAt = options?.generatedAt ?? new Date().toISOString();

  const children = getRootChildren(lexicalState);
  const sections: LexicalSection[] = [];
  const keyOccurrences = new Map<string, number>();

  const headings: Array<{
    index: number;
    level: number;
    text: string;
    fallbackPath: string[];
  }> = [];

  const headingTrail: HeadingTrailEntry[] = [];

  children.forEach((child, index) => {
    if (!child || typeof child !== "object") {
      return;
    }

    const node = child as LexicalLikeNode;
    if (node.type !== "heading") {
      return;
    }

    const level = markdownHeadingLevel(node.tag);
    const text = normalizeInlineMarkdown(getInlineText(node)) || `Section ${headings.length + 1}`;

    while (headingTrail.length > 0 && headingTrail[headingTrail.length - 1]?.level >= level) {
      headingTrail.pop();
    }

    headingTrail.push({ level, text });

    headings.push({
      index,
      level,
      text,
      fallbackPath: headingTrail.map((entry) => entry.text),
    });
  });

  if (headings.length === 0) {
    const terminalIndex = Math.max(children.length - 1, 0);
    addSection(sections, keyOccurrences, noteId, "Document", 1, ["Document"], 0, terminalIndex);
  } else {
    const firstHeadingIndex = headings[0]?.index ?? 0;
    if (firstHeadingIndex > 0) {
      addSection(
        sections,
        keyOccurrences,
        noteId,
        "Preamble",
        1,
        ["Preamble"],
        0,
        firstHeadingIndex - 1,
      );
    }

    headings.forEach((heading, index) => {
      const nextHeading = headings[index + 1];
      const endNodeIndex = nextHeading
        ? nextHeading.index - 1
        : Math.max(children.length - 1, heading.index);

      addSection(
        sections,
        keyOccurrences,
        noteId,
        heading.text,
        heading.level,
        heading.fallbackPath,
        heading.index,
        endNodeIndex,
      );
    });
  }

  return {
    noteId,
    schemaVersion,
    generatedAt,
    sections,
  };
}

export function extractPlainTextFromLexical(lexicalState: unknown): string {
  const lexicalRoot = resolveLexicalRoot(lexicalState);
  const chunks: string[] = [];
  walkLexicalNodeForText(lexicalRoot, chunks);
  return normalizeExtractedText(chunks.join(""));
}

export function extractMarkdownFromLexical(lexicalState: unknown): string {
  const lexicalRoot = resolveLexicalRoot(lexicalState);
  const lines: string[] = [];
  renderMarkdownBlocks(lexicalRoot, lines);
  return normalizeExtractedText(lines.join("\n\n"));
}
