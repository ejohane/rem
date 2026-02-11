import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dailyNoteFixture,
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

function lexicalStateWithHeadingAndParagraph(heading: string, text: string): unknown {
  return {
    root: {
      type: "root",
      version: 1,
      children: [
        {
          type: "heading",
          tag: "h2",
          version: 1,
          children: [
            {
              type: "text",
              version: 1,
              text: heading,
            },
          ],
        },
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

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not resolve free port")));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForApiReady(url: string, init?: RequestInit): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return;
      }
      lastError = new Error(`API status returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`API did not become ready: ${String(lastError)}`);
}

describe("api route contracts", () => {
  test("rejects PUT note id mismatch between route and payload", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-routes-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const createNoteResponse = await fetch(`${apiBaseUrl}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Mismatch note",
          lexicalState: lexicalStateWithText("content"),
        }),
      });
      expect(createNoteResponse.status).toBe(200);
      const createNotePayload = (await createNoteResponse.json()) as { noteId: string };

      const mismatchResponse = await fetch(`${apiBaseUrl}/notes/${createNotePayload.noteId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "different-note-id",
          title: "Mismatch note updated",
          lexicalState: lexicalStateWithText("updated"),
        }),
      });
      expect(mismatchResponse.status).toBe(400);
      const mismatchPayload = (await mismatchResponse.json()) as {
        error: { code: string; message: string };
      };
      expect(mismatchPayload.error.code).toBe("note_id_mismatch");
      expect(mismatchPayload.error.message).toContain("does not match route id");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("returns missing_note_id and note_not_found for sections query validation", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-sections-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const missingQueryResponse = await fetch(`${apiBaseUrl}/sections`);
      expect(missingQueryResponse.status).toBe(400);
      const missingQueryPayload = (await missingQueryResponse.json()) as {
        error: { code: string };
      };
      expect(missingQueryPayload.error.code).toBe("missing_note_id");

      const missingNoteResponse = await fetch(`${apiBaseUrl}/sections?noteId=missing-note`);
      expect(missingNoteResponse.status).toBe(404);
      const missingNotePayload = (await missingNoteResponse.json()) as {
        error: { code: string };
      };
      expect(missingNotePayload.error.code).toBe("note_not_found");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("registers v2 plugin manifests and preserves normalized compatibility metadata", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-v2-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const registerResponse = await fetch(`${apiBaseUrl}/plugins/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
            manifestVersion: "v2",
            namespace: "tasks-v2-api-test",
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
          },
          actor: { kind: "human", id: "api-plugin-admin" },
        }),
      });
      expect(registerResponse.status).toBe(200);
      const registerPayload = (await registerResponse.json()) as {
        manifest: {
          manifestVersion?: string;
          payloadSchema: { required: string[] };
          notePayloadSchema?: { required: string[] };
        };
      };
      expect(registerPayload.manifest.manifestVersion).toBe("v2");
      expect(registerPayload.manifest.payloadSchema.required).toEqual(["board"]);
      expect(registerPayload.manifest.notePayloadSchema?.required).toEqual(["board"]);

      const listResponse = await fetch(`${apiBaseUrl}/plugins`);
      expect(listResponse.status).toBe(200);
      const listed = (await listResponse.json()) as Array<{
        manifest: { namespace: string; manifestVersion?: string };
      }>;
      const plugin = listed.find((item) => item.manifest.namespace === "tasks-v2-api-test");
      expect(plugin?.manifest.manifestVersion).toBe("v2");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("supports plugin lifecycle install, inspect, enable, disable, and uninstall routes", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-lifecycle-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const installResponse = await fetch(`${apiBaseUrl}/plugins/install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
            namespace: "tasks-api-lifecycle",
            schemaVersion: "v1",
            payloadSchema: {
              type: "object",
              required: ["board"],
              properties: {
                board: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        }),
      });
      expect(installResponse.status).toBe(200);
      const installPayload = (await installResponse.json()) as { state: string };
      expect(installPayload.state).toBe("installed");

      const inspectInstalled = await fetch(`${apiBaseUrl}/plugins/tasks-api-lifecycle`);
      expect(inspectInstalled.status).toBe(200);
      const inspectInstalledPayload = (await inspectInstalled.json()) as {
        meta: { lifecycleState: string };
      };
      expect(inspectInstalledPayload.meta.lifecycleState).toBe("installed");

      const enableResponse = await fetch(`${apiBaseUrl}/plugins/tasks-api-lifecycle/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(enableResponse.status).toBe(200);
      const enablePayload = (await enableResponse.json()) as { state: string };
      expect(enablePayload.state).toBe("enabled");

      const disableResponse = await fetch(`${apiBaseUrl}/plugins/tasks-api-lifecycle/disable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          disableReason: "maintenance",
        }),
      });
      expect(disableResponse.status).toBe(200);
      const disablePayload = (await disableResponse.json()) as {
        state: string;
        meta: { disableReason?: string };
      };
      expect(disablePayload.state).toBe("disabled");
      expect(disablePayload.meta.disableReason).toBe("maintenance");

      const uninstallResponse = await fetch(`${apiBaseUrl}/plugins/tasks-api-lifecycle/uninstall`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(uninstallResponse.status).toBe(200);
      const uninstallPayload = (await uninstallResponse.json()) as { state: string };
      expect(uninstallPayload.state).toBe("registered");

      const invalidEnableResponse = await fetch(
        `${apiBaseUrl}/plugins/tasks-api-lifecycle/enable`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(invalidEnableResponse.status).toBe(409);
      const invalidEnablePayload = (await invalidEnableResponse.json()) as {
        error: { code: string; message: string };
      };
      expect(invalidEnablePayload.error.code).toBe("invalid_transition");
      expect(invalidEnablePayload.error.message).toContain("Invalid plugin lifecycle transition");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("invokes plugin runtime actions via API with request-id propagation and guard mapping", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-run-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "runtime-api-invoke";
    const pluginRoot = path.join(trustedRoot, namespace);
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

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
          "      host: ctx.invocation.host,",
          "      namespace: ctx.plugin.namespace,",
          "      permissions: Array.from(ctx.permissions).sort(),",
          "    }),",
          "    slow: async () => {",
          "      await new Promise((resolve) => setTimeout(resolve, 50));",
          "      return { ok: true };",
          "    },",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      await waitForApiReady(`${apiBaseUrl}/status`);

      const installResponse = await fetch(`${apiBaseUrl}/plugins/install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
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
                  requiredPermissions: ["notes.read"],
                },
                {
                  id: "slow",
                  title: "Slow",
                },
              ],
            },
          },
        }),
      });
      expect(installResponse.status).toBe(200);

      const enableResponse = await fetch(`${apiBaseUrl}/plugins/${namespace}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(enableResponse.status).toBe(200);

      const runEcho = await fetch(`${apiBaseUrl}/plugins/${namespace}/actions/echo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req-header-123",
        },
        body: JSON.stringify({
          input: {
            hello: "api",
          },
          pluginPath: pluginRoot,
          trustedRoots: [trustedRoot],
          actor: {
            kind: "agent",
            id: "api-plugin-runner",
          },
          timeoutMs: 5000,
          maxInputBytes: 65536,
          maxOutputBytes: 65536,
          maxConcurrency: 2,
        }),
      });
      expect(runEcho.status).toBe(200);
      const runEchoPayload = (await runEcho.json()) as {
        namespace: string;
        actionId: string;
        requestId: string;
        eventId: string;
        actor: { kind: string; id?: string };
        result: {
          input: { hello: string };
          requestId: string;
          actorKind: string;
          actorId: string;
          host: string;
          namespace: string;
          permissions: string[];
        };
      };
      expect(runEchoPayload.namespace).toBe(namespace);
      expect(runEchoPayload.actionId).toBe("echo");
      expect(runEchoPayload.requestId).toBe("req-header-123");
      expect(typeof runEchoPayload.eventId).toBe("string");
      expect(runEchoPayload.actor.kind).toBe("agent");
      expect(runEchoPayload.actor.id).toBe("api-plugin-runner");
      expect(runEchoPayload.result.input.hello).toBe("api");
      expect(runEchoPayload.result.requestId).toBe("req-header-123");
      expect(runEchoPayload.result.actorKind).toBe("agent");
      expect(runEchoPayload.result.actorId).toBe("api-plugin-runner");
      expect(runEchoPayload.result.host).toBe("api");
      expect(runEchoPayload.result.namespace).toBe(namespace);
      expect(runEchoPayload.result.permissions).toEqual(["notes.read"]);

      const invokedEventsResponse = await fetch(
        `${apiBaseUrl}/events?type=plugin.action_invoked&entityKind=plugin&entityId=${namespace}`,
      );
      expect(invokedEventsResponse.status).toBe(200);
      const invokedEventsPayload = (await invokedEventsResponse.json()) as Array<{
        payload: {
          namespace: string;
          actionId: string;
          requestId: string;
          actorKind: string;
          durationMs: number;
          status: string;
        };
      }>;
      expect(invokedEventsPayload.length).toBe(1);
      expect(invokedEventsPayload[0]?.payload.namespace).toBe(namespace);
      expect(invokedEventsPayload[0]?.payload.actionId).toBe("echo");
      expect(invokedEventsPayload[0]?.payload.requestId).toBe("req-header-123");
      expect(invokedEventsPayload[0]?.payload.actorKind).toBe("agent");
      expect(invokedEventsPayload[0]?.payload.status).toBe("success");
      expect(typeof invokedEventsPayload[0]?.payload.durationMs).toBe("number");

      const timeoutRun = await fetch(`${apiBaseUrl}/plugins/${namespace}/actions/slow`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pluginPath: pluginRoot,
          trustedRoots: [trustedRoot],
          timeoutMs: 1,
        }),
      });
      expect(timeoutRun.status).toBe(400);
      const timeoutPayload = (await timeoutRun.json()) as {
        error: { code: string; message: string };
      };
      expect(timeoutPayload.error.code).toBe("plugin_action_timeout");
      expect(timeoutPayload.error.message).toContain("timed out");

      const failedEventsResponse = await fetch(
        `${apiBaseUrl}/events?type=plugin.action_failed&entityKind=plugin&entityId=${namespace}`,
      );
      expect(failedEventsResponse.status).toBe(200);
      const failedEventsPayload = (await failedEventsResponse.json()) as Array<{
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
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("enforces bearer token auth parity for API-triggered plugin actions", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-auth-parity-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "runtime-api-auth";
    const pluginRoot = path.join(trustedRoot, namespace);
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const token = "api-plugin-auth-token";
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
        REM_API_TOKEN: token,
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, "dist", "cli.mjs"),
        [
          "export const cli = {",
          "  actions: {",
          "    echo: async (input) => ({ ok: true, input }),",
          "  },",
          "};",
          "",
        ].join("\n"),
      );

      await waitForApiReady(`${apiBaseUrl}/status`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const installResponse = await fetch(`${apiBaseUrl}/plugins/install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          manifest: {
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
          },
        }),
      });
      expect(installResponse.status).toBe(200);

      const enableResponse = await fetch(`${apiBaseUrl}/plugins/${namespace}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: "{}",
      });
      expect(enableResponse.status).toBe(200);

      const missingTokenRun = await fetch(`${apiBaseUrl}/plugins/${namespace}/actions/echo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pluginPath: pluginRoot,
          trustedRoots: [trustedRoot],
          input: { ok: true },
        }),
      });
      expect(missingTokenRun.status).toBe(401);
      const missingTokenPayload = (await missingTokenRun.json()) as {
        error: { code: string; message: string };
      };
      expect(missingTokenPayload.error.code).toBe("unauthorized");

      const wrongTokenRun = await fetch(`${apiBaseUrl}/plugins/${namespace}/actions/echo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({
          pluginPath: pluginRoot,
          trustedRoots: [trustedRoot],
          input: { ok: true },
        }),
      });
      expect(wrongTokenRun.status).toBe(401);

      const authorizedRun = await fetch(`${apiBaseUrl}/plugins/${namespace}/actions/echo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          pluginPath: pluginRoot,
          trustedRoots: [trustedRoot],
          input: { ok: true },
        }),
      });
      expect(authorizedRun.status).toBe(200);
      const authorizedRunPayload = (await authorizedRun.json()) as {
        namespace: string;
        actionId: string;
      };
      expect(authorizedRunPayload.namespace).toBe(namespace);
      expect(authorizedRunPayload.actionId).toBe("echo");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("enforces proposal-first policy for agent plugin note writes via API runtime", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-trust-policy-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "runtime-api-trust";
    const pluginRoot = path.join(trustedRoot, namespace);
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

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
          "      return ctx.core.saveNote({ title: 'Unsafe API write', lexicalState: lexical });",
          "    },",
          "    override_write: async (_input, ctx) => {",
          "      return ctx.core.saveNote({",
          "        title: 'Approved API write',",
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

      await waitForApiReady(`${apiBaseUrl}/status`);

      const installResponse = await fetch(`${apiBaseUrl}/plugins/install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
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
                  title: "Unsafe",
                  requiredPermissions: ["notes.write"],
                },
                {
                  id: "override_write",
                  title: "Override",
                  requiredPermissions: ["notes.write"],
                },
              ],
            },
          },
        }),
      });
      expect(installResponse.status).toBe(200);

      const enableResponse = await fetch(`${apiBaseUrl}/plugins/${namespace}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(enableResponse.status).toBe(200);

      const blockedWrite = await fetch(`${apiBaseUrl}/plugins/${namespace}/actions/unsafe_write`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pluginPath: pluginRoot,
          trustedRoots: [trustedRoot],
          actor: { kind: "agent", id: "api-agent" },
        }),
      });
      expect(blockedWrite.status).toBe(400);
      const blockedPayload = (await blockedWrite.json()) as {
        error: { code: string; message: string };
      };
      expect(blockedPayload.error.code).toBe("plugin_run_failed");
      expect(blockedPayload.error.message).toContain("must use core.createProposal");

      const overrideWrite = await fetch(
        `${apiBaseUrl}/plugins/${namespace}/actions/override_write`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            pluginPath: pluginRoot,
            trustedRoots: [trustedRoot],
            actor: { kind: "agent", id: "api-agent" },
          }),
        },
      );
      expect(overrideWrite.status).toBe(200);
      const overridePayload = (await overrideWrite.json()) as { result: { noteId: string } };
      expect(typeof overridePayload.result.noteId).toBe("string");

      const noteEvents = await fetch(`${apiBaseUrl}/events?type=note.created`);
      expect(noteEvents.status).toBe(200);
      const noteEventsPayload = (await noteEvents.json()) as Array<{
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
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("lists and applies plugin templates through API routes", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-templates-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const installResponse = await fetch(`${apiBaseUrl}/plugins/install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
            manifestVersion: "v2",
            namespace: "templates-api-test",
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
                lexicalTemplate: lexicalStateWithText("templated api body"),
              },
            ],
          },
        }),
      });
      expect(installResponse.status).toBe(200);

      const templatesResponse = await fetch(`${apiBaseUrl}/templates`);
      expect(templatesResponse.status).toBe(200);
      const templatesPayload = (await templatesResponse.json()) as Array<{
        namespace: string;
        available: boolean;
        template: { id: string };
      }>;
      const template = templatesPayload.find((entry) => entry.namespace === "templates-api-test");
      expect(template?.available).toBeTrue();
      expect(template?.template.id).toBe("daily");

      const applyDefaultResponse = await fetch(`${apiBaseUrl}/templates/apply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: "templates-api-test",
          templateId: "daily",
        }),
      });
      expect(applyDefaultResponse.status).toBe(200);
      const applyDefaultPayload = (await applyDefaultResponse.json()) as {
        noteId: string;
        namespace: string;
        templateId: string;
      };
      expect(applyDefaultPayload.namespace).toBe("templates-api-test");
      expect(applyDefaultPayload.templateId).toBe("daily");

      const defaultNoteResponse = await fetch(`${apiBaseUrl}/notes/${applyDefaultPayload.noteId}`);
      expect(defaultNoteResponse.status).toBe(200);
      const defaultNotePayload = (await defaultNoteResponse.json()) as {
        meta: { noteType: string; tags: string[] };
      };
      expect(defaultNotePayload.meta.noteType).toBe("task");
      expect(defaultNotePayload.meta.tags).toEqual(["daily", "template"]);

      const applyOverrideResponse = await fetch(`${apiBaseUrl}/templates/apply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: "templates-api-test",
          templateId: "daily",
          title: "Override API title",
          noteType: "journal",
          tags: ["override", "daily"],
        }),
      });
      expect(applyOverrideResponse.status).toBe(200);
      const applyOverridePayload = (await applyOverrideResponse.json()) as { noteId: string };

      const overrideNoteResponse = await fetch(
        `${apiBaseUrl}/notes/${applyOverridePayload.noteId}`,
      );
      expect(overrideNoteResponse.status).toBe(200);
      const overrideNotePayload = (await overrideNoteResponse.json()) as {
        meta: { title: string; noteType: string; tags: string[] };
      };
      expect(overrideNotePayload.meta.title).toBe("Override API title");
      expect(overrideNotePayload.meta.noteType).toBe("journal");
      expect(overrideNotePayload.meta.tags).toEqual(["daily", "template", "override"]);
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("exposes entity save, get, list, and update contracts through API routes", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-entities-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const registerResponse = await fetch(`${apiBaseUrl}/plugins/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
            manifestVersion: "v2",
            namespace: "people-api-test",
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
              },
            ],
          },
        }),
      });
      expect(registerResponse.status).toBe(200);

      const createEntityResponse = await fetch(`${apiBaseUrl}/entities`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: "people-api-test",
          entityType: "person",
          id: "alice",
          data: {
            name: "Alice",
            summary: "Platform lead",
          },
          links: [{ kind: "note", noteId: "note-1" }],
          actor: { kind: "human", id: "entity-admin" },
        }),
      });
      expect(createEntityResponse.status).toBe(200);
      const createEntityPayload = (await createEntityResponse.json()) as {
        entity: { id: string; data: { name: string; summary: string } };
        compatibility: { mode: string };
      };
      expect(createEntityPayload.entity.id).toBe("alice");
      expect(createEntityPayload.entity.data.name).toBe("Alice");
      expect(createEntityPayload.compatibility.mode).toBe("current");

      const getEntityResponse = await fetch(`${apiBaseUrl}/entities/people-api-test/person/alice`);
      expect(getEntityResponse.status).toBe(200);
      const getEntityPayload = (await getEntityResponse.json()) as {
        entity: { id: string; data: { name: string } };
      };
      expect(getEntityPayload.entity.id).toBe("alice");
      expect(getEntityPayload.entity.data.name).toBe("Alice");

      const updateEntityResponse = await fetch(
        `${apiBaseUrl}/entities/people-api-test/person/alice`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            data: {
              name: "Alice Updated",
              summary: "Architecture",
            },
            links: [
              {
                kind: "entity",
                namespace: "people-api-test",
                entityType: "person",
                entityId: "alice",
              },
            ],
            actor: { kind: "human", id: "entity-editor" },
          }),
        },
      );
      expect(updateEntityResponse.status).toBe(200);
      const updateEntityPayload = (await updateEntityResponse.json()) as {
        entity: { data: { name: string; summary: string } };
        meta: { links?: Array<{ kind: string }> };
      };
      expect(updateEntityPayload.entity.data.name).toBe("Alice Updated");
      expect(updateEntityPayload.entity.data.summary).toBe("Architecture");
      expect(updateEntityPayload.meta.links?.[0]?.kind).toBe("entity");

      const listEntitiesResponse = await fetch(
        `${apiBaseUrl}/entities?namespace=people-api-test&entityType=person&schemaVersion=v1`,
      );
      expect(listEntitiesResponse.status).toBe(200);
      const listEntitiesPayload = (await listEntitiesResponse.json()) as Array<{
        entity: { id: string; schemaVersion: string };
      }>;
      expect(listEntitiesPayload.length).toBe(1);
      expect(listEntitiesPayload[0]?.entity.id).toBe("alice");
      expect(listEntitiesPayload[0]?.entity.schemaVersion).toBe("v1");

      const missingNamespaceList = await fetch(`${apiBaseUrl}/entities?entityType=person`);
      expect(missingNamespaceList.status).toBe(400);
      const missingNamespacePayload = (await missingNamespaceList.json()) as {
        error: { code: string };
      };
      expect(missingNamespacePayload.error.code).toBe("missing_namespace");

      const entityNotFound = await fetch(`${apiBaseUrl}/entities/people-api-test/person/missing`);
      expect(entityNotFound.status).toBe(404);
      const entityNotFoundPayload = (await entityNotFound.json()) as {
        error: { code: string; message: string };
      };
      expect(entityNotFoundPayload.error.code).toBe("entity_not_found");
      expect(entityNotFoundPayload.error.message).toContain("people-api-test/person/missing");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("runs deterministic plugin entity schema migrations through API tooling", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-entity-migrate-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const namespace = "person-migrate-api";
    const pluginRoot = path.join(trustedRoot, namespace);
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

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

      await waitForApiReady(`${apiBaseUrl}/status`);

      const installV1 = await fetch(`${apiBaseUrl}/plugins/install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
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
          },
        }),
      });
      expect(installV1.status).toBe(200);

      const enablePlugin = await fetch(`${apiBaseUrl}/plugins/${namespace}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(enablePlugin.status).toBe(200);

      expect(
        (
          await fetch(`${apiBaseUrl}/entities`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              namespace,
              entityType: "person",
              id: "zed",
              data: {
                name: "Zed",
                bio: "Legacy",
              },
            }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${apiBaseUrl}/entities`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              namespace,
              entityType: "person",
              id: "alice",
              data: {
                name: "Alice",
                bio: "Legacy",
              },
            }),
          })
        ).status,
      ).toBe(200);

      const registerV2 = await fetch(`${apiBaseUrl}/plugins/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
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
          },
        }),
      });
      expect(registerV2.status).toBe(200);

      const dryRun = await fetch(`${apiBaseUrl}/entities/migrations/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace,
          entityType: "person",
          actionId: "migrate_person",
          fromSchemaVersion: "v1",
          dryRun: true,
        }),
      });
      expect(dryRun.status).toBe(200);
      const dryRunPayload = (await dryRun.json()) as {
        eligible: number;
        results: Array<{ id: string; status: string }>;
      };
      expect(dryRunPayload.eligible).toBe(2);
      expect(dryRunPayload.results.map((result) => result.id)).toEqual(["alice", "zed"]);
      expect(dryRunPayload.results.every((result) => result.status === "planned")).toBeTrue();

      const migrate = await fetch(`${apiBaseUrl}/entities/migrations/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace,
          entityType: "person",
          actionId: "migrate_person",
          fromSchemaVersion: "v1",
          pluginPath: pluginRoot,
          trustedRoots: [trustedRoot],
          requestId: "api-migrate",
        }),
      });
      expect(migrate.status).toBe(200);
      const migratePayload = (await migrate.json()) as {
        eligible: number;
        migrated: number;
        failed: number;
        results: Array<{ status: string }>;
      };
      expect(migratePayload.eligible).toBe(2);
      expect(migratePayload.migrated).toBe(2);
      expect(migratePayload.failed).toBe(0);
      expect(migratePayload.results.every((result) => result.status === "migrated")).toBeTrue();

      const migratedAlice = await fetch(`${apiBaseUrl}/entities/${namespace}/person/alice`);
      expect(migratedAlice.status).toBe(200);
      const migratedAlicePayload = (await migratedAlice.json()) as {
        entity: { schemaVersion: string; data: { fullName: string } };
        compatibility: { mode: string };
      };
      expect(migratedAlicePayload.entity.schemaVersion).toBe("v2");
      expect(migratedAlicePayload.entity.data.fullName).toBe("Alice");
      expect(migratedAlicePayload.compatibility.mode).toBe("current");

      const rebuild = await fetch(`${apiBaseUrl}/rebuild-index`, {
        method: "POST",
      });
      expect(rebuild.status).toBe(200);

      const migratedEntities = await fetch(
        `${apiBaseUrl}/entities?namespace=${namespace}&entityType=person&schemaVersion=v2`,
      );
      expect(migratedEntities.status).toBe(200);
      const migratedEntitiesPayload = (await migratedEntities.json()) as Array<{
        entity: { id: string; schemaVersion: string };
      }>;
      expect(migratedEntitiesPayload.map((entry) => entry.entity.id)).toEqual(["alice", "zed"]);
      expect(
        migratedEntitiesPayload.every((entry) => entry.entity.schemaVersion === "v2"),
      ).toBeTrue();
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("runs scheduler tasks and exposes scheduler status via API", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-scheduler-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const installResponse = await fetch(`${apiBaseUrl}/plugins/install`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          manifest: {
            manifestVersion: "v2",
            namespace: "scheduler-api-test",
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
          },
        }),
      });
      expect(installResponse.status).toBe(200);

      const enableResponse = await fetch(`${apiBaseUrl}/plugins/scheduler-api-test/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(enableResponse.status).toBe(200);

      const runSchedulerResponse = await fetch(`${apiBaseUrl}/scheduler/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          now: "2026-02-11T10:05:00.000Z",
          actor: { kind: "agent", id: "api-scheduler" },
        }),
      });
      expect(runSchedulerResponse.status).toBe(200);
      const runSchedulerPayload = (await runSchedulerResponse.json()) as {
        dueRuns: number;
        executedRuns: Array<{ taskId: string }>;
        failedRuns: Array<unknown>;
      };
      expect(runSchedulerPayload.dueRuns).toBe(1);
      expect(runSchedulerPayload.executedRuns.length).toBe(1);
      expect(runSchedulerPayload.executedRuns[0]?.taskId).toBe("hourly");
      expect(runSchedulerPayload.failedRuns.length).toBe(0);

      const schedulerStatusResponse = await fetch(`${apiBaseUrl}/scheduler/status`);
      expect(schedulerStatusResponse.status).toBe(200);
      const schedulerStatusPayload = (await schedulerStatusResponse.json()) as {
        ledgerEntries: number;
        taskSummaries: Array<{ namespace: string; taskId: string; runs: number }>;
        recentRuns: Array<{ namespace: string; taskId: string }>;
      };
      expect(schedulerStatusPayload.ledgerEntries).toBe(1);
      expect(schedulerStatusPayload.taskSummaries[0]?.namespace).toBe("scheduler-api-test");
      expect(schedulerStatusPayload.taskSummaries[0]?.taskId).toBe("hourly");
      expect(schedulerStatusPayload.taskSummaries[0]?.runs).toBe(1);
      expect(schedulerStatusPayload.recentRuns.length).toBe(1);

      const schedulerEventsResponse = await fetch(`${apiBaseUrl}/events?type=plugin.task_ran`);
      expect(schedulerEventsResponse.status).toBe(200);
      const schedulerEventsPayload = (await schedulerEventsResponse.json()) as Array<{
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
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("covers daily, templates, person, and meeting fixture flows via API", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-plugin-fixture-matrix-"));
    const trustedRoot = path.join(storeRoot, "trusted");
    const dailyNamespace = String(dailyNoteFixture.manifest.namespace);
    const templatesNamespace = String(templatesFixture.manifest.namespace);
    const personNamespace = String(personFixture.manifest.namespace);
    const meetingNamespace = String(meetingFixture.manifest.namespace);
    const dailyPluginRoot = path.join(trustedRoot, dailyNamespace);
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await mkdir(path.join(dailyPluginRoot, "dist"), { recursive: true });
      await writeFile(
        path.join(dailyPluginRoot, "dist", "cli.mjs"),
        dailyNoteFixture.cliRuntimeSource ?? "",
      );

      await waitForApiReady(`${apiBaseUrl}/status`);

      for (const fixture of [dailyNoteFixture, templatesFixture, personFixture, meetingFixture]) {
        const installResponse = await fetch(`${apiBaseUrl}/plugins/install`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            manifest: JSON.parse(JSON.stringify(fixture.manifest)),
          }),
        });
        expect(installResponse.status).toBe(200);
      }

      const enableDaily = await fetch(`${apiBaseUrl}/plugins/${dailyNamespace}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(enableDaily.status).toBe(200);
      const enableTemplates = await fetch(`${apiBaseUrl}/plugins/${templatesNamespace}/enable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(enableTemplates.status).toBe(200);

      const runDailyAction = await fetch(`${apiBaseUrl}/plugins/${dailyNamespace}/actions/echo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pluginPath: dailyPluginRoot,
          trustedRoots: [trustedRoot],
          requestId: "fixture-api-daily-req",
          input: { source: "api-fixture" },
        }),
      });
      expect(runDailyAction.status).toBe(200);
      const runDailyPayload = (await runDailyAction.json()) as {
        namespace: string;
        actionId: string;
        requestId: string;
      };
      expect(runDailyPayload.namespace).toBe(dailyNamespace);
      expect(runDailyPayload.actionId).toBe("echo");
      expect(runDailyPayload.requestId).toBe("fixture-api-daily-req");

      const schedulerRun = await fetch(`${apiBaseUrl}/scheduler/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          now: "2026-02-11T10:05:00.000Z",
        }),
      });
      expect(schedulerRun.status).toBe(200);
      const schedulerPayload = (await schedulerRun.json()) as {
        executedRuns: Array<{ namespace: string; taskId: string }>;
      };
      expect(
        schedulerPayload.executedRuns.some(
          (run) => run.namespace === dailyNamespace && run.taskId === "hourly-daily-note",
        ),
      ).toBeTrue();

      const applyTemplate = await fetch(`${apiBaseUrl}/templates/apply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: templatesNamespace,
          templateId: "daily",
        }),
      });
      expect(applyTemplate.status).toBe(200);
      const applyTemplatePayload = (await applyTemplate.json()) as {
        noteId: string;
      };
      const templatedNote = await fetch(`${apiBaseUrl}/notes/${applyTemplatePayload.noteId}`);
      expect(templatedNote.status).toBe(200);
      const templatedNotePayload = (await templatedNote.json()) as {
        meta: { tags: string[] };
      };
      expect(templatedNotePayload.meta.tags).toEqual(["daily", "template"]);

      const createPerson = await fetch(`${apiBaseUrl}/entities`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: personNamespace,
          entityType: "person",
          id: "alice",
          data: {
            name: "Alice",
            bio: "Platform",
          },
        }),
      });
      expect(createPerson.status).toBe(200);
      const createPersonPayload = (await createPerson.json()) as {
        entity: { id: string; entityType: string };
      };
      expect(createPersonPayload.entity.id).toBe("alice");
      expect(createPersonPayload.entity.entityType).toBe("person");

      const createMeeting = await fetch(`${apiBaseUrl}/entities`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          namespace: meetingNamespace,
          entityType: "meeting",
          id: "kickoff",
          data: {
            title: "Kickoff",
            attendees: ["alice"],
            agenda: "Roadmap and ownership",
          },
          links: [
            {
              kind: "entity",
              namespace: personNamespace,
              entityType: "person",
              entityId: "alice",
            },
          ],
        }),
      });
      expect(createMeeting.status).toBe(200);
      const createMeetingPayload = (await createMeeting.json()) as {
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
      expect(createMeetingPayload.meta.links?.[0]?.namespace).toBe(personNamespace);
      expect(createMeetingPayload.meta.links?.[0]?.entityType).toBe("person");
      expect(createMeetingPayload.meta.links?.[0]?.entityId).toBe("alice");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("maps proposal status conflicts to invalid_transition", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-proposal-conflict-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const noteResponse = await fetch(`${apiBaseUrl}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Proposal target note",
          lexicalState: lexicalStateWithHeadingAndParagraph("Plan", "ship it"),
        }),
      });
      expect(noteResponse.status).toBe(200);
      const notePayload = (await noteResponse.json()) as { noteId: string };

      const sectionsResponse = await fetch(`${apiBaseUrl}/sections?noteId=${notePayload.noteId}`);
      expect(sectionsResponse.status).toBe(200);
      const sectionsPayload = (await sectionsResponse.json()) as Array<{
        sectionId: string;
      }>;
      expect(sectionsPayload.length).toBeGreaterThan(0);

      const createProposalResponse = await fetch(`${apiBaseUrl}/proposals`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          target: {
            noteId: notePayload.noteId,
            sectionId: sectionsPayload[0]?.sectionId,
          },
          proposalType: "replace_section",
          content: {
            format: "text",
            content: "updated section content",
          },
          actor: { kind: "agent", id: "api-test-agent" },
        }),
      });
      expect(createProposalResponse.status).toBe(200);
      const createProposalPayload = (await createProposalResponse.json()) as {
        proposalId: string;
      };

      const acceptResponse = await fetch(
        `${apiBaseUrl}/proposals/${createProposalPayload.proposalId}/accept`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(acceptResponse.status).toBe(200);

      const duplicateAcceptResponse = await fetch(
        `${apiBaseUrl}/proposals/${createProposalPayload.proposalId}/accept`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(duplicateAcceptResponse.status).toBe(409);
      const duplicateAcceptPayload = (await duplicateAcceptResponse.json()) as {
        error: { code: string };
      };
      expect(duplicateAcceptPayload.error.code).toBe("invalid_transition");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("updates runtime store root via config endpoint", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-api-config-initial-"));
    const configuredStoreRoot = await mkdtemp(path.join(tmpdir(), "rem-api-config-updated-"));
    const configWorkspace = await mkdtemp(path.join(tmpdir(), "rem-api-config-file-"));
    const configPath = path.join(configWorkspace, "config.json");
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
        REM_CONFIG_PATH: configPath,
        REM_API_PORT: String(apiPort),
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady(`${apiBaseUrl}/status`);

      const initialConfigResponse = await fetch(`${apiBaseUrl}/config`);
      expect(initialConfigResponse.status).toBe(200);
      const initialConfigPayload = (await initialConfigResponse.json()) as {
        configPath: string;
        effectiveStoreRoot: string;
        source: string;
      };
      expect(initialConfigPayload.configPath).toBe(path.resolve(configPath));
      expect(initialConfigPayload.effectiveStoreRoot).toBe(path.resolve(storeRoot));
      expect(initialConfigPayload.source).toBe("env");

      const updateConfigResponse = await fetch(`${apiBaseUrl}/config`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          storeRoot: configuredStoreRoot,
        }),
      });
      expect(updateConfigResponse.status).toBe(200);
      const updateConfigPayload = (await updateConfigResponse.json()) as {
        configuredStoreRoot: string | null;
        effectiveStoreRoot: string;
        source: string;
      };
      expect(updateConfigPayload.configuredStoreRoot).toBe(path.resolve(configuredStoreRoot));
      expect(updateConfigPayload.effectiveStoreRoot).toBe(path.resolve(configuredStoreRoot));
      expect(updateConfigPayload.source).toBe("runtime");

      const statusResponse = await fetch(`${apiBaseUrl}/status`);
      expect(statusResponse.status).toBe(200);
      const statusPayload = (await statusResponse.json()) as {
        storeRoot: string;
      };
      expect(statusPayload.storeRoot).toBe(path.resolve(configuredStoreRoot));

      const resetConfigResponse = await fetch(`${apiBaseUrl}/config`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          storeRoot: "",
        }),
      });
      expect(resetConfigResponse.status).toBe(200);
      const resetConfigPayload = (await resetConfigResponse.json()) as {
        defaultStoreRoot: string;
        configuredStoreRoot: string | null;
        effectiveStoreRoot: string;
        source: string;
      };
      expect(resetConfigPayload.configuredStoreRoot).toBeNull();
      expect(resetConfigPayload.effectiveStoreRoot).toBe(resetConfigPayload.defaultStoreRoot);
      expect(resetConfigPayload.source).toBe("default");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
      await rm(configuredStoreRoot, { recursive: true, force: true });
      await rm(configWorkspace, { recursive: true, force: true });
    }
  });
});
