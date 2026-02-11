import { describe, expect, test } from "bun:test";

import { pluginManifestSchema, pluginManifestV2Schema } from "./index";

function makeV2Manifest() {
  return {
    manifestVersion: "v2" as const,
    namespace: "tasks",
    schemaVersion: "v2",
    remVersionRange: ">=0.1.0",
    capabilities: ["cli_actions", "scheduled_tasks"] as const,
    permissions: ["notes.read", "notes.write"] as const,
    notePayloadSchema: {
      type: "object" as const,
      required: ["board"],
      properties: {
        board: { type: "string" as const },
      },
      additionalProperties: false,
    },
    cli: {
      actions: [
        {
          id: "create_daily",
          title: "Create Daily",
          requiredPermissions: ["notes.read", "notes.write"] as const,
        },
      ],
    },
    scheduledTasks: [
      {
        id: "daily",
        title: "Daily",
        actionId: "create_daily",
        idempotencyKey: "calendar_slot" as const,
        schedule: {
          kind: "daily" as const,
          hour: 9,
          minute: 0,
          timezone: "America/Los_Angeles",
        },
      },
    ],
  };
}

describe("plugin manifest schemas", () => {
  test("parses v1 plugin manifest unchanged and keeps backward compatibility", () => {
    const parsed = pluginManifestSchema.parse({
      namespace: "tasks",
      schemaVersion: "v1",
      payloadSchema: {
        type: "object",
        required: ["board"],
        properties: {
          board: { type: "string" },
        },
        additionalProperties: false,
      },
    });

    expect(parsed.namespace).toBe("tasks");
    expect(parsed.schemaVersion).toBe("v1");
    expect(parsed.payloadSchema.required).toEqual(["board"]);
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.permissions).toEqual([]);
    expect(parsed.manifestVersion).toBeUndefined();
  });

  test("parses v2 manifest and normalizes notePayloadSchema to payloadSchema", () => {
    const parsed = pluginManifestSchema.parse(makeV2Manifest());

    expect(parsed.manifestVersion).toBe("v2");
    expect(parsed.capabilities).toEqual(["cli_actions", "scheduled_tasks"]);
    expect(parsed.permissions).toEqual(["notes.read", "notes.write"]);
    expect(parsed.payloadSchema.required).toEqual(["board"]);
    expect(parsed.notePayloadSchema?.required).toEqual(["board"]);
  });

  test("parses v2 legacy payloadSchema alias", () => {
    const parsed = pluginManifestSchema.parse({
      manifestVersion: "v2",
      namespace: "templates",
      schemaVersion: "v2",
      remVersionRange: ">=0.1.0",
      capabilities: ["templates"],
      permissions: [],
      payloadSchema: {
        type: "object",
        required: ["templateId"],
        properties: {
          templateId: { type: "string" },
        },
        additionalProperties: false,
      },
      templates: [
        {
          id: "daily",
          title: "Daily",
          lexicalTemplate: {
            root: {
              type: "root",
              version: 1,
              children: [],
            },
          },
        },
      ],
    });

    expect(parsed.payloadSchema.required).toEqual(["templateId"]);
    expect(parsed.notePayloadSchema?.required).toEqual(["templateId"]);
  });

  test("rejects missing capability definitions and undeclared required permissions", () => {
    const result = pluginManifestV2Schema.safeParse({
      ...makeV2Manifest(),
      capabilities: ["cli_actions"],
      scheduledTasks: undefined,
      cli: {
        actions: [
          {
            id: "create_daily",
            title: "Create Daily",
            requiredPermissions: ["events.read"],
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain(
      "cli action requiredPermission events.read must be declared in manifest permissions",
    );
  });

  test("rejects capability mismatch and missing scheduled task action bindings", () => {
    const result = pluginManifestV2Schema.safeParse({
      manifestVersion: "v2",
      namespace: "meetings",
      schemaVersion: "v1",
      remVersionRange: ">=0.1.0",
      capabilities: ["scheduled_tasks"],
      permissions: ["notes.read"],
      scheduledTasks: [
        {
          id: "missing-action",
          title: "Missing Action",
          actionId: "not-defined",
          idempotencyKey: "calendar_slot",
          schedule: {
            kind: "weekly",
            weekday: "MO",
            hour: 9,
            minute: 0,
          },
        },
      ],
      cli: {
        actions: [
          {
            id: "other",
            title: "Other",
            requiredPermissions: ["notes.read"],
          },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain("cli.actions definitions require cli_actions capability");
    expect(messages).toContain("scheduledTasks[0] actionId must reference a cli action id");
  });

  test("rejects definitions that are present without matching declared capability", () => {
    const result = pluginManifestV2Schema.safeParse({
      manifestVersion: "v2",
      namespace: "people",
      schemaVersion: "v1",
      remVersionRange: ">=0.1.0",
      capabilities: [],
      permissions: [],
      entityTypes: [
        {
          id: "person",
          title: "Person",
          schema: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain("entityTypes definitions require entities capability");
  });
});
