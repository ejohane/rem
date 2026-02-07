interface LexicalTextNode {
  type: "text";
  version: 1;
  text: string;
}

interface LexicalParagraphNode {
  type: "paragraph";
  version: 1;
  children: LexicalTextNode[];
}

interface LexicalRootNode {
  type: "root";
  version: 1;
  children: LexicalParagraphNode[];
}

interface LexicalState {
  root: LexicalRootNode;
}

export function plainTextToLexicalState(value: string): LexicalState {
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
