import { describe, expect, test } from "bun:test";

import { buildDailyNoteRequestPayload } from "./daily-notes";

describe("daily note UI helpers", () => {
  test("builds timezone payload only for non-empty timezone values", () => {
    expect(buildDailyNoteRequestPayload(undefined)).toEqual({});
    expect(buildDailyNoteRequestPayload("")).toEqual({});
    expect(buildDailyNoteRequestPayload("  ")).toEqual({});
    expect(buildDailyNoteRequestPayload("UTC")).toEqual({ timezone: "UTC" });
    expect(buildDailyNoteRequestPayload(" America/New_York ")).toEqual({
      timezone: "America/New_York",
    });
  });
});
