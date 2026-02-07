import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { app } from "./index";

const originalApiToken = process.env.REM_API_TOKEN;
const originalStoreRoot = process.env.REM_STORE_ROOT;

afterEach(() => {
  if (originalApiToken === undefined) {
    process.env.REM_API_TOKEN = undefined;
  } else {
    process.env.REM_API_TOKEN = originalApiToken;
  }

  if (originalStoreRoot === undefined) {
    process.env.REM_STORE_ROOT = undefined;
  } else {
    process.env.REM_STORE_ROOT = originalStoreRoot;
  }
});

describe("API token auth", () => {
  test("allows requests when token is not configured", async () => {
    process.env.REM_API_TOKEN = undefined;

    const response = await app.request("/route-that-does-not-exist");
    expect(response.status).toBe(404);
  });

  test("rejects requests without bearer token when configured", async () => {
    process.env.REM_API_TOKEN = "secret-token";

    const response = await app.request("/status");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Unauthorized",
      },
    });
  });

  test("rejects requests with incorrect bearer token", async () => {
    process.env.REM_API_TOKEN = "secret-token";

    const response = await app.request("/status", {
      headers: {
        Authorization: "Bearer not-secret",
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Unauthorized",
      },
    });
  });

  test("accepts requests with valid bearer token", async () => {
    process.env.REM_API_TOKEN = "secret-token";
    process.env.REM_STORE_ROOT = await mkdtemp(path.join(tmpdir(), "rem-api-auth-"));

    const statusResponse = await app.request("/status", {
      headers: {
        Authorization: "Bearer secret-token",
      },
    });
    expect(statusResponse.status).toBe(200);

    const statusBody = (await statusResponse.json()) as { ok: boolean };
    expect(statusBody.ok).toBe(true);

    const saveNoteResponse = await app.request("/notes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        title: "Token Auth Note",
        lexicalState: {
          root: {
            type: "root",
            version: 1,
            children: [],
          },
        },
      }),
    });

    expect(saveNoteResponse.status).toBe(200);

    const saveBody = (await saveNoteResponse.json()) as { noteId?: string };
    expect(typeof saveBody.noteId).toBe("string");
  });
});
