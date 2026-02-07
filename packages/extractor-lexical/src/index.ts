const BLOCK_NODE_TYPES = new Set(["heading", "paragraph", "quote", "list", "listitem", "code"]);

type LexicalLikeNode = {
  type?: unknown;
  text?: unknown;
  children?: unknown;
};

function walkLexicalNode(node: unknown, chunks: string[]): void {
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
      walkLexicalNode(child, chunks);
    }
  }

  if (nodeType && BLOCK_NODE_TYPES.has(nodeType)) {
    chunks.push("\n");
  }
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractPlainTextFromLexical(lexicalState: unknown): string {
  const chunks: string[] = [];
  walkLexicalNode(lexicalState, chunks);
  return normalizeExtractedText(chunks.join(""));
}
