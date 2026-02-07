import { describe, expect, test } from "bun:test";

import { parseTags, plainTextToLexicalState } from "./lexical";

describe("ui lexical helpers", () => {
  test("converts plain text into lexical paragraphs", () => {
    const lexicalState = plainTextToLexicalState("Line one\nLine two");
    expect(lexicalState.root.children.length).toBe(2);
    expect(lexicalState.root.children[0]?.children[0]?.text).toBe("Line one");
    expect(lexicalState.root.children[1]?.children[0]?.text).toBe("Line two");
  });

  test("parses tags from comma separated input", () => {
    const tags = parseTags("work, planning, work, , daily");
    expect(tags).toEqual(["work", "planning", "daily"]);
  });
});
