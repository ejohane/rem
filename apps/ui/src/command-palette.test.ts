import { describe, expect, test } from "bun:test";

import {
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
