import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import { App } from "./App";

describe("App", () => {
  test("renders proposal inbox shell", () => {
    const html = renderToString(<App />);

    expect(html).toContain("Proposal Inbox");
    expect(html).toContain("Draft Editor");
  });
});
