import { describe, expect, test } from "bun:test";

import { buildSectionIndexFromLexical } from "./index";

function lexicalFixture(): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [{ type: "text", version: 1, text: "Preface" }],
        },
        {
          type: "heading",
          tag: "h1",
          version: 1,
          children: [{ type: "text", version: 1, text: "Plan" }],
        },
        {
          type: "paragraph",
          version: 1,
          children: [{ type: "text", version: 1, text: "Plan details" }],
        },
        {
          type: "heading",
          tag: "h2",
          version: 1,
          children: [{ type: "text", version: 1, text: "Milestones" }],
        },
        {
          type: "paragraph",
          version: 1,
          children: [{ type: "text", version: 1, text: "M1" }],
        },
      ],
    },
  };
}

describe("buildSectionIndexFromLexical", () => {
  test("builds section boundaries and fallback paths", () => {
    const index = buildSectionIndexFromLexical("note-1", lexicalFixture(), {
      generatedAt: "2026-02-07T00:00:00.000Z",
    });

    expect(index.sections.length).toBe(3);

    expect(index.sections[0]?.headingText).toBe("Preamble");
    expect(index.sections[0]?.startNodeIndex).toBe(0);
    expect(index.sections[0]?.endNodeIndex).toBe(0);

    expect(index.sections[1]?.headingText).toBe("Plan");
    expect(index.sections[1]?.fallbackPath).toEqual(["Plan"]);

    expect(index.sections[2]?.headingText).toBe("Milestones");
    expect(index.sections[2]?.fallbackPath).toEqual(["Plan", "Milestones"]);
  });

  test("generates deterministic section ids for unchanged content", () => {
    const first = buildSectionIndexFromLexical("note-deterministic", lexicalFixture(), {
      generatedAt: "2026-02-07T00:00:00.000Z",
    });

    const second = buildSectionIndexFromLexical("note-deterministic", lexicalFixture(), {
      generatedAt: "2026-02-07T01:00:00.000Z",
    });

    expect(second.sections.map((section) => section.sectionId)).toEqual(
      first.sections.map((section) => section.sectionId),
    );
  });

  test("creates a document section when no headings exist", () => {
    const index = buildSectionIndexFromLexical("note-plain", {
      root: {
        type: "root",
        version: 1,
        children: [
          {
            type: "paragraph",
            version: 1,
            children: [{ type: "text", version: 1, text: "Only paragraph" }],
          },
        ],
      },
    });

    expect(index.sections.length).toBe(1);
    expect(index.sections[0]?.headingText).toBe("Document");
    expect(index.sections[0]?.fallbackPath).toEqual(["Document"]);
  });
});
