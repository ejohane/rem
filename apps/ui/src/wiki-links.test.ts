import { describe, expect, test } from "bun:test";

import {
  buildWikiNoteHref,
  extractCompletedWikiLinkMatch,
  extractWikiTypeaheadMatch,
  parseWikiNoteIdFromHref,
  rankWikiLinkNotes,
} from "./wiki-links";

describe("wiki link helpers", () => {
  test("builds and parses wiki note hrefs", () => {
    const href = buildWikiNoteHref("note alpha/42");

    expect(href).toBe("#/note/note%20alpha%2F42");
    expect(parseWikiNoteIdFromHref(href)).toBe("note alpha/42");
    expect(parseWikiNoteIdFromHref("http://localhost:5173/#/note/note%20alpha%2F42")).toBe(
      "note alpha/42",
    );
  });

  test("extracts typeahead match for an unfinished wiki link", () => {
    expect(extractWikiTypeaheadMatch("Ship [[Daily standup")).toEqual({
      leadOffset: 5,
      matchingString: "Daily standup",
      replaceableString: "[[Daily standup",
    });
  });

  test("does not match completed wiki link syntax", () => {
    expect(extractWikiTypeaheadMatch("Ship [[Daily standup]]")).toBeNull();
  });

  test("extracts a completed wiki link match", () => {
    expect(extractCompletedWikiLinkMatch("Ship [[Daily standup]]")).toEqual({
      leadOffset: 5,
      title: "Daily standup",
      replaceableString: "[[Daily standup]]",
    });
  });

  test("ignores invalid completed wiki link syntax", () => {
    expect(extractCompletedWikiLinkMatch("Ship [[ ]]")).toBeNull();
    expect(extractCompletedWikiLinkMatch("Ship [[Nested [note]]")).toBeNull();
    expect(extractCompletedWikiLinkMatch("Ship [[Daily standup]] later")).toBeNull();
  });

  test("ranks exact and fuzzy note matches", () => {
    const notes = [
      {
        id: "note-z",
        title: "Roadmap",
        updatedAt: "2025-02-01T00:00:00.000Z",
      },
      {
        id: "note-a",
        title: "Daily Standup",
        updatedAt: "2025-02-03T00:00:00.000Z",
      },
      {
        id: "note-b",
        title: "Deployment Plan",
        updatedAt: "2025-02-02T00:00:00.000Z",
      },
    ];

    const exact = rankWikiLinkNotes(notes, "daily standup");
    expect(exact[0]?.id).toBe("note-a");

    const fuzzy = rankWikiLinkNotes(notes, "dplmnt pln");
    expect(fuzzy[0]?.id).toBe("note-b");
  });
});
