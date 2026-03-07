import { describe, expect, test } from "bun:test";

import { buildDailyNoteRequestPayload, resolveClientTimeZone } from "./daily-notes";

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

  test("resolves the client timezone when available and ignores empty values", () => {
    const originalWindow = globalThis.window;
    try {
      expect(resolveClientTimeZone()).toBeUndefined();

      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          Intl: {
            DateTimeFormat: () => ({
              resolvedOptions: () => ({ timeZone: " America/Chicago " }),
            }),
          },
        },
      });
      expect(resolveClientTimeZone()).toBe("America/Chicago");

      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          Intl: {
            DateTimeFormat: () => ({
              resolvedOptions: () => ({ timeZone: "   " }),
            }),
          },
        },
      });
      expect(resolveClientTimeZone()).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});
