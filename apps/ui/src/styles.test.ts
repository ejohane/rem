import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

const stylesCss = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("command palette styles", () => {
  test("centers the backdrop and opts out of dialog default absolute placement", () => {
    expect(stylesCss).toMatch(/\.command-palette-backdrop\s*{[^}]*place-items:\s*center;/s);
    expect(stylesCss).toMatch(/\.command-palette\s*{[^}]*position:\s*static;/s);
  });

  test("keeps palette border styling local without global border token override", () => {
    expect(stylesCss).toMatch(/\.command-palette\s*{[^}]*border:\s*1px\s+solid\s+color-mix\(/s);
    expect(stylesCss).not.toMatch(/--border:/);
  });
});
