import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type PluginFixture = {
  manifest: Record<string, unknown>;
  cliRuntimeSource?: string;
};

function lexicalStateWithText(text: string): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "paragraph",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text,
            },
          ],
        },
      ],
    },
  };
}

export const dailyNoteFixture: PluginFixture = {
  manifest: {
    manifestVersion: "v2",
    namespace: "daily-note",
    schemaVersion: "v2",
    remVersionRange: ">=0.1.0",
    capabilities: ["cli_actions", "scheduled_tasks"],
    permissions: ["notes.read", "notes.write"],
    notePayloadSchema: {
      type: "object",
      required: [],
      properties: {},
      additionalProperties: true,
    },
    cli: {
      entrypoint: "dist/cli.mjs",
      actions: [
        {
          id: "echo",
          title: "Echo",
          requiredPermissions: ["notes.read"],
        },
        {
          id: "create_note",
          title: "Create Daily Note",
          requiredPermissions: ["notes.write"],
        },
      ],
    },
    scheduledTasks: [
      {
        id: "hourly-daily-note",
        title: "Hourly Daily Note",
        actionId: "create_note",
        idempotencyKey: "calendar_slot",
        runWindowMinutes: 15,
        schedule: {
          kind: "hourly",
          minute: 0,
          timezone: "UTC",
        },
      },
    ],
  },
  cliRuntimeSource: [
    `const lexical = ${JSON.stringify(lexicalStateWithText("daily fixture note body"))};`,
    "export const cli = {",
    "  actions: {",
    "    echo: async (input, ctx) => ({",
    "      ok: true,",
    "      requestId: ctx.invocation.requestId,",
    "      host: ctx.invocation.host,",
    "      input,",
    "    }),",
    "    create_note: async (_input, ctx) => {",
    "      return ctx.core.saveNote({",
    "        title: 'Daily Fixture Note',",
    "        lexicalState: lexical,",
    "        noteType: 'task',",
    "        tags: ['daily', 'fixture'],",
    "      });",
    "    },",
    "  },",
    "};",
    "",
  ].join("\n"),
};

export const templatesFixture: PluginFixture = {
  manifest: {
    manifestVersion: "v2",
    namespace: "templates",
    schemaVersion: "v2",
    remVersionRange: ">=0.1.0",
    capabilities: ["templates"],
    permissions: ["notes.read", "notes.write"],
    notePayloadSchema: {
      type: "object",
      required: [],
      properties: {},
      additionalProperties: true,
    },
    templates: [
      {
        id: "daily",
        title: "Daily Template",
        defaultNoteType: "task",
        defaultTags: ["daily", "template"],
        lexicalTemplate: lexicalStateWithText("templates fixture body"),
      },
    ],
  },
};

export const personFixture: PluginFixture = {
  manifest: {
    manifestVersion: "v2",
    namespace: "person",
    schemaVersion: "v1",
    remVersionRange: ">=0.1.0",
    capabilities: ["entities"],
    permissions: ["entities.read", "entities.write"],
    notePayloadSchema: {
      type: "object",
      required: [],
      properties: {},
      additionalProperties: true,
    },
    entityTypes: [
      {
        id: "person",
        title: "Person",
        schema: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            bio: { type: "string" },
          },
          additionalProperties: false,
        },
        indexes: {
          textFields: ["name", "bio"],
        },
      },
    ],
  },
};

export const meetingFixture: PluginFixture = {
  manifest: {
    manifestVersion: "v2",
    namespace: "meeting",
    schemaVersion: "v1",
    remVersionRange: ">=0.1.0",
    capabilities: ["entities"],
    permissions: ["entities.read", "entities.write"],
    notePayloadSchema: {
      type: "object",
      required: [],
      properties: {},
      additionalProperties: true,
    },
    entityTypes: [
      {
        id: "meeting",
        title: "Meeting",
        schema: {
          type: "object",
          required: ["title", "attendees"],
          properties: {
            title: { type: "string" },
            attendees: {
              type: "array",
              items: { type: "string" },
            },
            agenda: { type: "string" },
          },
          additionalProperties: false,
        },
        indexes: {
          textFields: ["title", "agenda"],
        },
      },
    ],
  },
};

export const pluginFixtureMatrix = [
  dailyNoteFixture,
  templatesFixture,
  personFixture,
  meetingFixture,
];

export type MaterializedPluginFixture = {
  namespace: string;
  manifestPath: string;
  pluginRoot: string;
  manifest: Record<string, unknown>;
};

function cloneManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}

export async function materializePluginFixture(
  fixturesRoot: string,
  fixture: PluginFixture,
): Promise<MaterializedPluginFixture> {
  const manifest = cloneManifest(fixture.manifest);
  const namespace = String(manifest.namespace);
  const pluginRoot = path.join(fixturesRoot, namespace);
  const manifestPath = path.join(pluginRoot, "manifest.json");

  await mkdir(pluginRoot, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const cliEntrypoint =
    typeof (manifest.cli as { entrypoint?: unknown } | undefined)?.entrypoint === "string"
      ? ((manifest.cli as { entrypoint: string }).entrypoint as string)
      : undefined;

  if (fixture.cliRuntimeSource && cliEntrypoint) {
    const absoluteEntrypoint = path.join(pluginRoot, cliEntrypoint);
    await mkdir(path.dirname(absoluteEntrypoint), { recursive: true });
    await writeFile(absoluteEntrypoint, fixture.cliRuntimeSource, "utf8");
  }

  return {
    namespace,
    manifestPath,
    pluginRoot,
    manifest,
  };
}
