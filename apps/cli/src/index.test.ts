import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dailyNoteFixture,
  materializePluginFixture,
  meetingFixture,
  personFixture,
  templatesFixture,
} from "../../../tests/plugin-fixtures";

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

function parseJsonStdout(stdout: Uint8Array | undefined): unknown {
  const raw = Buffer.from(stdout ?? new Uint8Array())
    .toString("utf8")
    .trim();
  if (!raw) {
    throw new Error("Expected JSON stdout but command returned no output");
  }

  return JSON.parse(raw);
}

function parseTextStdout(stdout: Uint8Array | undefined): string {
  return Buffer.from(stdout ?? new Uint8Array())
    .toString("utf8")
    .trim();
}

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["bun", "run", "--cwd", "apps/cli", "src/index.ts", ...args], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("cli e2e contracts", () => {
  test("notes save + get note text roundtrip works end-to-end", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-e2e-"));
    const notePath = path.join(storeRoot, "note.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await writeFile(
        notePath,
        JSON.stringify({
          title: "CLI E2E Note",
          lexicalState: lexicalStateWithText("hello from cli"),
          tags: ["ops"],
        }),
      );

      const saveNote = runCli(["notes", "save", "--input", notePath, "--json"], env);
      expect(saveNote.exitCode).toBe(0);
      const savePayload = parseJsonStdout(saveNote.stdout) as { noteId: string };

      const getText = runCli(["get", "note", savePayload.noteId, "--format", "text"], env);
      expect(getText.exitCode).toBe(0);
      expect(parseTextStdout(getText.stdout)).toBe("hello from cli");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("emits JSON error for invalid format option", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-invalid-format-"));
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      const getInvalidFormat = runCli(
        ["get", "note", "missing-note-id", "--format", "html", "--json"],
        env,
      );
      expect(getInvalidFormat.exitCode).toBe(1);
      const payload = parseJsonStdout(getInvalidFormat.stdout) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code).toBe("invalid_format");
      expect(payload.error.message).toContain("Invalid format");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("emits JSON error for missing section target note", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-missing-note-"));
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      const missingSections = runCli(["sections", "list", "--note", "missing-note", "--json"], env);
      expect(missingSections.exitCode).toBe(1);
      const payload = parseJsonStdout(missingSections.stdout) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code).toBe("note_not_found");
      expect(payload.error.message).toContain("missing-note");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("fails note save with invalid actor override and returns JSON error", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-invalid-actor-"));
    const notePath = path.join(storeRoot, "note.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await writeFile(
        notePath,
        JSON.stringify({
          title: "Invalid actor note",
          lexicalState: lexicalStateWithText("body"),
        }),
      );

      const invalidActorSave = runCli(
        ["notes", "save", "--input", notePath, "--actor-kind", "agent", "--json"],
        env,
      );
      expect(invalidActorSave.exitCode).toBe(1);
      const payload = parseJsonStdout(invalidActorSave.stdout) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code).toBe("note_save_failed");
      expect(payload.error.message.length).toBeGreaterThan(0);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("exposes update command help", () => {
    const help = runCli(["update", "--help"], process.env);
    expect(help.exitCode).toBe(0);

    const output = parseTextStdout(help.stdout);
    expect(output).toContain("Download and install a rem release package in place");
    expect(output).toContain("Install into user-local defaults for the current");
    expect(output).toContain("--check");
    expect(output).toContain("--force");
  });

  test("registers v2 plugin manifests and preserves normalized compatibility metadata", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-v2-"));
    const manifestPath = path.join(storeRoot, "manifest-v2.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace: "tasks-v2-cli-test",
          schemaVersion: "v2",
          remVersionRange: ">=0.1.0",
          capabilities: ["templates"],
          permissions: ["notes.read", "notes.write"],
          notePayloadSchema: {
            type: "object",
            required: ["board"],
            properties: {
              board: { type: "string" },
            },
            additionalProperties: false,
          },
          templates: [
            {
              id: "daily",
              title: "Daily",
              lexicalTemplate: lexicalStateWithText("template"),
            },
          ],
        }),
      );

      const registerPlugin = runCli(
        ["plugin", "register", "--manifest", manifestPath, "--json"],
        env,
      );
      expect(registerPlugin.exitCode).toBe(0);
      const registerPayload = parseJsonStdout(registerPlugin.stdout) as {
        manifest: {
          namespace: string;
          manifestVersion?: string;
          payloadSchema: { required: string[] };
          notePayloadSchema?: { required: string[] };
        };
      };
      expect(registerPayload.manifest.namespace).toBe("tasks-v2-cli-test");
      expect(registerPayload.manifest.manifestVersion).toBe("v2");
      expect(registerPayload.manifest.payloadSchema.required).toEqual(["board"]);
      expect(registerPayload.manifest.notePayloadSchema?.required).toEqual(["board"]);

      const pluginList = runCli(["plugin", "list", "--json"], env);
      expect(pluginList.exitCode).toBe(0);
      const plugins = parseJsonStdout(pluginList.stdout) as Array<{
        manifest: { namespace: string; manifestVersion?: string };
      }>;
      const listed = plugins.find((plugin) => plugin.manifest.namespace === "tasks-v2-cli-test");
      expect(listed?.manifest.manifestVersion).toBe("v2");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("supports plugin lifecycle install, enable, disable, inspect, and uninstall commands", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-lifecycle-"));
    const manifestPath = path.join(storeRoot, "manifest-v1.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          namespace: "tasks-cli-lifecycle",
          schemaVersion: "v1",
          payloadSchema: {
            type: "object",
            required: ["board"],
            properties: {
              board: { type: "string" },
            },
            additionalProperties: false,
          },
        }),
      );

      const installPlugin = runCli(
        ["plugin", "install", "--manifest", manifestPath, "--json"],
        env,
      );
      expect(installPlugin.exitCode).toBe(0);
      const installPayload = parseJsonStdout(installPlugin.stdout) as { state: string };
      expect(installPayload.state).toBe("installed");

      const enablePlugin = runCli(["plugin", "enable", "tasks-cli-lifecycle", "--json"], env);
      expect(enablePlugin.exitCode).toBe(0);
      const enablePayload = parseJsonStdout(enablePlugin.stdout) as { state: string };
      expect(enablePayload.state).toBe("enabled");

      const inspectPlugin = runCli(["plugin", "inspect", "tasks-cli-lifecycle", "--json"], env);
      expect(inspectPlugin.exitCode).toBe(0);
      const inspectPayload = parseJsonStdout(inspectPlugin.stdout) as {
        meta: { lifecycleState: string };
      };
      expect(inspectPayload.meta.lifecycleState).toBe("enabled");

      const disablePlugin = runCli(
        ["plugin", "disable", "tasks-cli-lifecycle", "--reason", "maintenance", "--json"],
        env,
      );
      expect(disablePlugin.exitCode).toBe(0);
      const disablePayload = parseJsonStdout(disablePlugin.stdout) as {
        state: string;
        meta: { disableReason?: string };
      };
      expect(disablePayload.state).toBe("disabled");
      expect(disablePayload.meta.disableReason).toBe("maintenance");

      const uninstallPlugin = runCli(["plugin", "uninstall", "tasks-cli-lifecycle", "--json"], env);
      expect(uninstallPlugin.exitCode).toBe(0);
      const uninstallPayload = parseJsonStdout(uninstallPlugin.stdout) as { state: string };
      expect(uninstallPayload.state).toBe("registered");

      const invalidEnable = runCli(["plugin", "enable", "tasks-cli-lifecycle", "--json"], env);
      expect(invalidEnable.exitCode).toBe(1);
      const invalidEnablePayload = parseJsonStdout(invalidEnable.stdout) as {
        error: { code: string; message: string };
      };
      expect(invalidEnablePayload.error.code).toBe("plugin_enable_failed");
      expect(invalidEnablePayload.error.message).toContain("Invalid plugin lifecycle transition");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("discovers and applies plugin templates to create notes with defaults", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-templates-"));
    const manifestPath = path.join(storeRoot, "manifest-v2-template.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace: "templates-cli-test",
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
              lexicalTemplate: lexicalStateWithText("templated body"),
            },
          ],
        }),
      );

      const installPlugin = runCli(
        ["plugin", "install", "--manifest", manifestPath, "--json"],
        env,
      );
      expect(installPlugin.exitCode).toBe(0);

      const listTemplates = runCli(["plugin", "templates", "list", "--json"], env);
      expect(listTemplates.exitCode).toBe(0);
      const templates = parseJsonStdout(listTemplates.stdout) as Array<{
        namespace: string;
        available: boolean;
        template: { id: string };
      }>;
      const template = templates.find((entry) => entry.namespace === "templates-cli-test");
      expect(template?.available).toBeTrue();
      expect(template?.template.id).toBe("daily");

      const applyTemplate = runCli(
        [
          "plugin",
          "templates",
          "apply",
          "--namespace",
          "templates-cli-test",
          "--template",
          "daily",
          "--json",
        ],
        env,
      );
      expect(applyTemplate.exitCode).toBe(0);
      const applyPayload = parseJsonStdout(applyTemplate.stdout) as {
        noteId: string;
        namespace: string;
        templateId: string;
      };
      expect(applyPayload.namespace).toBe("templates-cli-test");
      expect(applyPayload.templateId).toBe("daily");

      const getDefaultNote = runCli(["get", "note", applyPayload.noteId, "--json"], env);
      expect(getDefaultNote.exitCode).toBe(0);
      const defaultNotePayload = parseJsonStdout(getDefaultNote.stdout) as {
        content: { root: { children: Array<{ type: string }> } };
        meta: { noteType: string; tags: string[] };
      };
      expect(defaultNotePayload.meta.noteType).toBe("task");
      expect(defaultNotePayload.meta.tags).toEqual(["daily", "template"]);
      expect(defaultNotePayload.content.root.children[0]?.type).toBe("paragraph");

      const applyOverride = runCli(
        [
          "plugin",
          "templates",
          "apply",
          "--namespace",
          "templates-cli-test",
          "--template",
          "daily",
          "--title",
          "Template Override",
          "--note-type",
          "journal",
          "--tags",
          "override,daily",
          "--json",
        ],
        env,
      );
      expect(applyOverride.exitCode).toBe(0);
      const applyOverridePayload = parseJsonStdout(applyOverride.stdout) as { noteId: string };

      const getOverrideNote = runCli(["get", "note", applyOverridePayload.noteId, "--json"], env);
      expect(getOverrideNote.exitCode).toBe(0);
      const overrideNotePayload = parseJsonStdout(getOverrideNote.stdout) as {
        meta: { title: string; noteType: string; tags: string[] };
      };
      expect(overrideNotePayload.meta.title).toBe("Template Override");
      expect(overrideNotePayload.meta.noteType).toBe("journal");
      expect(overrideNotePayload.meta.tags).toEqual(["daily", "template", "override"]);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("manages plugin entities through save/get/list CLI contracts", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-entities-"));
    const manifestPath = path.join(storeRoot, "manifest-v2-entities.json");
    const createEntityInputPath = path.join(storeRoot, "entity-create.json");
    const updateEntityInputPath = path.join(storeRoot, "entity-update.json");
    const invalidEntityInputPath = path.join(storeRoot, "entity-invalid.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace: "people-cli-test",
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
                  summary: { type: "string" },
                },
                additionalProperties: false,
              },
              indexes: {
                textFields: ["name", "summary"],
              },
            },
          ],
        }),
      );
      await writeFile(
        createEntityInputPath,
        JSON.stringify({
          name: "Alice",
          summary: "Platform lead",
        }),
      );
      await writeFile(
        updateEntityInputPath,
        JSON.stringify({
          data: {
            name: "Alice Updated",
            summary: "Architecture",
          },
          links: [{ kind: "note", noteId: "note-1" }],
        }),
      );
      await writeFile(
        invalidEntityInputPath,
        JSON.stringify({
          summary: "Missing required name",
        }),
      );

      const registerPlugin = runCli(
        ["plugin", "register", "--manifest", manifestPath, "--json"],
        env,
      );
      expect(registerPlugin.exitCode).toBe(0);

      const createEntity = runCli(
        [
          "entities",
          "save",
          "--namespace",
          "people-cli-test",
          "--type",
          "person",
          "--id",
          "alice",
          "--input",
          createEntityInputPath,
          "--json",
        ],
        env,
      );
      expect(createEntity.exitCode).toBe(0);
      const createPayload = parseJsonStdout(createEntity.stdout) as {
        mode: string;
        entity: { id: string; schemaVersion: string; data: { name: string } };
      };
      expect(createPayload.mode).toBe("created");
      expect(createPayload.entity.id).toBe("alice");
      expect(createPayload.entity.schemaVersion).toBe("v1");
      expect(createPayload.entity.data.name).toBe("Alice");

      const updateEntity = runCli(
        [
          "entities",
          "save",
          "--namespace",
          "people-cli-test",
          "--type",
          "person",
          "--id",
          "alice",
          "--input",
          updateEntityInputPath,
          "--json",
        ],
        env,
      );
      expect(updateEntity.exitCode).toBe(0);
      const updatePayload = parseJsonStdout(updateEntity.stdout) as {
        mode: string;
        entity: { data: { name: string; summary: string } };
        meta: { links?: Array<{ kind: string; noteId?: string }> };
      };
      expect(updatePayload.mode).toBe("updated");
      expect(updatePayload.entity.data.name).toBe("Alice Updated");
      expect(updatePayload.entity.data.summary).toBe("Architecture");
      expect(updatePayload.meta.links?.[0]?.kind).toBe("note");
      expect(updatePayload.meta.links?.[0]?.noteId).toBe("note-1");

      const getEntity = runCli(
        [
          "entities",
          "get",
          "--namespace",
          "people-cli-test",
          "--type",
          "person",
          "--id",
          "alice",
          "--json",
        ],
        env,
      );
      expect(getEntity.exitCode).toBe(0);
      const getPayload = parseJsonStdout(getEntity.stdout) as {
        entity: { id: string; data: { name: string } };
        compatibility: { mode: string };
      };
      expect(getPayload.entity.id).toBe("alice");
      expect(getPayload.entity.data.name).toBe("Alice Updated");
      expect(getPayload.compatibility.mode).toBe("current");

      const listEntities = runCli(
        [
          "entities",
          "list",
          "--namespace",
          "people-cli-test",
          "--type",
          "person",
          "--schema-version",
          "v1",
          "--json",
        ],
        env,
      );
      expect(listEntities.exitCode).toBe(0);
      const listPayload = parseJsonStdout(listEntities.stdout) as Array<{
        entity: { id: string; schemaVersion: string };
      }>;
      expect(listPayload.length).toBe(1);
      expect(listPayload[0]?.entity.id).toBe("alice");
      expect(listPayload[0]?.entity.schemaVersion).toBe("v1");

      const invalidSave = runCli(
        [
          "entities",
          "save",
          "--namespace",
          "people-cli-test",
          "--type",
          "person",
          "--id",
          "bad",
          "--input",
          invalidEntityInputPath,
          "--json",
        ],
        env,
      );
      expect(invalidSave.exitCode).toBe(1);
      const invalidPayload = parseJsonStdout(invalidSave.stdout) as {
        error: { code: string; message: string };
      };
      expect(invalidPayload.error.code).toBe("entity_save_failed");
      expect(invalidPayload.error.message).toContain("missing required field: name");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("runs deterministic plugin entity schema migrations through CLI tooling", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-entity-migrate-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "person-migrate-cli";
    const pluginRoot = path.join(trustedRoot, namespace);
    const manifestPath = path.join(storeRoot, "manifest-migrate.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, "dist", "cli.mjs"),
        [
          "export const cli = {",
          "  actions: {",
          "    migrate_person: async (input) => {",
          "      const data = input?.entity?.data ?? {};",
          "      const fullName = typeof data.name === 'string' ? data.name : data.fullName;",
          "      return {",
          "        data: {",
          "          fullName: fullName ?? 'Unknown',",
          "          bio: typeof data.bio === 'string' ? data.bio : undefined,",
          "        },",
          "        links: input?.meta?.links,",
          "      };",
          "    },",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace,
          schemaVersion: "v1",
          remVersionRange: ">=0.1.0",
          capabilities: ["entities", "cli_actions"],
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
          cli: {
            entrypoint: "dist/cli.mjs",
            actions: [
              {
                id: "migrate_person",
                title: "Migrate Person",
                requiredPermissions: ["entities.write"],
              },
            ],
          },
        }),
      );

      expect(
        runCli(["plugin", "install", "--manifest", manifestPath, "--json"], env).exitCode,
      ).toBe(0);
      expect(runCli(["plugin", "enable", namespace, "--json"], env).exitCode).toBe(0);

      expect(
        runCli(
          [
            "entities",
            "save",
            "--namespace",
            namespace,
            "--type",
            "person",
            "--id",
            "zed",
            "--input",
            '{"name":"Zed","bio":"Legacy"}',
            "--json",
          ],
          env,
        ).exitCode,
      ).toBe(0);
      expect(
        runCli(
          [
            "entities",
            "save",
            "--namespace",
            namespace,
            "--type",
            "person",
            "--id",
            "alice",
            "--input",
            '{"name":"Alice","bio":"Legacy"}',
            "--json",
          ],
          env,
        ).exitCode,
      ).toBe(0);

      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace,
          schemaVersion: "v2",
          remVersionRange: ">=0.1.0",
          capabilities: ["entities", "cli_actions"],
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
                required: ["fullName"],
                properties: {
                  fullName: { type: "string" },
                  bio: { type: "string" },
                },
                additionalProperties: false,
              },
              indexes: {
                textFields: ["fullName", "bio"],
              },
            },
          ],
          cli: {
            entrypoint: "dist/cli.mjs",
            actions: [
              {
                id: "migrate_person",
                title: "Migrate Person",
                requiredPermissions: ["entities.write"],
              },
            ],
          },
        }),
      );
      expect(
        runCli(["plugin", "register", "--manifest", manifestPath, "--json"], env).exitCode,
      ).toBe(0);

      const dryRun = runCli(
        [
          "entities",
          "migrate",
          "--namespace",
          namespace,
          "--type",
          "person",
          "--action",
          "migrate_person",
          "--from-schema-version",
          "v1",
          "--dry-run",
          "--json",
        ],
        env,
      );
      expect(dryRun.exitCode).toBe(0);
      const dryRunPayload = parseJsonStdout(dryRun.stdout) as {
        eligible: number;
        results: Array<{ id: string; status: string }>;
      };
      expect(dryRunPayload.eligible).toBe(2);
      expect(dryRunPayload.results.map((result) => result.id)).toEqual(["alice", "zed"]);
      expect(dryRunPayload.results.every((result) => result.status === "planned")).toBeTrue();

      const migrationRun = runCli(
        [
          "entities",
          "migrate",
          "--namespace",
          namespace,
          "--type",
          "person",
          "--action",
          "migrate_person",
          "--from-schema-version",
          "v1",
          "--trusted-roots",
          trustedRoot,
          "--plugin-path",
          pluginRoot,
          "--request-id",
          "cli-migrate",
          "--json",
        ],
        env,
      );
      expect(migrationRun.exitCode).toBe(0);
      const migrationPayload = parseJsonStdout(migrationRun.stdout) as {
        eligible: number;
        migrated: number;
        failed: number;
        results: Array<{ id: string; status: string }>;
      };
      expect(migrationPayload.eligible).toBe(2);
      expect(migrationPayload.migrated).toBe(2);
      expect(migrationPayload.failed).toBe(0);
      expect(migrationPayload.results.every((result) => result.status === "migrated")).toBeTrue();

      const migratedAlice = runCli(
        [
          "entities",
          "get",
          "--namespace",
          namespace,
          "--type",
          "person",
          "--id",
          "alice",
          "--json",
        ],
        env,
      );
      expect(migratedAlice.exitCode).toBe(0);
      const migratedAlicePayload = parseJsonStdout(migratedAlice.stdout) as {
        entity: { schemaVersion: string; data: { fullName: string } };
        compatibility: { mode: string };
      };
      expect(migratedAlicePayload.entity.schemaVersion).toBe("v2");
      expect(migratedAlicePayload.entity.data.fullName).toBe("Alice");
      expect(migratedAlicePayload.compatibility.mode).toBe("current");

      const rebuild = runCli(["rebuild-index", "--json"], env);
      expect(rebuild.exitCode).toBe(0);

      const migratedEntities = runCli(
        [
          "entities",
          "list",
          "--namespace",
          namespace,
          "--type",
          "person",
          "--schema-version",
          "v2",
          "--json",
        ],
        env,
      );
      expect(migratedEntities.exitCode).toBe(0);
      const migratedEntitiesPayload = parseJsonStdout(migratedEntities.stdout) as Array<{
        entity: { id: string; schemaVersion: string };
      }>;
      expect(migratedEntitiesPayload.map((entry) => entry.entity.id)).toEqual(["alice", "zed"]);
      expect(
        migratedEntitiesPayload.every((entry) => entry.entity.schemaVersion === "v2"),
      ).toBeTrue();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("runs scheduler tasks and exposes scheduler status in CLI", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-scheduler-"));
    const manifestPath = path.join(storeRoot, "manifest-v2-scheduler.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace: "scheduler-cli-test",
          schemaVersion: "v2",
          remVersionRange: ">=0.1.0",
          capabilities: ["cli_actions", "scheduled_tasks"],
          permissions: ["notes.read"],
          notePayloadSchema: {
            type: "object",
            required: [],
            properties: {},
            additionalProperties: true,
          },
          cli: {
            actions: [
              {
                id: "create_note",
                title: "Create note",
              },
            ],
          },
          scheduledTasks: [
            {
              id: "hourly",
              title: "Hourly",
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
        }),
      );

      const installPlugin = runCli(
        ["plugin", "install", "--manifest", manifestPath, "--json"],
        env,
      );
      expect(installPlugin.exitCode).toBe(0);

      const enablePlugin = runCli(["plugin", "enable", "scheduler-cli-test", "--json"], env);
      expect(enablePlugin.exitCode).toBe(0);

      const runScheduler = runCli(
        ["plugin", "scheduler", "run", "--now", "2026-02-11T10:05:00.000Z", "--json"],
        env,
      );
      expect(runScheduler.exitCode).toBe(0);
      const runPayload = parseJsonStdout(runScheduler.stdout) as {
        dueRuns: number;
        executedRuns: Array<{ taskId: string }>;
        failedRuns: Array<unknown>;
      };
      expect(runPayload.dueRuns).toBe(1);
      expect(runPayload.executedRuns.length).toBe(1);
      expect(runPayload.executedRuns[0]?.taskId).toBe("hourly");
      expect(runPayload.failedRuns.length).toBe(0);

      const schedulerStatus = runCli(["plugin", "scheduler", "status", "--json"], env);
      expect(schedulerStatus.exitCode).toBe(0);
      const statusPayload = parseJsonStdout(schedulerStatus.stdout) as {
        ledgerEntries: number;
        taskSummaries: Array<{ namespace: string; taskId: string; runs: number }>;
        recentRuns: Array<{ namespace: string; taskId: string }>;
      };
      expect(statusPayload.ledgerEntries).toBe(1);
      expect(statusPayload.taskSummaries[0]?.namespace).toBe("scheduler-cli-test");
      expect(statusPayload.taskSummaries[0]?.taskId).toBe("hourly");
      expect(statusPayload.taskSummaries[0]?.runs).toBe(1);
      expect(statusPayload.recentRuns.length).toBe(1);

      const schedulerEvents = runCli(
        ["events", "list", "--type", "plugin.task_ran", "--json"],
        env,
      );
      expect(schedulerEvents.exitCode).toBe(0);
      const schedulerEventsPayload = parseJsonStdout(schedulerEvents.stdout) as Array<{
        type: string;
        payload: { taskId: string; scheduledFor: string; startedAt: string; finishedAt: string };
      }>;
      expect(schedulerEventsPayload.length).toBe(1);
      expect(schedulerEventsPayload[0]?.type).toBe("plugin.task_ran");
      expect(schedulerEventsPayload[0]?.payload.taskId).toBe("hourly");
      expect(typeof schedulerEventsPayload[0]?.payload.scheduledFor).toBe("string");
      expect(typeof schedulerEventsPayload[0]?.payload.startedAt).toBe("string");
      expect(typeof schedulerEventsPayload[0]?.payload.finishedAt).toBe("string");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("covers daily, templates, person, and meeting fixture flows via CLI", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-fixture-matrix-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      const daily = await materializePluginFixture(trustedRoot, dailyNoteFixture);
      const templates = await materializePluginFixture(trustedRoot, templatesFixture);
      const person = await materializePluginFixture(trustedRoot, personFixture);
      const meeting = await materializePluginFixture(trustedRoot, meetingFixture);

      for (const fixture of [daily, templates, person, meeting]) {
        const install = runCli(
          ["plugin", "install", "--manifest", fixture.manifestPath, "--json"],
          env,
        );
        expect(install.exitCode).toBe(0);
      }

      const enableDaily = runCli(["plugin", "enable", daily.namespace, "--json"], env);
      expect(enableDaily.exitCode).toBe(0);
      const enableTemplates = runCli(["plugin", "enable", templates.namespace, "--json"], env);
      expect(enableTemplates.exitCode).toBe(0);

      const runDailyAction = runCli(
        [
          "plugin",
          "run",
          daily.namespace,
          "echo",
          "--trusted-roots",
          trustedRoot,
          "--request-id",
          "fixture-cli-daily-req",
          "--input",
          '{"source":"cli-fixture"}',
          "--json",
        ],
        env,
      );
      expect(runDailyAction.exitCode).toBe(0);
      const runDailyPayload = parseJsonStdout(runDailyAction.stdout) as {
        namespace: string;
        actionId: string;
        requestId: string;
      };
      expect(runDailyPayload.namespace).toBe("daily-note");
      expect(runDailyPayload.actionId).toBe("echo");
      expect(runDailyPayload.requestId).toBe("fixture-cli-daily-req");

      const schedulerRun = runCli(
        ["plugin", "scheduler", "run", "--now", "2026-02-11T10:05:00.000Z", "--json"],
        env,
      );
      expect(schedulerRun.exitCode).toBe(0);
      const schedulerPayload = parseJsonStdout(schedulerRun.stdout) as {
        executedRuns: Array<{ namespace: string; taskId: string }>;
      };
      expect(
        schedulerPayload.executedRuns.some(
          (run) => run.namespace === "daily-note" && run.taskId === "hourly-daily-note",
        ),
      ).toBeTrue();

      const applyTemplate = runCli(
        [
          "plugin",
          "templates",
          "apply",
          "--namespace",
          templates.namespace,
          "--template",
          "daily",
          "--json",
        ],
        env,
      );
      expect(applyTemplate.exitCode).toBe(0);
      const applyPayload = parseJsonStdout(applyTemplate.stdout) as {
        noteId: string;
      };
      const templatedNote = runCli(
        ["get", "note", applyPayload.noteId, "--format", "lexical", "--json"],
        env,
      );
      expect(templatedNote.exitCode).toBe(0);
      const templatedPayload = parseJsonStdout(templatedNote.stdout) as {
        meta: { tags: string[] };
      };
      expect(templatedPayload.meta.tags).toEqual(["daily", "template"]);

      const createPerson = runCli(
        [
          "entities",
          "save",
          "--namespace",
          person.namespace,
          "--type",
          "person",
          "--id",
          "alice",
          "--input",
          '{"name":"Alice","bio":"Platform"}',
          "--json",
        ],
        env,
      );
      expect(createPerson.exitCode).toBe(0);
      const createPersonPayload = parseJsonStdout(createPerson.stdout) as {
        entity: { id: string; entityType: string };
      };
      expect(createPersonPayload.entity.id).toBe("alice");
      expect(createPersonPayload.entity.entityType).toBe("person");

      const createMeeting = runCli(
        [
          "entities",
          "save",
          "--namespace",
          meeting.namespace,
          "--type",
          "meeting",
          "--id",
          "kickoff",
          "--input",
          JSON.stringify({
            data: {
              title: "Kickoff",
              attendees: ["alice"],
              agenda: "Roadmap and ownership",
            },
            links: [
              {
                kind: "entity",
                namespace: person.namespace,
                entityType: "person",
                entityId: "alice",
              },
            ],
          }),
          "--json",
        ],
        env,
      );
      expect(createMeeting.exitCode).toBe(0);
      const createMeetingPayload = parseJsonStdout(createMeeting.stdout) as {
        entity: { id: string; entityType: string };
        meta: {
          links?: Array<{
            kind: string;
            namespace?: string;
            entityType?: string;
            entityId?: string;
          }>;
        };
      };
      expect(createMeetingPayload.entity.id).toBe("kickoff");
      expect(createMeetingPayload.entity.entityType).toBe("meeting");
      expect(createMeetingPayload.meta.links?.[0]?.kind).toBe("entity");
      expect(createMeetingPayload.meta.links?.[0]?.namespace).toBe("person");
      expect(createMeetingPayload.meta.links?.[0]?.entityType).toBe("person");
      expect(createMeetingPayload.meta.links?.[0]?.entityId).toBe("alice");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("invokes plugin runtime actions with typed invocation context via CLI", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-run-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "runtime-cli-invoke";
    const pluginRoot = path.join(trustedRoot, namespace);
    const manifestPath = path.join(storeRoot, "manifest-v2-runtime.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, "dist", "cli.mjs"),
        [
          "export const cli = {",
          "  actions: {",
          "    echo: async (input, ctx) => ({",
          "      input,",
          "      requestId: ctx.invocation.requestId,",
          "      actorKind: ctx.invocation.actorKind,",
          "      actorId: ctx.invocation.actorId,",
          "      namespace: ctx.plugin.namespace,",
          "      permissions: Array.from(ctx.permissions),",
          "    }),",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace,
          schemaVersion: "v2",
          remVersionRange: ">=0.1.0",
          capabilities: ["cli_actions"],
          permissions: ["notes.read"],
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
              },
            ],
          },
        }),
      );

      const installPlugin = runCli(
        ["plugin", "install", "--manifest", manifestPath, "--json"],
        env,
      );
      expect(installPlugin.exitCode).toBe(0);

      const enablePlugin = runCli(["plugin", "enable", namespace, "--json"], env);
      expect(enablePlugin.exitCode).toBe(0);

      const runAction = runCli(
        [
          "plugin",
          "run",
          namespace,
          "echo",
          "--input",
          '{"value":42}',
          "--trusted-roots",
          trustedRoot,
          "--request-id",
          "req-cli-123",
          "--actor-kind",
          "agent",
          "--actor-id",
          "cli-agent",
          "--json",
        ],
        env,
      );
      expect(runAction.exitCode).toBe(0);
      const runPayload = parseJsonStdout(runAction.stdout) as {
        namespace: string;
        actionId: string;
        requestId: string;
        eventId: string;
        actor: { kind: string; id?: string };
        result: {
          input: { value: number };
          requestId: string;
          actorKind: string;
          actorId?: string;
          namespace: string;
          permissions: string[];
        };
      };
      expect(runPayload.namespace).toBe(namespace);
      expect(runPayload.actionId).toBe("echo");
      expect(runPayload.requestId).toBe("req-cli-123");
      expect(typeof runPayload.eventId).toBe("string");
      expect(runPayload.actor.kind).toBe("agent");
      expect(runPayload.actor.id).toBe("cli-agent");
      expect(runPayload.result.input.value).toBe(42);
      expect(runPayload.result.requestId).toBe("req-cli-123");
      expect(runPayload.result.actorKind).toBe("agent");
      expect(runPayload.result.actorId).toBe("cli-agent");
      expect(runPayload.result.namespace).toBe(namespace);
      expect(runPayload.result.permissions).toEqual(["notes.read"]);

      const actionEvents = runCli(
        ["events", "list", "--type", "plugin.action_invoked", "--entity-id", namespace, "--json"],
        env,
      );
      expect(actionEvents.exitCode).toBe(0);
      const actionEventsPayload = parseJsonStdout(actionEvents.stdout) as Array<{
        payload: {
          namespace: string;
          actionId: string;
          requestId: string;
          actorKind: string;
          durationMs: number;
          status: string;
        };
      }>;
      expect(actionEventsPayload.length).toBe(1);
      expect(actionEventsPayload[0]?.payload.namespace).toBe(namespace);
      expect(actionEventsPayload[0]?.payload.actionId).toBe("echo");
      expect(actionEventsPayload[0]?.payload.requestId).toBe("req-cli-123");
      expect(actionEventsPayload[0]?.payload.actorKind).toBe("agent");
      expect(actionEventsPayload[0]?.payload.status).toBe("success");
      expect(typeof actionEventsPayload[0]?.payload.durationMs).toBe("number");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("enforces proposal-first trust policy for agent note writes in plugin runtime", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-trust-policy-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "runtime-cli-trust";
    const pluginRoot = path.join(trustedRoot, namespace);
    const manifestPath = path.join(storeRoot, "manifest-v2-trust.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, "dist", "cli.mjs"),
        [
          "const lexical = {",
          "  root: {",
          "    type: 'root',",
          "    version: 1,",
          "    children: [",
          "      {",
          "        type: 'paragraph',",
          "        version: 1,",
          "        children: [{ type: 'text', version: 1, text: 'agent write' }],",
          "      },",
          "    ],",
          "  },",
          "};",
          "export const cli = {",
          "  actions: {",
          "    unsafe_write: async (_input, ctx) => {",
          "      return ctx.core.saveNote({ title: 'Unsafe agent write', lexicalState: lexical });",
          "    },",
          "    override_write: async (_input, ctx) => {",
          "      return ctx.core.saveNote({",
          "        title: 'Approved agent write',",
          "        lexicalState: lexical,",
          "        overrideReason: 'approved_automation_window',",
          "        approvedBy: 'human-reviewer',",
          "      });",
          "    },",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace,
          schemaVersion: "v2",
          remVersionRange: ">=0.1.0",
          capabilities: ["cli_actions"],
          permissions: ["notes.write"],
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
                id: "unsafe_write",
                title: "Unsafe Write",
                requiredPermissions: ["notes.write"],
              },
              {
                id: "override_write",
                title: "Override Write",
                requiredPermissions: ["notes.write"],
              },
            ],
          },
        }),
      );

      expect(
        runCli(["plugin", "install", "--manifest", manifestPath, "--json"], env).exitCode,
      ).toBe(0);
      expect(runCli(["plugin", "enable", namespace, "--json"], env).exitCode).toBe(0);

      const blockedWrite = runCli(
        [
          "plugin",
          "run",
          namespace,
          "unsafe_write",
          "--trusted-roots",
          trustedRoot,
          "--actor-kind",
          "agent",
          "--actor-id",
          "agent-runtime",
          "--json",
        ],
        env,
      );
      expect(blockedWrite.exitCode).toBe(1);
      const blockedPayload = parseJsonStdout(blockedWrite.stdout) as {
        error: { code: string; message: string };
      };
      expect(blockedPayload.error.code).toBe("plugin_run_failed");
      expect(blockedPayload.error.message).toContain("must use core.createProposal");

      const overrideWrite = runCli(
        [
          "plugin",
          "run",
          namespace,
          "override_write",
          "--trusted-roots",
          trustedRoot,
          "--actor-kind",
          "agent",
          "--actor-id",
          "agent-runtime",
          "--json",
        ],
        env,
      );
      expect(overrideWrite.exitCode).toBe(0);
      const overridePayload = parseJsonStdout(overrideWrite.stdout) as {
        result: { noteId: string };
      };
      expect(typeof overridePayload.result.noteId).toBe("string");

      const noteEvents = runCli(["events", "list", "--type", "note.created", "--json"], env);
      expect(noteEvents.exitCode).toBe(0);
      const noteEventsPayload = parseJsonStdout(noteEvents.stdout) as Array<{
        payload: {
          noteId: string;
          overrideReason?: string;
          approvedBy?: string;
          sourcePlugin?: string;
        };
      }>;
      const overrideEvent = noteEventsPayload.find(
        (event) => event.payload.noteId === overridePayload.result.noteId,
      );
      expect(overrideEvent?.payload.overrideReason).toBe("approved_automation_window");
      expect(overrideEvent?.payload.approvedBy).toBe("human-reviewer");
      expect(overrideEvent?.payload.sourcePlugin).toBe(namespace);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("blocks plugin action invocation until explicit re-enable after permission expansion", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-permission-gating-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "runtime-cli-gating";
    const pluginRoot = path.join(trustedRoot, namespace);
    const manifestPath = path.join(storeRoot, "manifest-v2-gating.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, "dist", "cli.mjs"),
        [
          "export const cli = {",
          "  actions: {",
          "    echo: async () => ({ ok: true }),",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      const baseManifest = {
        manifestVersion: "v2",
        namespace,
        schemaVersion: "v2",
        remVersionRange: ">=0.1.0",
        capabilities: ["cli_actions"],
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
          ],
        },
      };

      await writeFile(
        manifestPath,
        JSON.stringify({
          ...baseManifest,
          permissions: ["notes.read"],
        }),
      );

      expect(
        runCli(["plugin", "install", "--manifest", manifestPath, "--json"], env).exitCode,
      ).toBe(0);
      expect(runCli(["plugin", "enable", namespace, "--json"], env).exitCode).toBe(0);

      const initialRun = runCli(
        ["plugin", "run", namespace, "echo", "--trusted-roots", trustedRoot, "--json"],
        env,
      );
      expect(initialRun.exitCode).toBe(0);

      await writeFile(
        manifestPath,
        JSON.stringify({
          ...baseManifest,
          permissions: ["notes.read", "notes.write"],
        }),
      );
      const updatedManifest = runCli(
        ["plugin", "register", "--manifest", manifestPath, "--json"],
        env,
      );
      expect(updatedManifest.exitCode).toBe(0);
      const updatedPayload = parseJsonStdout(updatedManifest.stdout) as {
        meta: { lifecycleState: string; disableReason?: string };
      };
      expect(updatedPayload.meta.lifecycleState).toBe("disabled");
      expect(updatedPayload.meta.disableReason).toBe("permissions_expanded");

      const blockedRun = runCli(
        ["plugin", "run", namespace, "echo", "--trusted-roots", trustedRoot, "--json"],
        env,
      );
      expect(blockedRun.exitCode).toBe(1);
      const blockedPayload = parseJsonStdout(blockedRun.stdout) as {
        error: { code: string; message: string };
      };
      expect(blockedPayload.error.code).toBe("plugin_not_enabled");
      expect(blockedPayload.error.message).toContain("must be enabled");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("returns deterministic guard error codes for runtime timeout policy violations", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-plugin-timeout-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "runtime-cli-timeout";
    const pluginRoot = path.join(trustedRoot, namespace);
    const manifestPath = path.join(storeRoot, "manifest-v2-timeout.json");
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, "dist", "cli.mjs"),
        [
          "export const cli = {",
          "  actions: {",
          "    slow: async () => {",
          "      await new Promise((resolve) => setTimeout(resolve, 25));",
          "      return { ok: true };",
          "    },",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      await writeFile(
        manifestPath,
        JSON.stringify({
          manifestVersion: "v2",
          namespace,
          schemaVersion: "v2",
          remVersionRange: ">=0.1.0",
          capabilities: ["cli_actions"],
          permissions: ["notes.read"],
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
                id: "slow",
                title: "Slow",
              },
            ],
          },
        }),
      );

      expect(
        runCli(["plugin", "install", "--manifest", manifestPath, "--json"], env).exitCode,
      ).toBe(0);
      expect(runCli(["plugin", "enable", namespace, "--json"], env).exitCode).toBe(0);

      const timeoutRun = runCli(
        [
          "plugin",
          "run",
          namespace,
          "slow",
          "--trusted-roots",
          trustedRoot,
          "--timeout-ms",
          "1",
          "--json",
        ],
        env,
      );
      expect(timeoutRun.exitCode).toBe(1);
      const timeoutPayload = parseJsonStdout(timeoutRun.stdout) as {
        error: { code: string; message: string };
      };
      expect(timeoutPayload.error.code).toBe("plugin_action_timeout");
      expect(timeoutPayload.error.message).toContain("timed out");

      const failedEvents = runCli(
        ["events", "list", "--type", "plugin.action_failed", "--entity-id", namespace, "--json"],
        env,
      );
      expect(failedEvents.exitCode).toBe(0);
      const failedEventsPayload = parseJsonStdout(failedEvents.stdout) as Array<{
        payload: {
          namespace: string;
          actionId: string;
          status: string;
          errorCode: string;
          requestId: string;
        };
      }>;
      expect(failedEventsPayload.length).toBe(1);
      expect(failedEventsPayload[0]?.payload.namespace).toBe(namespace);
      expect(failedEventsPayload[0]?.payload.actionId).toBe("slow");
      expect(failedEventsPayload[0]?.payload.status).toBe("failure");
      expect(failedEventsPayload[0]?.payload.errorCode).toBe("plugin_action_timeout");
      expect(typeof failedEventsPayload[0]?.payload.requestId).toBe("string");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("lists and installs bundled canned skill into the vault", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-skill-install-"));
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      const listSkills = runCli(["skill", "list", "--json"], env);
      expect(listSkills.exitCode).toBe(0);
      const listed = parseJsonStdout(listSkills.stdout) as Array<{
        id: string;
        name: string;
      }>;
      expect(listed.some((skill) => skill.id === "rem-cli-memory")).toBeTrue();
      expect(listed.some((skill) => skill.name === "rem")).toBeTrue();

      const installSkill = runCli(["skill", "install", "rem-cli-memory", "--json"], env);
      expect(installSkill.exitCode).toBe(0);
      const installPayload = parseJsonStdout(installSkill.stdout) as {
        skillId: string;
        pluginNamespace: string;
        noteId: string;
        noteCreated: boolean;
        pluginRegistered: boolean;
      };

      expect(installPayload.skillId).toBe("rem-cli-memory");
      expect(installPayload.pluginNamespace).toBe("agent-skills");
      expect(installPayload.noteId).toBe("skill-rem-cli-memory");
      expect(installPayload.noteCreated).toBeTrue();
      expect(installPayload.pluginRegistered).toBeTrue();

      const pluginList = runCli(["plugin", "list", "--json"], env);
      expect(pluginList.exitCode).toBe(0);
      const plugins = parseJsonStdout(pluginList.stdout) as Array<{
        manifest: { namespace: string };
      }>;
      expect(plugins.some((plugin) => plugin.manifest.namespace === "agent-skills")).toBeTrue();

      const getSkillNote = runCli(["get", "note", "skill-rem-cli-memory", "--format", "text"], env);
      expect(getSkillNote.exitCode).toBe(0);
      const noteText = parseTextStdout(getSkillNote.stdout);
      expect(noteText).toContain("REM CLI Operator Workflow");
      expect(noteText).toContain("Progressive Disclosure");
      expect(noteText).toContain("Memory Recall and Context");
      expect(noteText).toContain("Plugin Workflows");

      const reinstallSkill = runCli(["skill", "install", "rem-cli-memory", "--json"], env);
      expect(reinstallSkill.exitCode).toBe(0);
      const reinstallPayload = parseJsonStdout(reinstallSkill.stdout) as {
        noteCreated: boolean;
        pluginRegistered: boolean;
      };
      expect(reinstallPayload.noteCreated).toBeFalse();
      expect(reinstallPayload.pluginRegistered).toBeFalse();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("returns skill_not_found for unknown canned skill install id", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-cli-skill-missing-"));
    const env = {
      ...process.env,
      REM_STORE_ROOT: storeRoot,
    };

    try {
      const installMissing = runCli(["skill", "install", "missing-skill-id", "--json"], env);
      expect(installMissing.exitCode).toBe(1);
      const payload = parseJsonStdout(installMissing.stdout) as {
        error: { code: string; message: string };
      };
      expect(payload.error.code).toBe("skill_not_found");
      expect(payload.error.message).toContain("missing-skill-id");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
