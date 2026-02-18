import { describe, expect, test } from "bun:test";

import { buildDailyTitleDateAliases } from "./daily-note-search";

describe("daily note title search aliases", () => {
  test("builds supported date aliases for daily title format", () => {
    expect(buildDailyTitleDateAliases("Thursday Jan 15th 2026")).toEqual([
      "1-15-2026",
      "01-15-2026",
      "1/15/2026",
      "01/15/2026",
      "2026-01-15",
    ]);
  });

  test("returns no aliases for non-daily titles", () => {
    expect(buildDailyTitleDateAliases("Meeting notes")).toEqual([]);
    expect(buildDailyTitleDateAliases("")).toEqual([]);
  });
});
