import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { App } from "./App";

describe("App", () => {
  test("renders minimal canvas shell with workspace panel", () => {
    const html = renderToString(<App />);

    expect(html).toContain("Writing canvas");
    expect(html).toContain('aria-label="Show panel"');
    expect(html).toContain("Workspace");
    expect(html).toContain("Autosave on. Waiting for edits.");
    expect(html).toContain("Settings");
    expect(html).toContain('aria-label="Theme mode"');
    expect(html).toContain(">Light<");
    expect(html).toContain(">Dark<");
    expect(html).toContain(">System<");
    expect(html).toContain("Notes");
    expect(html).toContain("Search notes");
    expect(html).not.toContain("Plugin host");
    expect(html).not.toContain("Proposal Inbox");
    expect(html).not.toContain("Service surface");
    expect(html).toContain("Lexical editor loads in the browser.");
  });
});
