export interface LexicalNodeLike {
  type: string;
  version?: number;
  text?: string;
  children?: LexicalNodeLike[];
  [key: string]: unknown;
}

export interface LexicalStateLike {
  root: LexicalNodeLike & {
    children?: LexicalNodeLike[];
  };
  [key: string]: unknown;
}

export function plainTextToLexicalState(value: string): LexicalStateLike {
  const lines = value.replace(/\r/g, "").split("\n");
  const normalizedLines = lines.length > 0 ? lines : [""];

  return {
    root: {
      type: "root",
      version: 1,
      children: normalizedLines.map((line) => ({
        type: "paragraph",
        version: 1,
        children: [
          {
            type: "text",
            version: 1,
            text: line,
          },
        ],
      })),
    },
  };
}

function collectNodeText(node: LexicalNodeLike, parts: string[]): void {
  if (typeof node.text === "string" && node.text.length > 0) {
    parts.push(node.text);
  }

  if (!Array.isArray(node.children)) {
    return;
  }

  for (const child of node.children) {
    collectNodeText(child, parts);
  }
}

export function lexicalStateToPlainText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const maybeState = value as LexicalStateLike;
  const rootChildren = maybeState.root?.children;
  if (!Array.isArray(rootChildren)) {
    return "";
  }

  const lines = rootChildren
    .map((child) => {
      const parts: string[] = [];
      collectNodeText(child, parts);
      return parts.join("").trim();
    })
    .filter((line) => line.length > 0);

  return lines.join("\n");
}

export function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ];
}
