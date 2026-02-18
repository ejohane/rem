import { describe, expect, test } from "bun:test";

import { matchesCommandQuery } from "./command-palette";

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
});
