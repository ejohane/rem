import { describe, expect, test } from "bun:test";

import {
  buildEntityHref,
  buildPersonMentionText,
  extractPersonMentionTypeaheadMatch,
  normalizePersonHandle,
  parseEntityReferenceFromHref,
  rankPersonMentionCandidates,
} from "./entity-links";

describe("entity link helpers", () => {
  test("builds and parses entity hrefs", () => {
    const href = buildEntityHref({
      namespace: "people",
      entityType: "person",
      entityId: "alice-smith",
    });

    expect(href).toBe("#/entity/people/person/alice-smith");
    expect(parseEntityReferenceFromHref(href)).toEqual({
      namespace: "people",
      entityType: "person",
      entityId: "alice-smith",
    });
    expect(
      parseEntityReferenceFromHref("http://localhost:5173/#/entity/people/person/alice"),
    ).toEqual({
      namespace: "people",
      entityType: "person",
      entityId: "alice",
    });
  });

  test("normalizes handles and mention text", () => {
    expect(normalizePersonHandle("  Alice Smith  ")).toBe("alice-smith");
    expect(normalizePersonHandle("Ops__Lead!!")).toBe("ops-lead");
    expect(buildPersonMentionText("alice")).toBe("@alice");
  });

  test("extracts person mention typeahead matches without triggering for emails", () => {
    expect(extractPersonMentionTypeaheadMatch("Talk to @ali")).toEqual({
      leadOffset: 8,
      matchingString: "ali",
      replaceableString: "@ali",
    });
    expect(extractPersonMentionTypeaheadMatch("alice@example.com")).toBeNull();
    expect(extractPersonMentionTypeaheadMatch("ship(@ops-team")).toEqual({
      leadOffset: 5,
      matchingString: "ops-team",
      replaceableString: "@ops-team",
    });
  });

  test("ranks people by handle, display name, aliases, then recency", () => {
    const candidates = [
      {
        handle: "alice",
        displayName: "Alice Anders",
        aliases: ["ali"],
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      {
        handle: "ally",
        displayName: "Allison",
        aliases: ["alice"],
        updatedAt: "2026-03-03T00:00:00.000Z",
      },
      {
        handle: "bob",
        displayName: "Bob Brown",
        updatedAt: "2026-03-02T00:00:00.000Z",
      },
    ];

    expect(rankPersonMentionCandidates(candidates, "alice")[0]?.handle).toBe("alice");
    expect(rankPersonMentionCandidates(candidates, "ali")[0]?.handle).toBe("alice");
    expect(rankPersonMentionCandidates(candidates, "")[0]?.handle).toBe("ally");
  });
});
