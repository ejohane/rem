import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Actor, PluginManifest, PluginPermission } from "@rem/schemas";

export const DEFAULT_TRUSTED_ROOTS_ENV = "REM_PLUGIN_TRUSTED_ROOTS";

export interface PluginInvocationContext {
  actorKind: Actor["kind"];
  actorId?: string;
  host: "cli" | "api" | "ui";
  requestId: string;
}

export interface CliPluginContext {
  plugin: {
    namespace: string;
    schemaVersion: string;
  };
  invocation: PluginInvocationContext;
  permissions: Set<PluginPermission>;
  core: {
    saveNote: (input: unknown) => Promise<unknown>;
    searchNotes: (query: string, filters?: Record<string, unknown>) => Promise<unknown>;
    createProposal: (input: unknown) => Promise<unknown>;
    listEvents: (input?: Record<string, unknown>) => Promise<unknown>;
  };
  log: (entry: { level: "info" | "warn" | "error"; message: string; data?: unknown }) => void;
}

export interface CliPluginEntrypoint {
  actions: Record<string, (input: unknown, context: CliPluginContext) => Promise<unknown>>;
}

export interface UiPluginContext {
  noteId: string | null;
  lexicalState: unknown;
  tags: string[];
  pluginPayload: Record<string, unknown>;
  invocation: PluginInvocationContext;
  permissions: Set<PluginPermission>;
  coreApi: {
    search: (query: string, filters?: Record<string, unknown>) => Promise<unknown>;
    saveNote: (input: unknown) => Promise<unknown>;
    createProposal: (input: unknown) => Promise<unknown>;
  };
}

export interface UiPluginEntrypoint {
  renderPanel?: (panelId: string, context: UiPluginContext) => unknown;
  getCommands?: (
    context: UiPluginContext,
  ) => Array<{ id: string; title: string; run: () => Promise<void> }>;
}

export interface PluginRuntimeModule {
  cli?: CliPluginEntrypoint;
  ui?: UiPluginEntrypoint;
}

export interface ResolveTrustedRootsInput {
  bundledRoots?: string[];
  configuredRoots?: string[];
  envValue?: string;
  cwd?: string;
}

export interface ResolvePluginRootInput {
  namespace: string;
  trustedRoots: string[];
  pluginPath?: string;
  cwd?: string;
}

export interface RuntimeEntrypoint {
  relativePath: string;
  absolutePath: string;
  discoveredFrom: "manifest" | "convention";
}

export interface DiscoverPluginRuntimeAssetsInput {
  pluginRoot: string;
  manifest: PluginManifest;
  trustedRoots: string[];
}

export interface DiscoverPluginRuntimeAssetsResult {
  namespace: string;
  pluginRoot: string;
  cliEntrypoint?: RuntimeEntrypoint;
  uiEntrypoint?: RuntimeEntrypoint;
  warnings: string[];
}

export interface PluginPermissionGateInput {
  grantedPermissions: Iterable<PluginPermission>;
  requiredPermissions?: Iterable<PluginPermission>;
}

export interface PluginPermissionGateResult {
  allowed: boolean;
  missingPermissions: PluginPermission[];
}

export interface PluginRuntimePolicy {
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxConcurrentInvocationsPerPlugin: number;
}

export const DEFAULT_PLUGIN_RUNTIME_POLICY: PluginRuntimePolicy = {
  timeoutMs: 15_000,
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 256 * 1024,
  maxConcurrentInvocationsPerPlugin: 1,
};

export type PluginRuntimeGuardErrorCode =
  | "timeout"
  | "payload_too_large"
  | "output_too_large"
  | "concurrency_limit";

export class PluginRuntimeGuardError extends Error {
  readonly code: PluginRuntimeGuardErrorCode;
  readonly namespace: string;
  readonly actionId: string;

  constructor(
    code: PluginRuntimeGuardErrorCode,
    namespace: string,
    actionId: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginRuntimeGuardError";
    this.code = code;
    this.namespace = namespace;
    this.actionId = actionId;
  }
}

export const PLUGIN_RUNTIME_GUARD_ERROR_CODE_MAP: Record<PluginRuntimeGuardErrorCode, string> = {
  timeout: "plugin_action_timeout",
  payload_too_large: "plugin_input_too_large",
  output_too_large: "plugin_output_too_large",
  concurrency_limit: "plugin_concurrency_limited",
};

export interface PluginActionErrorMapping {
  code: string;
  message: string;
  guardCode?: PluginRuntimeGuardErrorCode;
}

export function mapPluginActionError(
  error: unknown,
  fallbackMessage = "Failed to run plugin action",
): PluginActionErrorMapping {
  if (error instanceof PluginRuntimeGuardError) {
    return {
      code: PLUGIN_RUNTIME_GUARD_ERROR_CODE_MAP[error.code] ?? "plugin_run_guard_failed",
      message: error.message,
      guardCode: error.code,
    };
  }

  if (error instanceof Error) {
    return {
      code: "plugin_run_failed",
      message: error.message,
    };
  }

  return {
    code: "plugin_run_failed",
    message: fallbackMessage,
  };
}

export interface RunPluginActionWithGuardsInput<T> {
  namespace: string;
  actionId: string;
  input: unknown;
  invoke: () => Promise<T>;
  policy?: Partial<PluginRuntimePolicy>;
}

export interface RunPluginActionWithGuardsResult<T> {
  result: T;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
}

const CLI_ENTRYPOINT_CONVENTIONS = ["dist/cli.js", "cli.js", "index.js"];
const UI_ENTRYPOINT_CONVENTIONS = ["dist/ui.js", "ui.js", "index.js"];
const activeInvocationsByPlugin = new Map<string, number>();

function splitTrustedRootEnv(rawValue: string): string[] {
  return rawValue
    .split(",")
    .flatMap((segment) => segment.split(path.delimiter))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function normalizePathInput(value: string, cwd: string): string {
  if (value.trim().length === 0) {
    throw new Error("Plugin path inputs cannot be empty");
  }

  return path.resolve(cwd, value);
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPathWithinRoot(candidatePath: string, rootPath: string, label: string): void {
  if (!isPathWithinRoot(candidatePath, rootPath)) {
    throw new Error(`${label} ${candidatePath} must stay within trusted root ${rootPath}`);
  }
}

async function resolveCanonicalPath(candidatePath: string): Promise<string> {
  try {
    return await realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

async function assertPathWithinTrustedRoots(
  candidatePath: string,
  trustedRoots: string[],
  label: string,
): Promise<void> {
  if (!trustedRoots.some((root) => isPathWithinRoot(candidatePath, root))) {
    throw new Error(`${label} ${candidatePath} is outside configured trusted roots`);
  }

  const canonicalCandidate = await resolveCanonicalPath(candidatePath);
  const canonicalTrustedRoots = await Promise.all(
    trustedRoots.map(async (root) => resolveCanonicalPath(root)),
  );
  if (canonicalTrustedRoots.some((root) => isPathWithinRoot(canonicalCandidate, root))) {
    return;
  }

  throw new Error(`${label} ${candidatePath} is outside configured trusted roots`);
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    const candidateStats = await stat(candidatePath);
    return candidateStats.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidatePath: string): Promise<boolean> {
  try {
    const candidateStats = await stat(candidatePath);
    return candidateStats.isFile();
  } catch {
    return false;
  }
}

function resolveRootCandidates(input: ResolveTrustedRootsInput): string[] {
  const cwd = input.cwd ?? process.cwd();
  const envValue = input.envValue ?? process.env[DEFAULT_TRUSTED_ROOTS_ENV] ?? "";
  const envRoots = envValue.trim().length > 0 ? splitTrustedRootEnv(envValue) : [];
  const combined = [...(input.bundledRoots ?? []), ...(input.configuredRoots ?? []), ...envRoots];

  const normalized = new Set<string>();
  for (const root of combined) {
    normalized.add(normalizePathInput(root, cwd));
  }

  return Array.from(normalized).sort((left, right) => left.localeCompare(right));
}

async function resolveEntrypointFromCandidates(
  pluginRoot: string,
  trustedRoots: string[],
  candidates: string[],
  discoveredFrom: "manifest" | "convention",
): Promise<RuntimeEntrypoint | undefined> {
  for (const candidate of candidates) {
    const absoluteCandidate = path.resolve(pluginRoot, candidate);
    assertPathWithinRoot(absoluteCandidate, pluginRoot, "Entrypoint");
    await assertPathWithinTrustedRoots(absoluteCandidate, trustedRoots, "Entrypoint");

    if (await isFile(absoluteCandidate)) {
      return {
        relativePath: candidate,
        absolutePath: absoluteCandidate,
        discoveredFrom,
      };
    }
  }

  return undefined;
}

export function resolveTrustedRoots(input: ResolveTrustedRootsInput = {}): string[] {
  return resolveRootCandidates(input);
}

export function evaluatePluginPermissionGate(
  input: PluginPermissionGateInput,
): PluginPermissionGateResult {
  const granted = new Set<PluginPermission>(input.grantedPermissions);
  const missingPermissions = Array.from(new Set(input.requiredPermissions ?? [])).filter(
    (permission) => !granted.has(permission),
  );

  return {
    allowed: missingPermissions.length === 0,
    missingPermissions,
  };
}

function assertPositivePolicyValue(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Plugin runtime policy ${name} must be a positive number`);
  }

  return Math.floor(value);
}

export function resolvePluginRuntimePolicy(
  overrides: Partial<PluginRuntimePolicy> | undefined,
): PluginRuntimePolicy {
  return {
    timeoutMs: assertPositivePolicyValue(
      "timeoutMs",
      overrides?.timeoutMs ?? DEFAULT_PLUGIN_RUNTIME_POLICY.timeoutMs,
    ),
    maxInputBytes: assertPositivePolicyValue(
      "maxInputBytes",
      overrides?.maxInputBytes ?? DEFAULT_PLUGIN_RUNTIME_POLICY.maxInputBytes,
    ),
    maxOutputBytes: assertPositivePolicyValue(
      "maxOutputBytes",
      overrides?.maxOutputBytes ?? DEFAULT_PLUGIN_RUNTIME_POLICY.maxOutputBytes,
    ),
    maxConcurrentInvocationsPerPlugin: assertPositivePolicyValue(
      "maxConcurrentInvocationsPerPlugin",
      overrides?.maxConcurrentInvocationsPerPlugin ??
        DEFAULT_PLUGIN_RUNTIME_POLICY.maxConcurrentInvocationsPerPlugin,
    ),
  };
}

function estimatePayloadBytes(payload: unknown): number {
  if (payload === undefined) {
    return 0;
  }

  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    return 0;
  }

  return Buffer.byteLength(serialized, "utf8");
}

function enterPluginInvocation(namespace: string, actionId: string, maxConcurrency: number): void {
  const active = activeInvocationsByPlugin.get(namespace) ?? 0;
  if (active >= maxConcurrency) {
    throw new PluginRuntimeGuardError(
      "concurrency_limit",
      namespace,
      actionId,
      `Concurrency limit exceeded for plugin ${namespace}`,
    );
  }

  activeInvocationsByPlugin.set(namespace, active + 1);
}

function leavePluginInvocation(namespace: string): void {
  const active = activeInvocationsByPlugin.get(namespace) ?? 0;
  if (active <= 1) {
    activeInvocationsByPlugin.delete(namespace);
    return;
  }

  activeInvocationsByPlugin.set(namespace, active - 1);
}

export async function runPluginActionWithGuards<T>(
  input: RunPluginActionWithGuardsInput<T>,
): Promise<RunPluginActionWithGuardsResult<T>> {
  const policy = resolvePluginRuntimePolicy(input.policy);
  const inputBytes = estimatePayloadBytes(input.input);
  if (inputBytes > policy.maxInputBytes) {
    throw new PluginRuntimeGuardError(
      "payload_too_large",
      input.namespace,
      input.actionId,
      `Input payload exceeds ${policy.maxInputBytes} bytes`,
    );
  }

  enterPluginInvocation(input.namespace, input.actionId, policy.maxConcurrentInvocationsPerPlugin);
  const startedAtMs = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new PluginRuntimeGuardError(
            "timeout",
            input.namespace,
            input.actionId,
            `Action timed out after ${policy.timeoutMs}ms`,
          ),
        );
      }, policy.timeoutMs);
    });

    const result = await Promise.race([input.invoke(), timeoutPromise]);
    const outputBytes = estimatePayloadBytes(result);
    if (outputBytes > policy.maxOutputBytes) {
      throw new PluginRuntimeGuardError(
        "output_too_large",
        input.namespace,
        input.actionId,
        `Action output exceeds ${policy.maxOutputBytes} bytes`,
      );
    }

    return {
      result,
      durationMs: Date.now() - startedAtMs,
      inputBytes,
      outputBytes,
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    leavePluginInvocation(input.namespace);
  }
}

export async function resolvePluginRoot(input: ResolvePluginRootInput): Promise<string> {
  const cwd = input.cwd ?? process.cwd();
  const namespace = input.namespace.trim();
  if (namespace.length === 0) {
    throw new Error("Plugin namespace is required to resolve plugin root");
  }

  if (input.trustedRoots.length === 0) {
    throw new Error("At least one trusted root is required to resolve plugin root");
  }

  const trustedRoots = input.trustedRoots.map((root) => normalizePathInput(root, cwd));
  if (input.pluginPath) {
    const explicitPath = normalizePathInput(input.pluginPath, cwd);
    await assertPathWithinTrustedRoots(explicitPath, trustedRoots, "Plugin path");
    if (!(await isDirectory(explicitPath))) {
      throw new Error(`Plugin path does not exist or is not a directory: ${explicitPath}`);
    }

    return explicitPath;
  }

  for (const root of trustedRoots) {
    const candidate = path.join(root, namespace);
    if (await isDirectory(candidate)) {
      await assertPathWithinTrustedRoots(candidate, trustedRoots, "Plugin path");
      return candidate;
    }
  }

  throw new Error(`Unable to resolve plugin root for namespace ${namespace}`);
}

export async function discoverPluginRuntimeAssets(
  input: DiscoverPluginRuntimeAssetsInput,
): Promise<DiscoverPluginRuntimeAssetsResult> {
  const pluginRoot = path.resolve(input.pluginRoot);
  const capabilities = new Set(input.manifest.capabilities ?? []);
  await assertPathWithinTrustedRoots(
    pluginRoot,
    input.trustedRoots.map((root) => path.resolve(root)),
    "Plugin root",
  );

  const cliCandidates: string[] = [];
  if (input.manifest.cli?.entrypoint) {
    cliCandidates.push(input.manifest.cli.entrypoint);
  } else if (capabilities.has("cli_actions")) {
    cliCandidates.push(...CLI_ENTRYPOINT_CONVENTIONS);
  }

  const uiCandidates: string[] = [];
  if (input.manifest.ui?.entrypoint) {
    uiCandidates.push(input.manifest.ui.entrypoint);
  } else if (capabilities.has("ui_panels")) {
    uiCandidates.push(...UI_ENTRYPOINT_CONVENTIONS);
  }

  const trustedRoots = input.trustedRoots.map((root) => path.resolve(root));
  const cliEntrypoint = await resolveEntrypointFromCandidates(
    pluginRoot,
    trustedRoots,
    cliCandidates,
    input.manifest.cli?.entrypoint ? "manifest" : "convention",
  );
  const uiEntrypoint = await resolveEntrypointFromCandidates(
    pluginRoot,
    trustedRoots,
    uiCandidates,
    input.manifest.ui?.entrypoint ? "manifest" : "convention",
  );

  const warnings: string[] = [];
  if (capabilities.has("cli_actions") && !cliEntrypoint) {
    warnings.push("No CLI runtime entrypoint discovered");
  }
  if (capabilities.has("ui_panels") && !uiEntrypoint) {
    warnings.push("No UI runtime entrypoint discovered");
  }

  return {
    namespace: input.manifest.namespace,
    pluginRoot,
    cliEntrypoint,
    uiEntrypoint,
    warnings,
  };
}

export async function loadPluginRuntimeModule(
  entrypointPath: string,
): Promise<PluginRuntimeModule> {
  const resolvedPath = path.resolve(entrypointPath);
  if (!(await isFile(resolvedPath))) {
    throw new Error(`Plugin runtime entrypoint does not exist: ${resolvedPath}`);
  }

  const moduleUrl = pathToFileURL(resolvedPath).href;
  return (await import(moduleUrl)) as PluginRuntimeModule;
}
