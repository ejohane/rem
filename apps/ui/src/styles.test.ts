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

  test("lets the editor title field expand horizontally instead of capping it at 40rem", () => {
    expect(stylesCss).toMatch(/\.topbar-meta\s*{[^}]*flex:\s*1\s+1\s+auto;/s);
    expect(stylesCss).toMatch(/\.topbar-title-input\s*{[^}]*width:\s*100%;/s);
    expect(stylesCss).not.toMatch(/\.topbar-title-input\s*{[^}]*width:\s*min\(40rem,\s*100%\);/s);
    expect(stylesCss).not.toMatch(
      /\.topbar-title-input\s*{[^}]*min-width:\s*min\(40rem,\s*100%\);/s,
    );
  });

  test("drives editor line spacing through a root CSS variable", () => {
    expect(stylesCss).toMatch(/:root\s*{[^}]*--editor-line-height:\s*1\.62;/s);
    expect(stylesCss).toMatch(/:root\s*{[^}]*--editor-paragraph-spacing:\s*0\.34rem;/s);
    expect(stylesCss).toMatch(
      /\.lexical-editor\s*{[^}]*line-height:\s*var\(--editor-line-height\);/s,
    );
    expect(stylesCss).toMatch(
      /\.lexical-editor p\s*{[^}]*margin:\s*0;[^}]*line-height:\s*var\(--editor-line-height\);/s,
    );
    expect(stylesCss).toMatch(
      /\.lexical-editor p \+ p\s*{[^}]*margin-top:\s*var\(--editor-paragraph-spacing\);/s,
    );
  });

  test("uses explicit slate-blue wiki link tokens instead of status color mixing", () => {
    expect(stylesCss).toMatch(/:root\s*{[^}]*--link:\s*#8fa9ff;/s);
    expect(stylesCss).toMatch(/:root\s*{[^}]*--link-hover:\s*#bccbff;/s);
    expect(stylesCss).toMatch(/:root\s*{[^}]*--link-underline:\s*#5f7fd6;/s);
    expect(stylesCss).toMatch(/:root\[data-theme="light"\]\s*{[^}]*--link:\s*#2e5aac;/s);
    expect(stylesCss).toMatch(
      /\.lexical-editor a\[href\^="#\/note\/"\]\s*{[^}]*color:\s*var\(--link\);/s,
    );
    expect(stylesCss).toMatch(
      /\.lexical-editor a\[href\^="#\/note\/"\]\s*{[^}]*text-decoration-color:\s*var\(--link-underline\);/s,
    );
    expect(stylesCss).toMatch(
      /\.lexical-editor a\[href\^="#\/note\/"\]:hover\s*{[^}]*color:\s*var\(--link-hover\);/s,
    );
    expect(stylesCss).not.toMatch(
      /\.lexical-editor a\[href\^="#\/note\/"\]\s*{[^}]*status-success/s,
    );
  });
});
