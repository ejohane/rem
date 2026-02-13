import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

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

function parseJsonStdout(stdout: Uint8Array): unknown {
  return JSON.parse(Buffer.from(stdout).toString("utf8"));
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

describe("phase 2 contracts", () => {
  test("API exposes plugin, event, and filtered-search contracts", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-phase2-api-contract-"));
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
            namespace: "tasks",
            schemaVersion: "v1",
            payloadSchema: {
              type: "object",
              required: ["board"],
              properties: {
                board: {
                  type: "string",
                },
              },
              additionalProperties: false,
            },
          },
          actor: { kind: "human", id: "tester" },
        }),
      });
      expect(registerResponse.status).toBe(200);

      const noteResponse = await fetch(`${apiBaseUrl}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Contract note",
          noteType: "task",
          lexicalState: lexicalStateWithText("contract alpha"),
          tags: ["ops"],
          actor: { kind: "agent", id: "api-agent-1" },
          plugins: {
            tasks: {
              board: "infra",
            },
          },
        }),
      });
      expect(noteResponse.status).toBe(200);
      const notePayload = (await noteResponse.json()) as {
        noteId: string;
        meta: {
          createdAt: string;
          author: { kind: "human" | "agent"; id?: string };
        };
      };
      expect(notePayload.meta.author.kind).toBe("agent");
      expect(notePayload.meta.author.id).toBe("api-agent-1");

      const updateResponse = await fetch(`${apiBaseUrl}/notes/${notePayload.noteId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Contract note updated",
          noteType: "task",
          lexicalState: lexicalStateWithText("contract alpha refined"),
          tags: ["ops", "updated"],
          actor: { kind: "agent", id: "api-agent-2" },
          plugins: {
            tasks: {
              board: "infra",
            },
          },
        }),
      });
      expect(updateResponse.status).toBe(200);
      const updatedPayload = (await updateResponse.json()) as {
        meta: {
          author: { kind: "human" | "agent"; id?: string };
        };
      };
      expect(updatedPayload.meta.author.kind).toBe("agent");
      expect(updatedPayload.meta.author.id).toBe("api-agent-2");

      const invalidAgentResponse = await fetch(`${apiBaseUrl}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Invalid agent note",
          lexicalState: lexicalStateWithText("invalid"),
          actor: { kind: "agent" },
        }),
      });
      expect(invalidAgentResponse.status).toBe(400);

      const missingUpdateResponse = await fetch(`${apiBaseUrl}/notes/missing-note-id`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Missing note",
          lexicalState: lexicalStateWithText("missing"),
        }),
      });
      expect(missingUpdateResponse.status).toBe(404);

      await new Promise((resolve) => setTimeout(resolve, 5));
      const secondNoteResponse = await fetch(`${apiBaseUrl}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Contract note secondary",
          noteType: "meeting",
          lexicalState: lexicalStateWithText("contract alpha"),
          tags: ["ops"],
        }),
      });
      expect(secondNoteResponse.status).toBe(200);
      const secondNotePayload = (await secondNoteResponse.json()) as {
        noteId: string;
        meta: {
          createdAt: string;
        };
      };

      const events = (await (
        await fetch(`${apiBaseUrl}/events?entityKind=plugin`)
      ).json()) as Array<{
        type: string;
        payload: {
          namespace?: string;
        };
      }>;
      expect(events.some((event) => event.type === "plugin.registered")).toBeTrue();
      expect(
        events.some(
          (event) => event.type === "plugin.registered" && event.payload.namespace === "tasks",
        ),
      ).toBeTrue();

      const pluginFilteredSearch = (await (
        await fetch(
          `${apiBaseUrl}/search?q=contract&tags=ops&noteTypes=task&pluginNamespaces=tasks`,
        )
      ).json()) as Array<{
        id: string;
      }>;
      expect(pluginFilteredSearch.length).toBe(1);
      expect(pluginFilteredSearch[0]?.id).toBe(notePayload.noteId);

      const createdSince = (await (
        await fetch(
          `${apiBaseUrl}/search?q=contract&createdSince=${encodeURIComponent(secondNotePayload.meta.createdAt)}`,
        )
      ).json()) as Array<{
        id: string;
      }>;
      expect(createdSince.length).toBe(1);
      expect(createdSince[0]?.id).toBe(secondNotePayload.noteId);

      const createdUntil = (await (
        await fetch(
          `${apiBaseUrl}/search?q=contract&createdUntil=${encodeURIComponent(notePayload.meta.createdAt)}`,
        )
      ).json()) as Array<{
        id: string;
      }>;
      expect(createdUntil.length).toBe(1);
      expect(createdUntil[0]?.id).toBe(notePayload.noteId);

      const migrationResponse = await fetch(`${apiBaseUrl}/migrations/sections`, {
        method: "POST",
      });
      expect(migrationResponse.status).toBe(200);
      const migrationPayload = (await migrationResponse.json()) as {
        migration: string;
      };
      expect(migrationPayload.migration).toBe("section_identity_v2");
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("API enforces optional bearer token auth when configured", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-phase2-api-auth-contract-"));
    const apiPort = await getAvailablePort();
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    const token = "phase2-contract-token";
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
      await waitForApiReady(`${apiBaseUrl}/status`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const missingTokenResponse = await fetch(`${apiBaseUrl}/status`);
      expect(missingTokenResponse.status).toBe(401);
      const missingTokenBody = (await missingTokenResponse.json()) as {
        error?: { code?: string; message?: string };
      };
      expect(missingTokenBody.error?.code).toBe("unauthorized");

      const wrongTokenResponse = await fetch(`${apiBaseUrl}/status`, {
        headers: {
          authorization: "Bearer wrong-token",
        },
      });
      expect(wrongTokenResponse.status).toBe(401);

      const okStatusResponse = await fetch(`${apiBaseUrl}/status`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      expect(okStatusResponse.status).toBe(200);

      const authorizedWrite = await fetch(`${apiBaseUrl}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: "Auth protected note",
          lexicalState: lexicalStateWithText("auth ok"),
          tags: ["secure"],
        }),
      });
      expect(authorizedWrite.status).toBe(200);

      const unauthorizedWrite = await fetch(`${apiBaseUrl}/notes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Auth blocked note",
          lexicalState: lexicalStateWithText("auth blocked"),
        }),
      });
      expect(unauthorizedWrite.status).toBe(401);
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("CLI exposes plugin, event, and filtered-search contracts", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-phase2-cli-contract-"));
    const manifestPath = path.join(storeRoot, "manifest.json");
    const notePath = path.join(storeRoot, "note.json");
    const secondNotePath = path.join(storeRoot, "note-2.json");
    const invalidActorNotePath = path.join(storeRoot, "note-invalid-actor.json");

    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          namespace: "tasks",
          schemaVersion: "v1",
          payloadSchema: {
            type: "object",
            required: ["board"],
            properties: {
              board: {
                type: "string",
              },
            },
            additionalProperties: false,
          },
        }),
      );

      await writeFile(
        notePath,
        JSON.stringify({
          title: "CLI Note One",
          noteType: "task",
          lexicalState: lexicalStateWithText("cli alpha"),
          tags: ["ops"],
          plugins: {
            tasks: {
              board: "infra",
            },
          },
          actor: { kind: "agent", id: "cli-agent-1" },
        }),
      );

      await writeFile(
        secondNotePath,
        JSON.stringify({
          title: "CLI Note Two",
          noteType: "meeting",
          lexicalState: lexicalStateWithText("cli alpha"),
          tags: ["ops"],
          actor: { kind: "human", id: "cli-human-2" },
        }),
      );

      await writeFile(
        invalidActorNotePath,
        JSON.stringify({
          title: "CLI Note Invalid Actor",
          noteType: "meeting",
          lexicalState: lexicalStateWithText("cli invalid actor"),
          tags: ["ops"],
        }),
      );

      const env = {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
      };

      const registerPlugin = Bun.spawnSync(
        [
          "bun",
          "run",
          "--cwd",
          "apps/cli",
          "src/index.ts",
          "plugin",
          "register",
          "--manifest",
          manifestPath,
          "--json",
        ],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(registerPlugin.exitCode).toBe(0);

      const saveNote = Bun.spawnSync(
        [
          "bun",
          "run",
          "--cwd",
          "apps/cli",
          "src/index.ts",
          "notes",
          "save",
          "--input",
          notePath,
          "--json",
        ],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(saveNote.exitCode).toBe(0);
      const saveNotePayload = parseJsonStdout(saveNote.stdout) as {
        meta: {
          author: {
            kind: "human" | "agent";
            id?: string;
          };
        };
      };
      expect(saveNotePayload.meta.author.kind).toBe("agent");
      expect(saveNotePayload.meta.author.id).toBe("cli-agent-1");

      await new Promise((resolve) => setTimeout(resolve, 5));
      const saveSecondNote = Bun.spawnSync(
        [
          "bun",
          "run",
          "--cwd",
          "apps/cli",
          "src/index.ts",
          "notes",
          "save",
          "--input",
          secondNotePath,
          "--json",
        ],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(saveSecondNote.exitCode).toBe(0);
      const saveSecondNotePayload = parseJsonStdout(saveSecondNote.stdout) as {
        noteId: string;
        meta: {
          createdAt: string;
        };
      };

      const invalidAgentSave = Bun.spawnSync(
        [
          "bun",
          "run",
          "--cwd",
          "apps/cli",
          "src/index.ts",
          "notes",
          "save",
          "--input",
          invalidActorNotePath,
          "--actor-kind",
          "agent",
          "--json",
        ],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(invalidAgentSave.exitCode).toBe(1);

      const search = Bun.spawnSync(
        [
          "bun",
          "run",
          "--cwd",
          "apps/cli",
          "src/index.ts",
          "search",
          "alpha",
          "--tags",
          "ops",
          "--note-types",
          "task",
          "--plugin-namespaces",
          "tasks",
          "--json",
        ],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(search.exitCode).toBe(0);
      const searchPayload = parseJsonStdout(search.stdout) as Array<{ title: string }>;
      expect(searchPayload.length).toBe(1);
      expect(searchPayload[0]?.title).toBe("CLI Note One");

      const createdSearch = Bun.spawnSync(
        [
          "bun",
          "run",
          "--cwd",
          "apps/cli",
          "src/index.ts",
          "search",
          "alpha",
          "--created-since",
          saveSecondNotePayload.meta.createdAt,
          "--json",
        ],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(createdSearch.exitCode).toBe(0);
      const createdSearchPayload = parseJsonStdout(createdSearch.stdout) as Array<{
        title: string;
      }>;
      expect(createdSearchPayload.length).toBe(1);
      expect(createdSearchPayload[0]?.title).toBe("CLI Note Two");

      const events = Bun.spawnSync(
        ["bun", "run", "--cwd", "apps/cli", "src/index.ts", "events", "tail", "--json"],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(events.exitCode).toBe(0);
      const eventsPayload = parseJsonStdout(events.stdout) as Array<{ type: string }>;
      expect(eventsPayload.length).toBeGreaterThanOrEqual(3);
      expect(eventsPayload.some((event) => event.type === "plugin.registered")).toBeTrue();

      const migrateSections = Bun.spawnSync(
        ["bun", "run", "--cwd", "apps/cli", "src/index.ts", "migrate", "sections", "--json"],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(migrateSections.exitCode).toBe(0);
      const migratePayload = parseJsonStdout(migrateSections.stdout) as {
        migration: string;
      };
      expect(migratePayload.migration).toBe("section_identity_v2");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
