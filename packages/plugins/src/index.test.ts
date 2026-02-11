import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type PluginManifest, pluginManifestSchema } from "@rem/schemas";

import {
  type PluginRuntimeGuardError,
  discoverPluginRuntimeAssets,
  evaluatePluginPermissionGate,
  loadPluginRuntimeModule,
  mapPluginActionError,
  resolvePluginRoot,
  resolveTrustedRoots,
  runPluginActionWithGuards,
} from "./index";

function buildCliManifest(namespace: string, entrypoint?: string): PluginManifest {
  return pluginManifestSchema.parse({
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
      actions: [
        {
          id: "ping",
          title: "Ping",
        },
      ],
      entrypoint,
    },
  });
}

describe("plugins runtime contracts and loader primitives", () => {
  test("normalizes and deduplicates trusted roots from config + env inputs", () => {
    const cwd = "/tmp/rem-plugin-roots";
    const roots = resolveTrustedRoots({
      bundledRoots: ["./bundled", "/trusted/base"],
      configuredRoots: ["./bundled", "../configured"],
      envValue: "./env-one,/trusted/base",
      cwd,
    });

    expect(roots).toEqual([
      "/tmp/configured",
      "/tmp/rem-plugin-roots/bundled",
      "/tmp/rem-plugin-roots/env-one",
      "/trusted/base",
    ]);
  });

  test("resolves plugin roots only from trusted directories", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "rem-plugins-roots-"));
    const trustedRoot = path.join(workspaceRoot, "trusted");
    const outsideRoot = path.join(workspaceRoot, "outside");
    const pluginDir = path.join(trustedRoot, "demo-plugin");
    const outsidePluginDir = path.join(outsideRoot, "demo-plugin");

    await mkdir(pluginDir, { recursive: true });
    await mkdir(outsidePluginDir, { recursive: true });

    try {
      const resolvedByNamespace = await resolvePluginRoot({
        namespace: "demo-plugin",
        trustedRoots: [trustedRoot],
      });
      expect(resolvedByNamespace).toBe(pluginDir);

      const resolvedByPath = await resolvePluginRoot({
        namespace: "demo-plugin",
        trustedRoots: [trustedRoot],
        pluginPath: pluginDir,
      });
      expect(resolvedByPath).toBe(pluginDir);

      await expect(
        resolvePluginRoot({
          namespace: "demo-plugin",
          trustedRoots: [trustedRoot],
          pluginPath: outsidePluginDir,
        }),
      ).rejects.toThrow("outside configured trusted roots");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects plugin root symlink escapes outside trusted roots", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "rem-plugins-symlink-root-"));
    const trustedRoot = path.join(workspaceRoot, "trusted");
    const outsideRoot = path.join(workspaceRoot, "outside");
    const realPluginDir = path.join(outsideRoot, "demo-plugin");
    const symlinkedPluginDir = path.join(trustedRoot, "demo-plugin");

    await mkdir(trustedRoot, { recursive: true });
    await mkdir(realPluginDir, { recursive: true });
    await symlink(realPluginDir, symlinkedPluginDir, "dir");

    try {
      await expect(
        resolvePluginRoot({
          namespace: "demo-plugin",
          trustedRoots: [trustedRoot],
        }),
      ).rejects.toThrow("outside configured trusted roots");

      await expect(
        resolvePluginRoot({
          namespace: "demo-plugin",
          trustedRoots: [trustedRoot],
          pluginPath: symlinkedPluginDir,
        }),
      ).rejects.toThrow("outside configured trusted roots");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("discovers runtime entrypoints from manifest and convention paths", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "rem-plugins-discovery-"));
    const pluginRoot = path.join(workspaceRoot, "demo-plugin");
    await mkdir(path.join(pluginRoot, "dist"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "dist", "cli.js"),
      "export const cli = { actions: {} };\n",
    );

    try {
      const manifest = buildCliManifest("demo-plugin");
      const discovered = await discoverPluginRuntimeAssets({
        pluginRoot,
        manifest,
        trustedRoots: [workspaceRoot],
      });

      expect(discovered.cliEntrypoint?.relativePath).toBe("dist/cli.js");
      expect(discovered.cliEntrypoint?.discoveredFrom).toBe("convention");
      expect(discovered.warnings).toEqual([]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects manifest entrypoint traversal outside plugin root", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "rem-plugins-traversal-"));
    const pluginRoot = path.join(workspaceRoot, "demo-plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "evil.js"), "export const cli = { actions: {} };\n");

    try {
      const manifest = buildCliManifest("demo-plugin", "../evil.js");
      await expect(
        discoverPluginRuntimeAssets({
          pluginRoot,
          manifest,
          trustedRoots: [workspaceRoot],
        }),
      ).rejects.toThrow("must stay within trusted root");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects entrypoint symlink escapes outside trusted roots", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "rem-plugins-symlink-entrypoint-"));
    const trustedRoot = path.join(workspaceRoot, "trusted");
    const outsideRoot = path.join(workspaceRoot, "outside");
    const pluginRoot = path.join(trustedRoot, "demo-plugin");
    const outsideDist = path.join(outsideRoot, "dist");

    await mkdir(pluginRoot, { recursive: true });
    await mkdir(outsideDist, { recursive: true });
    await writeFile(path.join(outsideDist, "cli.js"), "export const cli = { actions: {} };\n");
    await symlink(outsideDist, path.join(pluginRoot, "dist"), "dir");

    try {
      const manifest = buildCliManifest("demo-plugin", "dist/cli.js");
      await expect(
        discoverPluginRuntimeAssets({
          pluginRoot,
          manifest,
          trustedRoots: [trustedRoot],
        }),
      ).rejects.toThrow("outside configured trusted roots");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("loads runtime modules from discovered entrypoints", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "rem-plugins-loader-"));
    const entrypointPath = path.join(workspaceRoot, "runtime.mjs");
    await writeFile(
      entrypointPath,
      "export const cli = { actions: { ping: async () => 'pong' } }; export default { cli };\n",
    );

    try {
      const loaded = await loadPluginRuntimeModule(entrypointPath);
      expect(typeof loaded.cli?.actions.ping).toBe("function");
      expect(await loaded.cli?.actions.ping({}, {} as never)).toBe("pong");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("evaluates required permission gates for runtime boundaries", () => {
    const allowed = evaluatePluginPermissionGate({
      grantedPermissions: ["notes.read", "notes.write"],
      requiredPermissions: ["notes.write"],
    });
    expect(allowed.allowed).toBeTrue();
    expect(allowed.missingPermissions).toEqual([]);

    const denied = evaluatePluginPermissionGate({
      grantedPermissions: ["notes.read"],
      requiredPermissions: ["notes.write", "events.read"],
    });
    expect(denied.allowed).toBeFalse();
    expect(denied.missingPermissions).toEqual(["notes.write", "events.read"]);
  });

  test("enforces runtime guardrails for timeout, payload size, and concurrency", async () => {
    await expect(
      runPluginActionWithGuards({
        namespace: "limits",
        actionId: "too-large-input",
        input: { text: "x".repeat(20) },
        policy: {
          maxInputBytes: 10,
        },
        invoke: async () => ({ ok: true }),
      }),
    ).rejects.toMatchObject({
      code: "payload_too_large",
    } satisfies Partial<PluginRuntimeGuardError>);

    await expect(
      runPluginActionWithGuards({
        namespace: "limits",
        actionId: "too-large-output",
        input: {},
        policy: {
          maxOutputBytes: 10,
        },
        invoke: async () => ({ text: "x".repeat(20) }),
      }),
    ).rejects.toMatchObject({
      code: "output_too_large",
    } satisfies Partial<PluginRuntimeGuardError>);

    await expect(
      runPluginActionWithGuards({
        namespace: "limits",
        actionId: "timeout",
        input: {},
        policy: {
          timeoutMs: 1,
        },
        invoke: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true };
        },
      }),
    ).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<PluginRuntimeGuardError>);

    const blocking = runPluginActionWithGuards({
      namespace: "limits",
      actionId: "blocker",
      input: {},
      policy: {
        maxConcurrentInvocationsPerPlugin: 1,
      },
      invoke: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
    });

    await expect(
      runPluginActionWithGuards({
        namespace: "limits",
        actionId: "second",
        input: {},
        policy: {
          maxConcurrentInvocationsPerPlugin: 1,
        },
        invoke: async () => ({ ok: true }),
      }),
    ).rejects.toMatchObject({
      code: "concurrency_limit",
    } satisfies Partial<PluginRuntimeGuardError>);

    await blocking;
  });

  test("maps plugin runtime guard errors to stable host error codes", async () => {
    try {
      await runPluginActionWithGuards({
        namespace: "limits",
        actionId: "timeout",
        input: {},
        policy: {
          timeoutMs: 1,
        },
        invoke: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { ok: true };
        },
      });
    } catch (error) {
      const mapped = mapPluginActionError(error);
      expect(mapped.code).toBe("plugin_action_timeout");
      expect(mapped.guardCode).toBe("timeout");
      expect(mapped.message).toContain("timed out");
      return;
    }

    throw new Error("Expected guard error to be thrown");
  });

  test("maps non-guard runtime errors to plugin_run_failed", () => {
    const mapped = mapPluginActionError(new Error("boom"));
    expect(mapped.code).toBe("plugin_run_failed");
    expect(mapped.message).toBe("boom");
    expect(mapped.guardCode).toBeUndefined();
  });
});
