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
  });
});
