import { describe, expect, test } from "bun:test";

import { defaultEditorPlugins } from "./editor-plugins";

describe("editor plugin host contract", () => {
  test("provides deterministic plugin outputs for editor context", () => {
    const context = {
      plainText: "alpha bravo charlie",
      tags: ["ops", "daily"],
      noteId: "note-1234",
      draftId: null,
    };

    const rendered = defaultEditorPlugins.map((plugin) => ({
      id: plugin.id,
      value: plugin.render(context),
    }));

    expect(rendered).toEqual([
      { id: "word-count", value: "3 words" },
      { id: "tag-snapshot", value: "ops, daily" },
      { id: "target-handle", value: "note-1234" },
    ]);
  });
});
