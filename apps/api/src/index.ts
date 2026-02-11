import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";

import {
  acceptProposalViaCore,
  createProposalViaCore,
  getCanonicalNoteViaCore,
  getCoreStatus,
  getCoreStoreRootConfigViaCore,
  getNoteViaCore,
  getProposalViaCore,
  listEventsViaCore,
  listPluginsViaCore,
  listProposalsViaCore,
  listSectionsViaCore,
  migrateSectionIdentityViaCore,
  rebuildIndexViaCore,
  registerPluginViaCore,
  rejectProposalViaCore,
  saveNoteViaCore,
  searchNotesViaCore,
  setCoreStoreRootConfigViaCore,
} from "@rem/core";

const app = new Hono();
const configuredApiToken = process.env.REM_API_TOKEN?.trim() ?? "";
const defaultApiPort = 8787;
const defaultApiHost = "127.0.0.1";

type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type ApiStatus = 400 | 404 | 409 | 500;

function jsonError(code: string, message: string, details?: unknown): ApiErrorBody {
  return {
    error: {
      code,
      message,
      details,
    },
  };
}

function mapCoreError(error: unknown): { status: ApiStatus; body: ApiErrorBody } {
  if (error instanceof Error) {
    const normalizedMessage = error.message.toLowerCase();

    if (normalizedMessage.includes("disk i/o error")) {
      return {
        status: 500,
        body: jsonError("storage_error", "Storage temporarily unavailable. Please retry."),
      };
    }

    if (error.message.toLowerCase().includes("not found")) {
      return {
        status: 404,
        body: jsonError("not_found", error.message),
      };
    }

    if (
      error.message.includes("Cannot accept proposal") ||
      error.message.includes("Cannot reject proposal") ||
      error.message.includes("Invalid proposal status transition")
    ) {
      return {
        status: 409,
        body: jsonError("invalid_transition", error.message),
      };
    }

    return {
      status: 400,
      body: jsonError("bad_request", error.message),
    };
  }

  return {
    status: 500,
    body: jsonError("internal_error", "Unexpected error"),
  };
}

function parseBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) {
    return null;
  }

  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function isHtmlNavigationRequest(request: Request): boolean {
  const acceptHeader = request.headers.get("accept");
  return typeof acceptHeader === "string" && acceptHeader.includes("text/html");
}

function resolveStaticAssetPath(uiDistDir: string, requestPathname: string): string | null {
  const normalizedPath = requestPathname === "/" ? "/index.html" : requestPathname;
  const candidate = path.resolve(uiDistDir, `.${normalizedPath}`);
  const root = path.resolve(uiDistDir);

  if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) {
    return candidate;
  }

  return null;
}

async function serveUiAsset(request: Request, uiDistDir: string): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return null;
  }

  const assetPath = resolveStaticAssetPath(uiDistDir, parsedUrl.pathname);
  if (assetPath) {
    const assetFile = Bun.file(assetPath);
    if (await assetFile.exists()) {
      return new Response(assetFile);
    }
  }

  if (!isHtmlNavigationRequest(request)) {
    return null;
  }

  const indexFile = Bun.file(path.join(uiDistDir, "index.html"));
  if (!(await indexFile.exists())) {
    return null;
  }

  return new Response(indexFile);
}

type StartApiServerOptions = {
  host?: string;
  port?: number;
  uiDistDir?: string;
  log?: boolean;
};

function createFetchHandler(uiDistDir?: string): (request: Request) => Promise<Response> {
  const resolvedUiDistDir = uiDistDir ? path.resolve(uiDistDir) : undefined;

  return async (request: Request): Promise<Response> => {
    const apiResponse = await app.fetch(request);

    if (!resolvedUiDistDir || apiResponse.status !== 404) {
      return apiResponse;
    }

    const uiResponse = await serveUiAsset(request, resolvedUiDistDir);
    return uiResponse ?? apiResponse;
  };
}

export function startApiServer(options: StartApiServerOptions = {}): ReturnType<typeof Bun.serve> {
  const rawPort = options.port ?? Number.parseInt(process.env.REM_API_PORT ?? "8787", 10);
  const port = Number.isNaN(rawPort) ? defaultApiPort : rawPort;
  const host = options.host ?? process.env.REM_API_HOST ?? defaultApiHost;
  const uiDistDir = options.uiDistDir ?? process.env.REM_UI_DIST;

  const server = Bun.serve({
    fetch: createFetchHandler(uiDistDir),
    hostname: host,
    port,
  });

  if (options.log !== false) {
    process.stdout.write(`rem api listening on http://${host}:${port}\n`);
    if (uiDistDir) {
      process.stdout.write(`rem api serving UI assets from ${path.resolve(uiDistDir)}\n`);
    }
  }

  return server;
}

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

app.use("*", async (c, next) => {
  if (!configuredApiToken || c.req.method === "OPTIONS") {
    await next();
    return;
  }

  const providedToken = parseBearerToken(c.req.header("authorization"));
  if (!providedToken || providedToken !== configuredApiToken) {
    return c.json(jsonError("unauthorized", "Invalid or missing bearer token"), 401);
  }

  await next();
});

app.get("/status", async (c) => c.json(await getCoreStatus()));

app.get("/config", async (c) => c.json(await getCoreStoreRootConfigViaCore()));

app.put("/config", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      storeRoot?: unknown;
    };

    if (body.storeRoot !== undefined && typeof body.storeRoot !== "string") {
      return c.json(jsonError("invalid_store_root", "storeRoot must be a string path"), 400);
    }

    const config = await setCoreStoreRootConfigViaCore(body.storeRoot);
    return c.json(config);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/search", async (c) => {
  const query = c.req.query("q") ?? "";
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const tagsQuery = c.req.query("tags");
  const noteTypesQuery = c.req.query("noteTypes");
  const pluginNamespacesQuery = c.req.query("pluginNamespaces");
  const tags = tagsQuery
    ? tagsQuery
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    : undefined;
  const noteTypes = noteTypesQuery
    ? noteTypesQuery
        .split(",")
        .map((noteType) => noteType.trim())
        .filter((noteType) => noteType.length > 0)
    : undefined;
  const pluginNamespaces = pluginNamespacesQuery
    ? pluginNamespacesQuery
        .split(",")
        .map((namespace) => namespace.trim())
        .filter((namespace) => namespace.length > 0)
    : undefined;
  const createdSince = c.req.query("createdSince") ?? undefined;
  const createdUntil = c.req.query("createdUntil") ?? undefined;
  const updatedSince = c.req.query("updatedSince") ?? undefined;
  const updatedUntil = c.req.query("updatedUntil") ?? undefined;
  const results = await searchNotesViaCore(query, {
    limit: Number.isNaN(limit) ? 20 : limit,
    tags,
    noteTypes,
    pluginNamespaces,
    createdSince,
    createdUntil,
    updatedSince,
    updatedUntil,
  });
  return c.json(results);
});

app.post("/notes", async (c) => {
  try {
    const body = (await c.req.json()) as {
      id?: string;
      title: string;
      noteType?: string;
      lexicalState: unknown;
      tags?: string[];
      plugins?: Record<string, unknown>;
      actor?: { kind: "human" | "agent"; id?: string };
    };

    const result = await saveNoteViaCore({
      id: body.id,
      title: body.title,
      noteType: body.noteType,
      lexicalState: body.lexicalState,
      tags: body.tags,
      plugins: body.plugins,
      actor: body.actor ?? { kind: "human", id: "api" },
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.put("/notes/:id", async (c) => {
  try {
    const noteId = c.req.param("id");
    const body = (await c.req.json()) as {
      id?: string;
      title: string;
      noteType?: string;
      lexicalState: unknown;
      tags?: string[];
      plugins?: Record<string, unknown>;
      actor?: { kind: "human" | "agent"; id?: string };
    };

    if (body.id && body.id !== noteId) {
      return c.json(
        jsonError("note_id_mismatch", `Body id ${body.id} does not match route id ${noteId}`),
        400,
      );
    }

    const existing = await getCanonicalNoteViaCore(noteId);
    if (!existing) {
      return c.json(jsonError("note_not_found", `Note not found: ${noteId}`), 404);
    }

    const result = await saveNoteViaCore({
      id: noteId,
      title: body.title,
      noteType: body.noteType,
      lexicalState: body.lexicalState,
      tags: body.tags,
      plugins: body.plugins,
      actor: body.actor ?? { kind: "human", id: "api" },
    });
    return c.json(result);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/notes/:id", async (c) => {
  const noteId = c.req.param("id");
  const note = await getCanonicalNoteViaCore(noteId);

  if (!note) {
    return c.json(jsonError("note_not_found", `Note not found: ${noteId}`), 404);
  }

  return c.json(note);
});

app.get("/notes/:id/text", async (c) => {
  const noteId = c.req.param("id");
  const note = await getNoteViaCore(noteId, "text");

  if (!note) {
    return c.json(jsonError("note_not_found", `Note not found: ${noteId}`), 404);
  }

  return c.text(String(note.content));
});

app.get("/sections", async (c) => {
  const noteId = c.req.query("noteId");
  if (!noteId) {
    return c.json(jsonError("missing_note_id", "Query parameter noteId is required"), 400);
  }

  const sections = await listSectionsViaCore(noteId);
  if (!sections) {
    return c.json(jsonError("note_not_found", `Note not found: ${noteId}`), 404);
  }

  return c.json(sections);
});

app.get("/events", async (c) => {
  try {
    const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
    const events = await listEventsViaCore({
      since: c.req.query("since") ?? undefined,
      limit: Number.isNaN(limit) ? 100 : limit,
      type: c.req.query("type") ?? undefined,
      actorKind: (c.req.query("actorKind") as "human" | "agent" | undefined) ?? undefined,
      actorId: c.req.query("actorId") ?? undefined,
      entityKind:
        (c.req.query("entityKind") as "note" | "proposal" | "plugin" | undefined) ?? undefined,
      entityId: c.req.query("entityId") ?? undefined,
    });
    return c.json(events);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/plugins/register", async (c) => {
  try {
    const body = (await c.req.json()) as {
      manifest: {
        namespace: string;
        schemaVersion: string;
        payloadSchema: {
          type: "object";
          required?: string[];
          properties?: Record<
            string,
            {
              type: "string" | "number" | "boolean" | "object" | "array";
              items?: { type: "string" | "number" | "boolean" | "object" | "array" };
            }
          >;
          additionalProperties?: boolean;
        };
      };
      registrationKind?: "static" | "dynamic";
      actor?: { kind: "human" | "agent"; id?: string };
    };

    const result = await registerPluginViaCore({
      manifest: {
        namespace: body.manifest.namespace,
        schemaVersion: body.manifest.schemaVersion,
        payloadSchema: {
          type: body.manifest.payloadSchema.type,
          required: body.manifest.payloadSchema.required ?? [],
          properties: body.manifest.payloadSchema.properties ?? {},
          additionalProperties: body.manifest.payloadSchema.additionalProperties ?? true,
        },
      },
      registrationKind: body.registrationKind,
      actor: body.actor,
    });

    return c.json(result);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/plugins", async (c) => {
  try {
    const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
    const plugins = await listPluginsViaCore(Number.isNaN(limit) ? 100 : limit);
    return c.json(plugins);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/proposals", async (c) => {
  try {
    const body = (await c.req.json()) as {
      id?: string;
      actor?: { kind: "agent"; id: string };
      target: {
        noteId: string;
        sectionId: string;
        fallbackPath?: string[];
      };
      proposalType: "replace_section" | "annotate";
      content: {
        format: "lexical" | "text" | "json";
        content: unknown;
        schemaVersion?: string;
      };
      rationale?: string;
      confidence?: number;
      source?: string;
    };

    const result = await createProposalViaCore({
      id: body.id,
      actor: body.actor ?? { kind: "agent", id: "api-agent" },
      target: body.target,
      proposalType: body.proposalType,
      content: body.content,
      rationale: body.rationale,
      confidence: body.confidence,
      source: body.source,
    });

    return c.json(result);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/proposals", async (c) => {
  try {
    const status = c.req.query("status") as
      | "open"
      | "accepted"
      | "rejected"
      | "superseded"
      | undefined;
    const proposals = await listProposalsViaCore({ status });
    return c.json(proposals);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/proposals/:id", async (c) => {
  const proposalId = c.req.param("id");
  const proposal = await getProposalViaCore(proposalId);

  if (!proposal) {
    return c.json(jsonError("proposal_not_found", `Proposal not found: ${proposalId}`), 404);
  }

  return c.json(proposal);
});

app.post("/proposals/:id/accept", async (c) => {
  try {
    const proposalId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      actor?: { kind: "human"; id?: string };
    };

    const result = await acceptProposalViaCore({
      proposalId,
      actor: body.actor ?? { kind: "human", id: "api-reviewer" },
    });

    if (!result) {
      return c.json(jsonError("proposal_not_found", `Proposal not found: ${proposalId}`), 404);
    }

    return c.json(result);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/proposals/:id/reject", async (c) => {
  try {
    const proposalId = c.req.param("id");
    const body = (await c.req.json().catch(() => ({}))) as {
      actor?: { kind: "human"; id?: string };
    };

    const result = await rejectProposalViaCore({
      proposalId,
      actor: body.actor ?? { kind: "human", id: "api-reviewer" },
    });

    if (!result) {
      return c.json(jsonError("proposal_not_found", `Proposal not found: ${proposalId}`), 404);
    }

    return c.json(result);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/rebuild-index", async (c) => c.json(await rebuildIndexViaCore()));
app.post("/migrations/sections", async (c) => c.json(await migrateSectionIdentityViaCore()));

export { app };

if (import.meta.main) {
  startApiServer();
}
