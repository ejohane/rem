import { describe, expect, test } from "bun:test";

import {
  collectProposalEntityReferences,
  extractEntityReferencesFromProposalContent,
  extractEntityReferencesFromText,
  extractSectionContext,
  formatEntityReferenceLabel,
  summarizeEntityContext,
} from "./proposals";

describe("proposal section context helpers", () => {
  test("extracts section text by section id", () => {
    const context = extractSectionContext(
      {
        lexicalState: {
          root: {
            type: "root",
            version: 1,
            children: [
              {
                type: "heading",
                version: 1,
                children: [{ type: "text", version: 1, text: "Plan" }],
              },
              {
                type: "paragraph",
                version: 1,
                children: [{ type: "text", version: 1, text: "Ship it." }],
              },
              {
                type: "heading",
                version: 1,
                children: [{ type: "text", version: 1, text: "Later" }],
              },
            ],
          },
        },
        sectionIndex: {
          sections: [
            {
              sectionId: "section-plan",
              fallbackPath: ["Plan"],
              startNodeIndex: 0,
              endNodeIndex: 1,
            },
          ],
        },
      },
      "section-plan",
    );

    expect(context).toBe("Plan\nShip it.");
  });

  test("falls back to fallback path when section id changes", () => {
    const context = extractSectionContext(
      {
        lexicalState: {
          root: {
            type: "root",
            version: 1,
            children: [
              {
                type: "heading",
                version: 1,
                children: [{ type: "text", version: 1, text: "Roadmap" }],
              },
              {
                type: "paragraph",
                version: 1,
                children: [{ type: "text", version: 1, text: "Q1 goals." }],
              },
            ],
          },
        },
        sectionIndex: {
          sections: [
            {
              sectionId: "new-section-id",
              fallbackPath: ["Roadmap"],
              startNodeIndex: 0,
              endNodeIndex: 1,
            },
          ],
        },
      },
      "missing-id",
      ["Roadmap"],
    );

    expect(context).toBe("Roadmap\nQ1 goals.");
  });

  test("extracts entity references from text with namespace and simple formats", () => {
    const references = extractEntityReferencesFromText(
      "Loop in person:alice, meeting:kickoff, and people/person:bob links.",
    );

    expect(references).toEqual([
      {
        namespace: "meeting",
        entityType: "meeting",
        entityId: "kickoff",
      },
      {
        namespace: "people",
        entityType: "person",
        entityId: "bob",
      },
      {
        namespace: "person",
        entityType: "person",
        entityId: "alice",
      },
    ]);
  });

  test("extracts proposal references from lexical and structured content", () => {
    const lexicalReferences = extractEntityReferencesFromProposalContent({
      format: "lexical",
      content: {
        root: {
          type: "root",
          version: 1,
          children: [
            {
              type: "paragraph",
              version: 1,
              children: [
                { type: "text", version: 1, text: "Discuss meeting:retro with person:al" },
              ],
            },
          ],
        },
      },
    });
    expect(lexicalReferences).toEqual([
      {
        namespace: "meeting",
        entityType: "meeting",
        entityId: "retro",
      },
      {
        namespace: "person",
        entityType: "person",
        entityId: "al",
      },
    ]);

    const structuredReferences = extractEntityReferencesFromProposalContent({
      format: "json",
      content: {
        attendees: [
          {
            namespace: "people",
            entityType: "person",
            entityId: "sam",
          },
        ],
      },
    });
    expect(structuredReferences).toEqual([
      {
        namespace: "people",
        entityType: "person",
        entityId: "sam",
      },
    ]);
  });

  test("combines section and proposal content references deterministically", () => {
    const references = collectProposalEntityReferences({
      sectionContext: "Meet with person:alice",
      proposalContent: {
        format: "text",
        content: "Follow-up in meeting:staff-sync",
      },
    });

    expect(references).toEqual([
      {
        namespace: "meeting",
        entityType: "meeting",
        entityId: "staff-sync",
      },
      {
        namespace: "person",
        entityType: "person",
        entityId: "alice",
      },
    ]);
  });

  test("summarizes person and meeting entity contexts", () => {
    expect(
      summarizeEntityContext(
        {
          namespace: "person",
          entityType: "person",
          entityId: "alice",
        },
        {
          fullName: "Alice Anders",
          bio: "Platform",
        },
      ),
    ).toBe("Alice Anders (Platform)");

    expect(
      summarizeEntityContext(
        {
          namespace: "meetings",
          entityType: "meeting",
          entityId: "retro",
        },
        {
          title: "Weekly Retro",
          attendees: [
            "alice",
            {
              namespace: "people",
              entityType: "person",
              entityId: "bob",
            },
          ],
        },
      ),
    ).toBe("Weekly Retro · attendees: alice, people/person:bob");

    expect(
      summarizeEntityContext(
        {
          namespace: "custom",
          entityType: "custom",
          entityId: "x1",
        },
        {},
      ),
    ).toBe("custom/custom:x1");
  });

  test("formats entity references for review UI labels", () => {
    expect(
      formatEntityReferenceLabel({
        namespace: "person",
        entityType: "person",
        entityId: "alice",
      }),
    ).toBe("person/person:alice");
  });
});
