import { Hono } from "hono";
import { cors } from "hono/cors";

import {
  getCanonicalNoteViaCore,
  getCoreStatus,
  getNoteViaCore,
  rebuildIndexViaCore,
  saveNoteViaCore,
  searchNotesViaCore,
} from "@rem/core";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) {
        return "*";
      }

      try {
        const parsed = new URL(origin);
        if (["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
          return origin;
        }
      } catch {
        // Ignore malformed origin headers and reject below.
      }

      return "";
    },
  }),
);

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

if (import.meta.main) {
  const port = Number.parseInt(process.env.REM_API_PORT ?? "8787", 10);
  const hostname = process.env.REM_API_HOST ?? "127.0.0.1";

  Bun.serve({
    fetch: app.fetch,
    hostname,
    port: Number.isNaN(port) ? 8787 : port,
  });

  process.stdout.write(
    `rem api listening on http://${hostname}:${Number.isNaN(port) ? 8787 : port}\n`,
  );
}
