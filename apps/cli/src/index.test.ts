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
});
