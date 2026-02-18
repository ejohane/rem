import { describe, expect, test } from "bun:test";

import {
  buildDailyNoteIdentity,
  formatDailyDisplayTitleFromDate,
  parseDailyDateInput,
  resolveDailyTimeZone,
  toDailyDisplayTitleFromDateInput,
} from "./daily-notes";

describe("daily notes date utilities", () => {
  test("parses supported daily date input formats", () => {
    expect(parseDailyDateInput("1-5-2026")).toEqual({ year: 2026, month: 1, day: 5 });
    expect(parseDailyDateInput("01-05-2026")).toEqual({ year: 2026, month: 1, day: 5 });
    expect(parseDailyDateInput("1/5/2026")).toEqual({ year: 2026, month: 1, day: 5 });
    expect(parseDailyDateInput("01/05/2026")).toEqual({ year: 2026, month: 1, day: 5 });
    expect(parseDailyDateInput("2026-01-05")).toEqual({ year: 2026, month: 1, day: 5 });
  });

  test("rejects invalid dates and malformed inputs", () => {
    expect(parseDailyDateInput("")).toBeNull();
    expect(parseDailyDateInput("13-1-2026")).toBeNull();
    expect(parseDailyDateInput("2-30-2026")).toBeNull();
    expect(parseDailyDateInput("2026-02-30")).toBeNull();
    expect(parseDailyDateInput("nope")).toBeNull();
  });

  test("handles leap year validation correctly", () => {
    expect(parseDailyDateInput("2-29-2024")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseDailyDateInput("2-29-2025")).toBeNull();
  });

  test("formats ordinal day suffixes in display titles", () => {
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 1 })).toContain("1st");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 2 })).toContain("2nd");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 3 })).toContain("3rd");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 4 })).toContain("4th");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 11 })).toContain("11th");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 12 })).toContain("12th");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 13 })).toContain("13th");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 21 })).toContain("21st");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 22 })).toContain("22nd");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 23 })).toContain("23rd");
    expect(formatDailyDisplayTitleFromDate({ year: 2026, month: 1, day: 31 })).toContain("31st");
  });

  test("derives timezone-aware daily identities deterministically", () => {
    const now = new Date("2026-01-15T00:30:00.000Z");
    const utcIdentity = buildDailyNoteIdentity(now, "UTC");
    const laIdentity = buildDailyNoteIdentity(now, "America/Los_Angeles");

    expect(utcIdentity.dateKey).toBe("2026-01-15");
    expect(utcIdentity.shortDate).toBe("1-15-2026");
    expect(utcIdentity.noteId).toBe("daily-2026-01-15");
    expect(utcIdentity.displayTitle).toBe("Thursday Jan 15th 2026");

    expect(laIdentity.dateKey).toBe("2026-01-14");
    expect(laIdentity.shortDate).toBe("1-14-2026");
    expect(laIdentity.noteId).toBe("daily-2026-01-14");
    expect(laIdentity.displayTitle).toBe("Wednesday Jan 14th 2026");
  });

  test("normalizes date query to daily display title", () => {
    expect(toDailyDisplayTitleFromDateInput("1-15-2026")).toBe("Thursday Jan 15th 2026");
    expect(toDailyDisplayTitleFromDateInput("2026-01-15")).toBe("Thursday Jan 15th 2026");
    expect(toDailyDisplayTitleFromDateInput("not-a-date")).toBeNull();
  });

  test("validates explicit timezones", () => {
    expect(resolveDailyTimeZone("UTC")).toBe("UTC");
    expect(() => resolveDailyTimeZone("Not/A_Zone")).toThrow("Invalid timezone");
  });
});
