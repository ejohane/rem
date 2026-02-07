import { describe, expect, test } from "bun:test";

import { extractSectionContext } from "./proposals";

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
});
