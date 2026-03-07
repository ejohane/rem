import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import {
  App,
  createNoteSavePayload,
  formatStoreRootMessage,
  isLineSpacingPreference,
  isThemePreference,
  resolveLineSpacingValue,
  resolveParagraphSpacingValue,
} from "./App";
import { plainTextToLexicalState } from "./lexical";

describe("App", () => {
  test("renders flat shell with push sidebar and settings entry", () => {
    const html = renderToString(<App />);

    expect(html).toContain("Writing canvas");
    expect(html).toContain('aria-label="Show sidebar"');
    expect(html).toContain("No notes found.");
    expect(html).toContain("Settings");
    expect(html).toContain("Search notes");
    expect(html).toContain("Lexical editor loads in the browser.");
    expect(html).toContain("Unsaved");
  });

  test("formats store-root messages for each config source", () => {
    expect(
      formatStoreRootMessage({
        schemaVersion: "v1",
        configPath: "/tmp/rem/config.json",
        defaultStoreRoot: "/tmp/rem-default",
        configuredStoreRoot: null,
        effectiveStoreRoot: "/tmp/runtime",
        source: "runtime",
      }),
    ).toBe("Using /tmp/runtime (changed in this app session).");
    expect(
      formatStoreRootMessage({
        schemaVersion: "v1",
        configPath: "/tmp/rem/config.json",
        defaultStoreRoot: "/tmp/rem-default",
        configuredStoreRoot: null,
        effectiveStoreRoot: "/tmp/env",
        source: "env",
      }),
    ).toBe("Using /tmp/env from REM_STORE_ROOT.");
    expect(
      formatStoreRootMessage({
        schemaVersion: "v1",
        configPath: "/tmp/rem/config.json",
        defaultStoreRoot: "/tmp/rem-default",
        configuredStoreRoot: "/tmp/config",
        effectiveStoreRoot: "/tmp/config",
        source: "config",
      }),
    ).toBe("Using /tmp/config from /tmp/rem/config.json.");
    expect(
      formatStoreRootMessage({
        schemaVersion: "v1",
        configPath: "/tmp/rem/config.json",
        defaultStoreRoot: "/tmp/rem-default",
        configuredStoreRoot: null,
        effectiveStoreRoot: "/tmp/rem-default",
        source: "default",
      }),
    ).toBe("Using default store root /tmp/rem-default.");
  });

  test("builds note save payloads only when title or body is present", () => {
    expect(createNoteSavePayload("   ", plainTextToLexicalState(""), [])).toBeNull();

    expect(createNoteSavePayload("   ", plainTextToLexicalState("Body"), ["ops"])).toEqual({
      body: {
        title: "Untitled Note",
        noteType: "note",
        lexicalState: plainTextToLexicalState("Body"),
        tags: ["ops"],
      },
      key: JSON.stringify({
        title: "Untitled Note",
        noteType: "note",
        lexicalState: plainTextToLexicalState("Body"),
        tags: ["ops"],
      }),
    });
  });

  test("recognizes valid theme preferences", () => {
    expect(isThemePreference("dark")).toBeTrue();
    expect(isThemePreference("light")).toBeTrue();
    expect(isThemePreference("system")).toBeTrue();
    expect(isThemePreference("sepia")).toBeFalse();
  });

  test("recognizes valid line spacing preferences", () => {
    expect(isLineSpacingPreference("compact")).toBeTrue();
    expect(isLineSpacingPreference("default")).toBeTrue();
    expect(isLineSpacingPreference("relaxed")).toBeTrue();
    expect(isLineSpacingPreference("wide")).toBeFalse();
  });

  test("maps line spacing preferences to editor line-height values", () => {
    expect(resolveLineSpacingValue("compact")).toBe("1.62");
    expect(resolveLineSpacingValue("default")).toBe("1.84");
    expect(resolveLineSpacingValue("relaxed")).toBe("2.04");
  });

  test("maps line spacing preferences to paragraph spacing values", () => {
    expect(resolveParagraphSpacingValue("compact")).toBe("0.34rem");
    expect(resolveParagraphSpacingValue("default")).toBe("0.58rem");
    expect(resolveParagraphSpacingValue("relaxed")).toBe("0.86rem");
  });
});
