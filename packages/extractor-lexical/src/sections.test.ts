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

function lexicalRenamedAndReparentedFixture(): unknown {
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
          tag: "h2",
          version: 1,
          children: [{ type: "text", version: 1, text: "Plan Revised" }],
        },
        {
          type: "paragraph",
          version: 1,
          children: [{ type: "text", version: 1, text: "Plan details" }],
        },
        {
          type: "heading",
          tag: "h3",
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

function lexicalWithInsertedSectionFixture(): unknown {
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
          children: [{ type: "text", version: 1, text: "New Section" }],
        },
        {
          type: "paragraph",
          version: 1,
          children: [{ type: "text", version: 1, text: "Brand new details" }],
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

  test("preserves section ids across heading renames and re-parenting", () => {
    const baseline = buildSectionIndexFromLexical("note-stable", lexicalFixture(), {
      generatedAt: "2026-02-07T00:00:00.000Z",
    });

    const migrated = buildSectionIndexFromLexical(
      "note-stable",
      lexicalRenamedAndReparentedFixture(),
      {
        generatedAt: "2026-02-07T01:00:00.000Z",
        existingSectionIndex: baseline,
        existingLexicalState: lexicalFixture(),
      },
    );

    expect(migrated.sections.length).toBe(3);
    expect(migrated.sections[1]?.headingText).toBe("Plan Revised");

    const baselineByHeading = new Map(
      baseline.sections.map((section) => [section.headingText, section.sectionId] as const),
    );
    const migratedByHeading = new Map(
      migrated.sections.map((section) => [section.headingText, section.sectionId] as const),
    );

    expect(migratedByHeading.get("Plan Revised")).toBe(baselineByHeading.get("Plan"));
    expect(migratedByHeading.get("Milestones")).toBe(baselineByHeading.get("Milestones"));
  });

  test("keeps existing ids and assigns new ids when inserting sections", () => {
    const baseline = buildSectionIndexFromLexical("note-insert", lexicalFixture(), {
      generatedAt: "2026-02-07T00:00:00.000Z",
    });

    const updated = buildSectionIndexFromLexical(
      "note-insert",
      lexicalWithInsertedSectionFixture(),
      {
        generatedAt: "2026-02-07T01:00:00.000Z",
        existingSectionIndex: baseline,
        existingLexicalState: lexicalFixture(),
      },
    );

    const baselineByHeading = new Map(
      baseline.sections.map((section) => [section.headingText, section.sectionId] as const),
    );
    const updatedByHeading = new Map(
      updated.sections.map((section) => [section.headingText, section.sectionId] as const),
    );

    expect(updatedByHeading.get("Plan")).toBe(baselineByHeading.get("Plan"));
    expect(updatedByHeading.get("Milestones")).toBe(baselineByHeading.get("Milestones"));
    expect(updatedByHeading.get("New Section")).toBeDefined();
    expect(updatedByHeading.get("New Section")).not.toBe(baselineByHeading.get("Plan"));
    expect(updatedByHeading.get("New Section")).not.toBe(baselineByHeading.get("Milestones"));
  });
});
