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
      expect(noteText).toContain("REM CLI Memory Workflow");
      expect(noteText).toContain("Invoke When");
      expect(noteText).toContain("Core Commands");

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
