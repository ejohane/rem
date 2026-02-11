import { describe, expect, test } from "bun:test";

import {
  type PluginCommandSource,
  buildPluginCommandInvocationPayload,
  deriveHostedPluginCommands,
} from "./plugin-commands";

describe("plugin command host contract", () => {
  test("derives enabled plugin commands and computes permission gate status deterministically", () => {
    const plugins: PluginCommandSource[] = [
      {
        manifest: {
          namespace: "tasks",
          capabilities: ["cli_actions"],
          permissions: ["notes.read"],
          cli: {
            actions: [
              {
                id: "echo",
                title: "Echo",
              },
              {
                id: "mutate",
                title: "Mutate",
                requiredPermissions: ["notes.write"],
              },
            ],
          },
        },
        meta: {
          lifecycleState: "enabled",
        },
      },
      {
        manifest: {
          namespace: "daily",
          capabilities: ["cli_actions"],
          permissions: ["notes.read", "notes.write"],
          cli: {
            actions: [
              {
                id: "create",
                title: "Create",
                requiredPermissions: ["notes.write"],
              },
            ],
          },
        },
        meta: {
          lifecycleState: "enabled",
        },
      },
      {
        manifest: {
          namespace: "disabled",
          capabilities: ["cli_actions"],
          permissions: ["notes.read", "notes.write"],
          cli: {
            actions: [{ id: "hidden", title: "Hidden" }],
          },
        },
        meta: {
          lifecycleState: "disabled",
        },
      },
    ];

    expect(deriveHostedPluginCommands(plugins)).toEqual([
      {
        namespace: "daily",
        actionId: "create",
        title: "Create",
        requiredPermissions: ["notes.write"],
        missingPermissions: [],
        allowed: true,
      },
      {
        namespace: "tasks",
        actionId: "echo",
        title: "Echo",
        requiredPermissions: [],
        missingPermissions: [],
        allowed: true,
      },
      {
        namespace: "tasks",
        actionId: "mutate",
        title: "Mutate",
        requiredPermissions: ["notes.write"],
        missingPermissions: ["notes.write"],
        allowed: false,
      },
    ]);
  });

  test("builds UI invocation payload with actor, request id, and context snapshot", () => {
    const payload = buildPluginCommandInvocationPayload(
      {
        noteId: "note-1",
        title: "Design Notes",
        tags: ["ops", "daily"],
        plainText: "hello",
      },
      {
        actorId: "ui-user",
        requestId: "req-123",
      },
    );

    expect(payload).toEqual({
      actor: {
        kind: "human",
        id: "ui-user",
      },
      requestId: "req-123",
      input: {
        source: "ui.command",
        noteId: "note-1",
        title: "Design Notes",
        tags: ["ops", "daily"],
        plainText: "hello",
      },
    });
  });
});
