import { Hono } from "hono";

import {
  getCanonicalNoteViaCore,
  getCoreStatus,
  getNoteViaCore,
  rebuildIndexViaCore,
  saveNoteViaCore,
  searchNotesViaCore,
} from "@rem/core";

const app = new Hono();

app.get("/status", async (c) => c.json(await getCoreStatus()));

app.get("/search", async (c) => {
  const query = c.req.query("q") ?? "";
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const results = await searchNotesViaCore(query, Number.isNaN(limit) ? 20 : limit);
  return c.json(results);
});

app.post("/notes", async (c) => {
  const body = (await c.req.json()) as {
    id?: string;
    title: string;
    lexicalState: unknown;
    tags?: string[];
  };

  const result = await saveNoteViaCore({
    id: body.id,
    title: body.title,
    lexicalState: body.lexicalState,
    tags: body.tags,
    actor: { kind: "human", id: "api" },
  });
  return c.json(result);
});

app.get("/notes/:id", async (c) => {
  const noteId = c.req.param("id");
  const note = await getCanonicalNoteViaCore(noteId);

  if (!note) {
    return c.json({ error: "note_not_found", noteId }, 404);
  }

  return c.json(note);
});

app.get("/notes/:id/text", async (c) => {
  const noteId = c.req.param("id");
  const note = await getNoteViaCore(noteId, "text");

  if (!note) {
    return c.json({ error: "note_not_found", noteId }, 404);
  }

  return c.text(String(note.content));
});

app.post("/rebuild-index", async (c) => c.json(await rebuildIndexViaCore()));

export { app };
