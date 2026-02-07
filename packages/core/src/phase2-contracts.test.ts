import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function waitForApiReady(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
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

describe("phase 2 contracts", () => {
  test("API exposes plugin, draft, event, and filtered-search contracts", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-phase2-api-contract-"));
    const api = Bun.spawn(["bun", "run", "--cwd", "apps/api", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REM_STORE_ROOT: storeRoot,
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForApiReady("http://127.0.0.1:8787/status");

      const registerResponse = await fetch("http://127.0.0.1:8787/plugins/register", {
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

      const noteResponse = await fetch("http://127.0.0.1:8787/notes", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Contract note",
          noteType: "task",
          lexicalState: lexicalStateWithText("contract alpha"),
          tags: ["ops"],
          plugins: {
            tasks: {
              board: "infra",
            },
          },
        }),
      });
      expect(noteResponse.status).toBe(200);
      const notePayload = (await noteResponse.json()) as { noteId: string };

      const updateResponse = await fetch(`http://127.0.0.1:8787/notes/${notePayload.noteId}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Contract note updated",
          noteType: "task",
          lexicalState: lexicalStateWithText("contract alpha refined"),
          tags: ["ops", "updated"],
          plugins: {
            tasks: {
              board: "infra",
            },
          },
        }),
      });
      expect(updateResponse.status).toBe(200);

      const missingUpdateResponse = await fetch("http://127.0.0.1:8787/notes/missing-note-id", {
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

      const secondNoteResponse = await fetch("http://127.0.0.1:8787/notes", {
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

      const draftResponse = await fetch("http://127.0.0.1:8787/drafts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Draft contract",
          lexicalState: lexicalStateWithText("draft text"),
          tags: ["draft"],
          author: { kind: "agent", id: "agent-1" },
        }),
      });
      expect(draftResponse.status).toBe(200);

      const drafts = (await (await fetch("http://127.0.0.1:8787/drafts")).json()) as Array<{
        id: string;
      }>;
      expect(drafts.length).toBe(1);

      const events = (await (
        await fetch("http://127.0.0.1:8787/events?entityKind=plugin")
      ).json()) as Array<{
        type: string;
      }>;
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe("plugin.registered");

      const search = (await (
        await fetch(
          "http://127.0.0.1:8787/search?q=contract&tags=ops&noteTypes=task&pluginNamespaces=tasks",
        )
      ).json()) as Array<{
        id: string;
      }>;
      expect(search.length).toBe(1);
      expect(search[0]?.id).toBe(notePayload.noteId);
    } finally {
      api.kill();
      await api.exited;
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  test("CLI exposes plugin, draft, event, and filtered-search contracts", async () => {
    const storeRoot = await mkdtemp(path.join(tmpdir(), "rem-phase2-cli-contract-"));
    const manifestPath = path.join(storeRoot, "manifest.json");
    const notePath = path.join(storeRoot, "note.json");
    const draftPath = path.join(storeRoot, "draft.json");

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
          title: "CLI Note",
          noteType: "task",
          lexicalState: lexicalStateWithText("cli alpha"),
          tags: ["ops"],
          plugins: {
            tasks: {
              board: "infra",
            },
          },
        }),
      );

      await writeFile(
        draftPath,
        JSON.stringify({
          title: "CLI Draft",
          lexicalState: lexicalStateWithText("cli draft"),
          tags: ["draft"],
          author: { kind: "agent", id: "cli-agent" },
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

      const saveDraft = Bun.spawnSync(
        [
          "bun",
          "run",
          "--cwd",
          "apps/cli",
          "src/index.ts",
          "drafts",
          "save",
          "--input",
          draftPath,
          "--json",
        ],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(saveDraft.exitCode).toBe(0);

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
      expect(searchPayload[0]?.title).toBe("CLI Note");

      const drafts = Bun.spawnSync(
        ["bun", "run", "--cwd", "apps/cli", "src/index.ts", "drafts", "list", "--json"],
        {
          cwd: process.cwd(),
          env,
          stderr: "pipe",
          stdout: "pipe",
        },
      );
      expect(drafts.exitCode).toBe(0);
      const draftsPayload = parseJsonStdout(drafts.stdout) as Array<{ title: string }>;
      expect(draftsPayload.length).toBe(1);
      expect(draftsPayload[0]?.title).toBe("CLI Draft");

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
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
