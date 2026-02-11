import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
