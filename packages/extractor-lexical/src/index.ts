const BLOCK_NODE_TYPES = new Set(["heading", "paragraph", "quote", "list", "listitem", "code"]);

type LexicalLikeNode = {
  type?: unknown;
  text?: unknown;
  tag?: unknown;
  listType?: unknown;
  root?: unknown;
  children?: unknown;
};

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

export function extractPlainTextFromLexical(lexicalState: unknown): string {
  const lexicalRoot =
    lexicalState && typeof lexicalState === "object" && "root" in (lexicalState as LexicalLikeNode)
      ? (lexicalState as LexicalLikeNode).root
      : lexicalState;
  const chunks: string[] = [];
  walkLexicalNodeForText(lexicalRoot, chunks);
  return normalizeExtractedText(chunks.join(""));
}

export function extractMarkdownFromLexical(lexicalState: unknown): string {
  const lexicalRoot =
    lexicalState && typeof lexicalState === "object" && "root" in (lexicalState as LexicalLikeNode)
      ? (lexicalState as LexicalLikeNode).root
      : lexicalState;
  const lines: string[] = [];
  renderMarkdownBlocks(lexicalRoot, lines);
  return normalizeExtractedText(lines.join("\n\n"));
}
