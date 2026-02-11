import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { App } from "./App";

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
    expect(html).toContain("Plugin Sidebar Panels");
    expect(html).toContain("No toolbar plugin panels.");
    expect(html).toContain("Proposal Review Panels");
    expect(html).toContain("Entity-Aware Context");
    expect(html).toContain("Select a saved note to inspect proposal context.");
    expect(html).toContain("No entity-aware proposal context for this note.");
    expect(html).toContain("Plugin Commands");
    expect(html).toContain("No plugin commands.");
  });
});
