import { describe, expect, test } from "bun:test";

import { isCommandPaletteShortcut, isSidebarToggleShortcut } from "./keyboard-shortcuts";

describe("keyboard shortcut helpers", () => {
  test("detects sidebar toggle shortcut", () => {
    expect(
      isSidebarToggleShortcut({
        metaKey: true,
        ctrlKey: false,
        key: "b",
      }),
    ).toBeTrue();
    expect(
      isSidebarToggleShortcut({
        metaKey: false,
        ctrlKey: true,
        key: "B",
      }),
    ).toBeTrue();
    expect(
      isSidebarToggleShortcut({
        metaKey: false,
        ctrlKey: false,
        key: "b",
      }),
    ).toBeFalse();
  });

  test("detects command palette shortcut", () => {
    expect(
      isCommandPaletteShortcut({
        metaKey: true,
        ctrlKey: false,
        key: "k",
      }),
    ).toBeTrue();
    expect(
      isCommandPaletteShortcut({
        metaKey: false,
        ctrlKey: true,
        key: "K",
      }),
    ).toBeTrue();
    expect(
      isCommandPaletteShortcut({
        metaKey: false,
        ctrlKey: false,
        key: "k",
      }),
    ).toBeFalse();
  });
});
