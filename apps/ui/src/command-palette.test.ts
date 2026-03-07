import { describe, expect, test } from "bun:test";

import {
  buildCommandPaletteSections,
  flattenCommandPaletteSections,
  formatCommandPaletteNoteSnippet,
  getNextCommandIndex,
  getPreviousCommandIndex,
  isNextCommandShortcut,
  isPreviousCommandShortcut,
  matchesCommandQuery,
} from "./command-palette";

describe("command palette query matching", () => {
  test("treats empty query as visible", () => {
    expect(matchesCommandQuery("", ["today"])).toBe(true);
    expect(matchesCommandQuery("   ", ["add note"])).toBe(true);
  });

  test("matches aliases case-insensitively", () => {
    expect(matchesCommandQuery("ADD", ["today", "add note"])).toBe(true);
    expect(matchesCommandQuery("new", ["create a new note"])).toBe(true);
  });

  test("returns false when aliases do not match", () => {
    expect(matchesCommandQuery("deploy", ["today", "add note"])).toBe(false);
  });

  test("builds command and note sections for the palette", () => {
    expect(
      buildCommandPaletteSections("", [
        {
          id: "note-1",
          title: "Release plan",
          updatedAt: "2026-03-07T10:00:00.000Z",
          snippet: "ignored when query is empty",
        },
      ]),
    ).toEqual([
      {
        id: "suggested",
        label: "Suggested",
        items: [
          { kind: "command", id: "today", label: "Today", shortcut: "↵" },
          { kind: "command", id: "add-note", label: "Add Note", shortcut: "↵" },
        ],
      },
    ]);

    expect(
      buildCommandPaletteSections("release", [
        {
          id: "note-1",
          title: "Release plan",
          updatedAt: "2026-03-07T10:00:00.000Z",
          snippet: "Ship the [release] checklist",
        },
      ]),
    ).toEqual([
      {
        id: "notes",
        label: "Notes",
        items: [
          {
            kind: "note",
            id: "note:note-1",
            noteId: "note-1",
            title: "Release plan",
            updatedAt: "2026-03-07T10:00:00.000Z",
            snippet: "Ship the release checklist",
          },
        ],
      },
    ]);
  });

  test("flattens grouped palette items in render order", () => {
    const items = flattenCommandPaletteSections(
      buildCommandPaletteSections("note", [
        {
          id: "note-1",
          title: "Note search",
          updatedAt: "2026-03-07T10:00:00.000Z",
          snippet: "Search [note] content",
        },
      ]),
    );

    expect(items.map((item) => item.id)).toEqual(["today", "add-note", "note:note-1"]);
  });

  test("normalizes note snippets for display", () => {
    expect(formatCommandPaletteNoteSnippet("Review [deploy] notes")).toBe("Review deploy notes");
    expect(formatCommandPaletteNoteSnippet("   ")).toBe("Open note");
  });

  test("detects next and previous navigation shortcuts", () => {
    expect(
      isNextCommandShortcut({
        key: "ArrowDown",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isNextCommandShortcut({
        key: "n",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isPreviousCommandShortcut({
        key: "ArrowUp",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isPreviousCommandShortcut({
        key: "p",
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      isNextCommandShortcut({
        key: "n",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
    expect(
      isPreviousCommandShortcut({
        key: "p",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  });

  test("wraps command index navigation", () => {
    expect(getNextCommandIndex(0, 2)).toBe(1);
    expect(getNextCommandIndex(1, 2)).toBe(0);
    expect(getPreviousCommandIndex(0, 2)).toBe(1);
    expect(getPreviousCommandIndex(1, 2)).toBe(0);
    expect(getNextCommandIndex(0, 0)).toBe(0);
    expect(getPreviousCommandIndex(0, 0)).toBe(0);
  });
});
