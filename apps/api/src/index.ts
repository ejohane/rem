import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  discoverPluginRuntimeAssets,
  evaluatePluginPermissionGate,
  loadPluginRuntimeModule,
  mapPluginActionError,
  resolvePluginRoot,
  resolveTrustedRoots,
  runPluginActionWithGuards,
} from "@rem/plugins";
import { pluginManifestInputSchema } from "@rem/schemas";
import type { Actor } from "@rem/schemas";
import { Hono } from "hono";
import { cors } from "hono/cors";

import {
  acceptProposalViaCore,
  applyPluginTemplateViaCore,
  createPluginEntityViaCore,
  createProposalViaCore,
  disablePluginViaCore,
  enablePluginViaCore,
  getCanonicalNoteViaCore,
  getCoreStatus,
  getCoreStoreRootConfigViaCore,
  getNoteViaCore,
  getPluginEntityViaCore,
  getPluginSchedulerStatusViaCore,
  getPluginViaCore,
  getProposalViaCore,
  installPluginViaCore,
  listEventsViaCore,
  listPluginEntitiesViaCore,
  listPluginTemplatesViaCore,
  listPluginsViaCore,
  listProposalsViaCore,
  listSectionsViaCore,
  migrateSectionIdentityViaCore,
  rebuildIndexViaCore,
  recordPluginActionEventViaCore,
  registerPluginViaCore,
  rejectProposalViaCore,
  runPluginSchedulerViaCore,
  saveNoteViaCore,
  searchNotesViaCore,
  setCoreStoreRootConfigViaCore,
  uninstallPluginViaCore,
  updatePluginEntityViaCore,
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

    if (
      error.message.toLowerCase().includes("not found") ||
      error.message.toLowerCase().includes("not registered")
    ) {
      return {
        status: 404,
        body: jsonError("not_found", error.message),
      };
    }

    if (
      error.message.includes("Cannot accept proposal") ||
      error.message.includes("Cannot reject proposal") ||
      error.message.includes("Invalid proposal status transition") ||
      error.message.includes("Invalid plugin lifecycle transition")
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseListInput(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return strings.length > 0 ? strings : undefined;
}

function buildPluginCoreBridge(
  actor: Actor,
  sourcePlugin: string,
): {
  saveNote: (input: unknown) => Promise<unknown>;
  searchNotes: (query: string, filters?: Record<string, unknown>) => Promise<unknown>;
  createProposal: (input: unknown) => Promise<unknown>;
  listEvents: (input?: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    saveNote: async (input: unknown): Promise<unknown> => {
      if (!isRecord(input)) {
        throw new Error("core.saveNote payload must be an object");
      }

      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        throw new Error("core.saveNote payload must include a title");
      }

      const overrideReason =
        typeof input.overrideReason === "string" && input.overrideReason.trim().length > 0
          ? input.overrideReason.trim()
          : undefined;
      const approvedBy =
        typeof input.approvedBy === "string" && input.approvedBy.trim().length > 0
          ? input.approvedBy.trim()
          : undefined;
      if (actor.kind === "agent" && !overrideReason) {
        throw new Error(
          "Agent plugin note writes must use core.createProposal unless overrideReason is provided",
        );
      }

      return saveNoteViaCore({
        id: typeof input.id === "string" ? input.id : undefined,
        title: input.title,
        noteType: typeof input.noteType === "string" ? input.noteType : undefined,
        lexicalState: input.lexicalState,
        tags: parseOptionalStringArray(input.tags),
        plugins: isRecord(input.plugins) ? (input.plugins as Record<string, unknown>) : undefined,
        actor,
        overrideReason,
        approvedBy,
        sourcePlugin,
      });
    },
    searchNotes: async (query: string, filters?: Record<string, unknown>) =>
      searchNotesViaCore(query, filters),
    createProposal: async (input: unknown): Promise<unknown> => {
      if (!isRecord(input)) {
        throw new Error("core.createProposal payload must be an object");
      }

      return createProposalViaCore({
        ...(input as Omit<Parameters<typeof createProposalViaCore>[0], "actor">),
        actor,
      });
    },
    listEvents: async (input?: Record<string, unknown>) => listEventsViaCore(input),
  };
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

app.post("/entities", async (c) => {
  try {
    const body = await c.req.json();
    if (!isRecord(body)) {
      return c.json(jsonError("invalid_body", "Request body must be a JSON object"), 400);
    }

    const namespace = typeof body.namespace === "string" ? body.namespace.trim() : "";
    const entityType = typeof body.entityType === "string" ? body.entityType.trim() : "";
    if (!namespace) {
      return c.json(jsonError("missing_namespace", "Body field namespace is required"), 400);
    }
    if (!entityType) {
      return c.json(jsonError("missing_entity_type", "Body field entityType is required"), 400);
    }
    if (!isRecord(body.data)) {
      return c.json(jsonError("missing_data", "Body field data must be a JSON object"), 400);
    }

    const result = await createPluginEntityViaCore({
      namespace,
      entityType,
      id: typeof body.id === "string" ? body.id : undefined,
      schemaVersion: typeof body.schemaVersion === "string" ? body.schemaVersion : undefined,
      data: body.data,
      links: Array.isArray(body.links) ? body.links : undefined,
      actor: isRecord(body.actor)
        ? {
            kind: body.actor.kind as "human" | "agent",
            id: typeof body.actor.id === "string" ? body.actor.id : undefined,
          }
        : undefined,
    });

    return c.json(result);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/entities", async (c) => {
  const namespace = c.req.query("namespace")?.trim();
  const entityType = c.req.query("entityType")?.trim();
  if (!namespace) {
    return c.json(jsonError("missing_namespace", "Query parameter namespace is required"), 400);
  }
  if (!entityType) {
    return c.json(jsonError("missing_entity_type", "Query parameter entityType is required"), 400);
  }

  try {
    const entities = await listPluginEntitiesViaCore({
      namespace,
      entityType,
      schemaVersion: c.req.query("schemaVersion") ?? undefined,
    });
    return c.json(entities);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/entities/:namespace/:entityType/:id", async (c) => {
  try {
    const namespace = c.req.param("namespace");
    const entityType = c.req.param("entityType");
    const id = c.req.param("id");
    const entity = await getPluginEntityViaCore({
      namespace,
      entityType,
      id,
    });
    if (!entity) {
      return c.json(
        jsonError("entity_not_found", `Entity not found: ${namespace}/${entityType}/${id}`),
        404,
      );
    }

    return c.json(entity);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.put("/entities/:namespace/:entityType/:id", async (c) => {
  try {
    const namespace = c.req.param("namespace");
    const entityType = c.req.param("entityType");
    const id = c.req.param("id");
    const body = await c.req.json();
    if (!isRecord(body)) {
      return c.json(jsonError("invalid_body", "Request body must be a JSON object"), 400);
    }
    if (typeof body.id === "string" && body.id !== id) {
      return c.json(
        jsonError("entity_id_mismatch", `Body id ${body.id} does not match route id ${id}`),
        400,
      );
    }
    if (!isRecord(body.data)) {
      return c.json(jsonError("missing_data", "Body field data must be a JSON object"), 400);
    }

    const updated = await updatePluginEntityViaCore({
      namespace,
      entityType,
      id,
      schemaVersion: typeof body.schemaVersion === "string" ? body.schemaVersion : undefined,
      data: body.data,
      links: Array.isArray(body.links) ? body.links : undefined,
      actor: isRecord(body.actor)
        ? {
            kind: body.actor.kind as "human" | "agent",
            id: typeof body.actor.id === "string" ? body.actor.id : undefined,
          }
        : undefined,
    });

    return c.json(updated);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/entities/migrations/run", async (c) => {
  try {
    const rawBody = (await c.req.json().catch(() => ({}))) as unknown;
    if (!isRecord(rawBody)) {
      return c.json(jsonError("invalid_body", "Request body must be a JSON object"), 400);
    }
    const body = rawBody;

    const namespace = typeof body.namespace === "string" ? body.namespace.trim() : "";
    const entityType = typeof body.entityType === "string" ? body.entityType.trim() : "";
    const actionId = typeof body.actionId === "string" ? body.actionId.trim() : "";
    if (!namespace) {
      return c.json(jsonError("missing_namespace", "Body field namespace is required"), 400);
    }
    if (!entityType) {
      return c.json(jsonError("missing_entity_type", "Body field entityType is required"), 400);
    }
    if (!actionId) {
      return c.json(jsonError("missing_action_id", "Body field actionId is required"), 400);
    }

    const plugin = await getPluginViaCore(namespace);
    if (!plugin) {
      return c.json(jsonError("plugin_not_found", `Plugin not found: ${namespace}`), 404);
    }

    const targetSchemaVersion =
      typeof body.targetSchemaVersion === "string" && body.targetSchemaVersion.trim().length > 0
        ? body.targetSchemaVersion.trim()
        : plugin.manifest.schemaVersion;
    if (targetSchemaVersion !== plugin.manifest.schemaVersion) {
      return c.json(
        jsonError(
          "invalid_target_schema_version",
          `Target schemaVersion must match manifest schemaVersion ${plugin.manifest.schemaVersion}`,
        ),
        400,
      );
    }

    const fromSchemaVersion =
      typeof body.fromSchemaVersion === "string" && body.fromSchemaVersion.trim().length > 0
        ? body.fromSchemaVersion.trim()
        : undefined;
    const dryRun = Boolean(body.dryRun);

    const entities = await listPluginEntitiesViaCore({
      namespace,
      entityType,
    });
    const candidates = [...entities]
      .filter((entry) => {
        if (fromSchemaVersion) {
          return entry.entity.schemaVersion === fromSchemaVersion;
        }
        return entry.entity.schemaVersion !== targetSchemaVersion;
      })
      .sort((left, right) => left.entity.id.localeCompare(right.entity.id));

    const migrationSummary = {
      namespace,
      entityType,
      actionId,
      deterministicOrder: "entity.id:asc",
      fromSchemaVersion: fromSchemaVersion ?? null,
      targetSchemaVersion,
      dryRun,
      scanned: entities.length,
      eligible: candidates.length,
      migrated: 0,
      skipped: entities.length - candidates.length,
      failed: 0,
      results: candidates.map((entry) => ({
        id: entry.entity.id,
        fromSchemaVersion: entry.entity.schemaVersion,
        targetSchemaVersion,
        status: "planned" as "planned" | "migrated" | "failed",
        error: undefined as string | undefined,
      })),
    };

    if (dryRun || candidates.length === 0) {
      return c.json(migrationSummary);
    }

    if (plugin.meta.lifecycleState !== "enabled") {
      return c.json(
        jsonError("plugin_not_enabled", `Plugin ${namespace} must be enabled to run actions`),
        409,
      );
    }

    const declaredAction = plugin.manifest.cli?.actions.find((action) => action.id === actionId);
    if (!declaredAction) {
      return c.json(
        jsonError(
          "plugin_action_not_declared",
          `Action not declared in plugin manifest: ${namespace}/${actionId}`,
        ),
        404,
      );
    }

    const grantedPermissions = plugin.manifest.permissions ?? [];
    const permissionGate = evaluatePluginPermissionGate({
      grantedPermissions,
      requiredPermissions: declaredAction.requiredPermissions ?? [],
    });
    if (!permissionGate.allowed) {
      return c.json(
        jsonError(
          "plugin_permission_denied",
          `Action ${namespace}/${actionId} requires missing permissions: ${permissionGate.missingPermissions.join(", ")}`,
        ),
        400,
      );
    }

    const pluginPath = typeof body.pluginPath === "string" ? body.pluginPath : undefined;
    const configuredRoots = [
      ...parseListInput(body.trustedRoots),
      ...(pluginPath ? [pluginPath] : []),
    ];
    const trustedRoots = resolveTrustedRoots({
      configuredRoots,
    });
    const pluginRoot = await resolvePluginRoot({
      namespace,
      trustedRoots,
      pluginPath,
    });
    const runtimeAssets = await discoverPluginRuntimeAssets({
      pluginRoot,
      trustedRoots,
      manifest: plugin.manifest,
    });
    if (!runtimeAssets.cliEntrypoint) {
      return c.json(
        jsonError(
          "plugin_entrypoint_missing",
          `No CLI entrypoint available for plugin ${namespace}`,
        ),
        400,
      );
    }

    const runtimeModule = await loadPluginRuntimeModule(runtimeAssets.cliEntrypoint.absolutePath);
    const runtimeAction = runtimeModule.cli?.actions[actionId];
    if (!runtimeAction) {
      return c.json(
        jsonError(
          "plugin_action_not_found",
          `Action not found in runtime module: ${namespace}/${actionId}`,
        ),
        404,
      );
    }

    const actorInput = isRecord(body.actor) ? body.actor : {};
    if (
      actorInput.kind !== undefined &&
      actorInput.kind !== "human" &&
      actorInput.kind !== "agent"
    ) {
      return c.json(
        jsonError("invalid_actor_kind", `Invalid actor kind: ${String(actorInput.kind)}`),
        400,
      );
    }
    const actor: Actor = {
      kind: actorInput.kind === "agent" ? "agent" : "human",
      id:
        typeof actorInput.id === "string" && actorInput.id.trim().length > 0
          ? actorInput.id.trim()
          : "entity-migrator",
    };
    const requestIdPrefix =
      (typeof body.requestId === "string" && body.requestId.trim().length > 0
        ? body.requestId.trim()
        : undefined) ??
      c.req.header("x-request-id")?.trim() ??
      randomUUID();

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) {
        continue;
      }

      const requestId = `${requestIdPrefix}:${candidate.entity.id}`;
      const startedAtMs = Date.now();

      try {
        const guardedExecution = await runPluginActionWithGuards({
          namespace,
          actionId,
          input: {
            entity: candidate.entity,
            meta: candidate.meta,
            compatibility: candidate.compatibility,
            fromSchemaVersion: candidate.entity.schemaVersion,
            targetSchemaVersion,
          },
          policy: {
            timeoutMs: parseOptionalPositiveInteger(body.timeoutMs),
            maxInputBytes: parseOptionalPositiveInteger(body.maxInputBytes),
            maxOutputBytes: parseOptionalPositiveInteger(body.maxOutputBytes),
            maxConcurrentInvocationsPerPlugin: parseOptionalPositiveInteger(
              body.maxConcurrentInvocationsPerPlugin ?? body.maxConcurrency,
            ),
          },
          invoke: async () =>
            runtimeAction(
              {
                entity: candidate.entity,
                meta: candidate.meta,
                compatibility: candidate.compatibility,
                fromSchemaVersion: candidate.entity.schemaVersion,
                targetSchemaVersion,
              },
              {
                plugin: {
                  namespace: plugin.manifest.namespace,
                  schemaVersion: plugin.manifest.schemaVersion,
                },
                invocation: {
                  actorKind: actor.kind,
                  actorId: actor.id,
                  host: "api",
                  requestId,
                },
                permissions: new Set(grantedPermissions),
                core: buildPluginCoreBridge(actor, namespace),
                log: ({ level, message, data }) => {
                  console.error(
                    `[plugin:${namespace}:${actionId}:migrate:${candidate.entity.id}] ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ""}`,
                  );
                },
              },
            ),
        });

        await recordPluginActionEventViaCore({
          namespace,
          actionId,
          requestId,
          actor,
          host: "api",
          status: "success",
          durationMs: guardedExecution.durationMs,
          inputBytes: guardedExecution.inputBytes,
          outputBytes: guardedExecution.outputBytes,
        });

        if (!isRecord(guardedExecution.result)) {
          throw new Error(
            `Migration action must return an object payload for entity ${candidate.entity.id}`,
          );
        }
        if (!isRecord(guardedExecution.result.data)) {
          throw new Error(
            `Migration action output must include data object for entity ${candidate.entity.id}`,
          );
        }

        const migrated = await updatePluginEntityViaCore({
          namespace,
          entityType,
          id: candidate.entity.id,
          schemaVersion: targetSchemaVersion,
          data: guardedExecution.result.data as Record<string, unknown>,
          links: Array.isArray(guardedExecution.result.links)
            ? (guardedExecution.result.links as Parameters<
                typeof updatePluginEntityViaCore
              >[0]["links"])
            : candidate.meta.links,
          actor,
        });

        const result = migrationSummary.results[index];
        if (result) {
          result.status = "migrated";
          result.targetSchemaVersion = migrated.entity.schemaVersion;
        }
        migrationSummary.migrated += 1;
      } catch (error) {
        const mapped = mapPluginActionError(error, "Failed to run plugin migration action");
        await recordPluginActionEventViaCore({
          namespace,
          actionId,
          requestId,
          actor,
          host: "api",
          status: "failure",
          durationMs: Math.max(0, Date.now() - startedAtMs),
          errorCode: mapped.code,
          errorMessage: mapped.message,
        }).catch(() => undefined);

        const result = migrationSummary.results[index];
        if (result) {
          result.status = "failed";
          result.error = mapped.message;
        }
        migrationSummary.failed += 1;
      }
    }

    return c.json(migrationSummary);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/plugins/register", async (c) => {
  try {
    const body = (await c.req.json()) as {
      manifest: unknown;
      registrationKind?: "static" | "dynamic";
      actor?: { kind: "human" | "agent"; id?: string };
    };

    const result = await registerPluginViaCore({
      manifest: pluginManifestInputSchema.parse(body.manifest),
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

app.get("/templates", async (c) => {
  try {
    const namespace = c.req.query("namespace") ?? undefined;
    const includeUnavailableQuery = c.req.query("includeUnavailable");
    const includeUnavailable =
      includeUnavailableQuery === "1" || includeUnavailableQuery?.toLowerCase() === "true";

    return c.json(
      await listPluginTemplatesViaCore({
        namespace,
        includeUnavailable,
      }),
    );
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/templates/apply", async (c) => {
  try {
    const body = (await c.req.json()) as {
      namespace: string;
      templateId: string;
      title?: string;
      noteType?: string;
      tags?: string[];
      actor?: { kind: "human" | "agent"; id?: string };
    };

    return c.json(
      await applyPluginTemplateViaCore({
        namespace: body.namespace,
        templateId: body.templateId,
        title: body.title,
        noteType: body.noteType,
        tags: body.tags,
        actor: body.actor,
      }),
    );
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/scheduler/status", async (c) => {
  try {
    const namespace = c.req.query("namespace") ?? undefined;
    const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);

    return c.json(
      await getPluginSchedulerStatusViaCore({
        namespace,
        limit: Number.isNaN(limit) ? 20 : limit,
      }),
    );
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/scheduler/run", async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      now?: string;
      namespaces?: string[];
      actor?: { kind: "human" | "agent"; id?: string };
    };

    return c.json(
      await runPluginSchedulerViaCore({
        now: body.now,
        namespaces: body.namespaces,
        actor: body.actor,
      }),
    );
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.get("/plugins/:namespace", async (c) => {
  try {
    const namespace = c.req.param("namespace");
    const plugin = await getPluginViaCore(namespace);
    if (!plugin) {
      return c.json(jsonError("plugin_not_found", `Plugin not found: ${namespace}`), 404);
    }

    return c.json(plugin);
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/plugins/:namespace/actions/:actionId", async (c) => {
  const namespace = c.req.param("namespace");
  const actionId = c.req.param("actionId");
  let actor: Actor | undefined;
  let requestId: string | undefined;
  let invocationStartedAtMs: number | undefined;

  try {
    const rawBody = (await c.req.json().catch(() => ({}))) as unknown;
    if (!isRecord(rawBody)) {
      return c.json(jsonError("invalid_body", "Request body must be a JSON object"), 400);
    }
    const body = rawBody;

    const plugin = await getPluginViaCore(namespace);
    if (!plugin) {
      return c.json(jsonError("plugin_not_found", `Plugin not found: ${namespace}`), 404);
    }

    if (plugin.meta.lifecycleState !== "enabled") {
      return c.json(
        jsonError("plugin_not_enabled", `Plugin ${namespace} must be enabled to run actions`),
        409,
      );
    }

    const declaredAction = plugin.manifest.cli?.actions.find((action) => action.id === actionId);
    if (!declaredAction) {
      return c.json(
        jsonError(
          "plugin_action_not_declared",
          `Action not declared in plugin manifest: ${namespace}/${actionId}`,
        ),
        404,
      );
    }

    const grantedPermissions = plugin.manifest.permissions ?? [];
    const permissionGate = evaluatePluginPermissionGate({
      grantedPermissions,
      requiredPermissions: declaredAction.requiredPermissions ?? [],
    });
    if (!permissionGate.allowed) {
      return c.json(
        jsonError(
          "plugin_permission_denied",
          `Action ${namespace}/${actionId} requires missing permissions: ${permissionGate.missingPermissions.join(", ")}`,
        ),
        400,
      );
    }

    const pluginPath = typeof body.pluginPath === "string" ? body.pluginPath : undefined;
    const configuredRoots = [
      ...parseListInput(body.trustedRoots),
      ...(pluginPath ? [pluginPath] : []),
    ];
    const trustedRoots = resolveTrustedRoots({
      configuredRoots,
    });
    const pluginRoot = await resolvePluginRoot({
      namespace,
      trustedRoots,
      pluginPath,
    });
    const runtimeAssets = await discoverPluginRuntimeAssets({
      pluginRoot,
      trustedRoots,
      manifest: plugin.manifest,
    });
    if (!runtimeAssets.cliEntrypoint) {
      return c.json(
        jsonError(
          "plugin_entrypoint_missing",
          `No CLI entrypoint available for plugin ${namespace}`,
        ),
        400,
      );
    }

    const runtimeModule = await loadPluginRuntimeModule(runtimeAssets.cliEntrypoint.absolutePath);
    const runtimeAction = runtimeModule.cli?.actions[actionId];
    if (!runtimeAction) {
      return c.json(
        jsonError(
          "plugin_action_not_found",
          `Action not found in runtime module: ${namespace}/${actionId}`,
        ),
        404,
      );
    }

    const actorInput = isRecord(body.actor) ? body.actor : {};
    if (
      actorInput.kind !== undefined &&
      actorInput.kind !== "human" &&
      actorInput.kind !== "agent"
    ) {
      return c.json(
        jsonError("invalid_actor_kind", `Invalid actor kind: ${String(actorInput.kind)}`),
        400,
      );
    }
    const actorKind = actorInput.kind === "agent" ? "agent" : "human";
    const actorId =
      typeof actorInput.id === "string" && actorInput.id.trim().length > 0
        ? actorInput.id.trim()
        : "api-plugin-runner";
    const invocationActor: Actor = {
      kind: actorKind,
      id: actorId,
    };
    actor = invocationActor;

    const invocationRequestId =
      (typeof body.requestId === "string" && body.requestId.trim().length > 0
        ? body.requestId.trim()
        : undefined) ??
      c.req.header("x-request-id")?.trim() ??
      randomUUID();
    requestId = invocationRequestId;
    invocationStartedAtMs = Date.now();
    const inputPayload = body.input;

    const guardedExecution = await runPluginActionWithGuards({
      namespace,
      actionId,
      input: inputPayload,
      policy: {
        timeoutMs: parseOptionalPositiveInteger(body.timeoutMs),
        maxInputBytes: parseOptionalPositiveInteger(body.maxInputBytes),
        maxOutputBytes: parseOptionalPositiveInteger(body.maxOutputBytes),
        maxConcurrentInvocationsPerPlugin: parseOptionalPositiveInteger(
          body.maxConcurrentInvocationsPerPlugin ?? body.maxConcurrency,
        ),
      },
      invoke: async () =>
        runtimeAction(inputPayload, {
          plugin: {
            namespace: plugin.manifest.namespace,
            schemaVersion: plugin.manifest.schemaVersion,
          },
          invocation: {
            actorKind: invocationActor.kind,
            actorId: invocationActor.id,
            host: "api",
            requestId: invocationRequestId,
          },
          permissions: new Set(grantedPermissions),
          core: buildPluginCoreBridge(invocationActor, namespace),
          log: ({ level, message, data }) => {
            console.error(
              `[plugin:${namespace}:${actionId}] ${level} ${message}${data ? ` ${JSON.stringify(data)}` : ""}`,
            );
          },
        }),
    });
    const actionEvent = await recordPluginActionEventViaCore({
      namespace,
      actionId,
      requestId: invocationRequestId,
      actor: invocationActor,
      host: "api",
      status: "success",
      durationMs: guardedExecution.durationMs,
      inputBytes: guardedExecution.inputBytes,
      outputBytes: guardedExecution.outputBytes,
    });

    return c.json({
      namespace,
      actionId,
      requestId: invocationRequestId,
      eventId: actionEvent.eventId,
      actor: invocationActor,
      durationMs: guardedExecution.durationMs,
      inputBytes: guardedExecution.inputBytes,
      outputBytes: guardedExecution.outputBytes,
      result: guardedExecution.result,
    });
  } catch (error) {
    const mapped = mapPluginActionError(error, "Failed to run plugin action");
    if (actor && requestId) {
      const durationMs = invocationStartedAtMs
        ? Math.max(0, Date.now() - invocationStartedAtMs)
        : 0;
      await recordPluginActionEventViaCore({
        namespace,
        actionId,
        requestId,
        actor,
        host: "api",
        status: "failure",
        durationMs,
        errorCode: mapped.code,
        errorMessage: mapped.message,
      }).catch(() => undefined);
    }

    return c.json(jsonError(mapped.code, mapped.message), 400);
  }
});

app.post("/plugins/install", async (c) => {
  try {
    const body = (await c.req.json()) as {
      manifest: unknown;
      pluginPath?: string;
      registrationKind?: "static" | "dynamic";
      actor?: { kind: "human" | "agent"; id?: string };
    };

    const registerResult = await registerPluginViaCore({
      manifest: pluginManifestInputSchema.parse(body.manifest),
      registrationKind: body.registrationKind,
      actor: body.actor,
    });
    const installResult = await installPluginViaCore({
      namespace: registerResult.namespace,
      actor: body.actor,
    });

    return c.json({
      namespace: registerResult.namespace,
      created: registerResult.created,
      state: installResult.state,
      eventId: installResult.eventId,
      pluginPath: body.pluginPath ?? null,
    });
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/plugins/:namespace/enable", async (c) => {
  try {
    const namespace = c.req.param("namespace");
    const body = (await c.req.json().catch(() => ({}))) as {
      actor?: { kind: "human" | "agent"; id?: string };
    };

    return c.json(
      await enablePluginViaCore({
        namespace,
        actor: body.actor,
      }),
    );
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/plugins/:namespace/disable", async (c) => {
  try {
    const namespace = c.req.param("namespace");
    const body = (await c.req.json().catch(() => ({}))) as {
      actor?: { kind: "human" | "agent"; id?: string };
      disableReason?: string;
    };

    return c.json(
      await disablePluginViaCore({
        namespace,
        actor: body.actor,
        disableReason: body.disableReason,
      }),
    );
  } catch (error) {
    const mapped = mapCoreError(error);
    return c.json(mapped.body, mapped.status);
  }
});

app.post("/plugins/:namespace/uninstall", async (c) => {
  try {
    const namespace = c.req.param("namespace");
    const body = (await c.req.json().catch(() => ({}))) as {
      actor?: { kind: "human" | "agent"; id?: string };
    };

    return c.json(
      await uninstallPluginViaCore({
        namespace,
        actor: body.actor,
      }),
    );
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
