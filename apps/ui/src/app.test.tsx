import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { App } from "./App";

describe("App", () => {
  test("renders minimal canvas shell with workspace panel", () => {
    const html = renderToString(<App />);

    expect(html).toContain("Writing canvas");
    expect(html).toContain('aria-label="Show panel"');
    expect(html).toContain("Workspace");
    expect(html).toContain("Plugin host");
    expect(html).toContain("Proposal Inbox");
    expect(html).toContain("Lexical editor loads in the browser.");
  });
});
