import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  buildSectionIndexFromLexical,
  extractMarkdownFromLexical,
  extractPlainTextFromLexical,
} from "@rem/extractor-lexical";
import { RemIndex, resetIndexDatabase } from "@rem/index-sqlite";
import {
  type Actor,
  type LexicalState,
  type NoteMeta,
  type NoteSection,
  type NoteSectionIndex,
  type PluginEntityMeta,
  type PluginEntityRecord,
  type PluginEntityTypeDefinition,
  type PluginLifecycleState,
  type PluginManifest,
  type PluginManifestInput,
  type PluginMeta,
  type PluginPayloadSchema,
  type PluginScheduledTaskDefinition,
  type PluginSchedulerLedger,
  type PluginSchedulerLedgerEntry,
  type PluginTemplateDefinition,
  type Proposal,
  type ProposalContent,
  type ProposalMeta,
  type ProposalStatus,
  type ProposalTarget,
  type ProposalType,
  type RemConfig,
  type RemEvent,
  actorSchema,
  agentActorSchema,
  configSchema,
  humanActorSchema,
  lexicalStateSchema,
  noteMetaSchema,
  noteSectionIndexSchema,
  pluginEntityIdSchema,
  pluginEntityMetaSchema,
  pluginEntityRecordSchema,
  pluginEntityTypeIdSchema,
  pluginManifestSchema,
  pluginMetaSchema,
  pluginNamespaceSchema,
  pluginSchedulerLedgerEntrySchema,
  pluginSchedulerLedgerSchema,
  proposalContentSchema,
  proposalMetaSchema,
  proposalSchema,
  proposalStatusSchema,
  proposalTypeSchema,
  remEventSchema,
  sectionTargetSchema,
} from "@rem/schemas";
import type { ServiceStatus } from "@rem/shared";
import {
  type StorePaths,
  appendEvent,
  ensureStoreLayout,
  listEventFiles,
  listNoteIds,
  listProposalIds,
  listPluginEntities as listStoredPluginEntities,
  listPlugins as listStoredPlugins,
  loadNote,
  loadProposal,
  loadPlugin as loadStoredPlugin,
  loadPluginEntity as loadStoredPluginEntity,
  readEventsFromFile,
  resolveStorePaths,
  saveNote,
  savePluginEntity as savePluginEntityToStore,
  savePlugin as savePluginToStore,
  saveProposal,
  updateProposalStatus,
} from "@rem/store-fs";

const CORE_SCHEMA_VERSION = "v1";
const SECTION_INDEX_VERSION = "v2";
const SECTION_IDENTITY_MIGRATION = "section_identity_v2";
const CORE_CONFIG_SCHEMA_VERSION = "v1";
const DEFAULT_STORE_ROOT = path.join(homedir(), ".rem");
const SCHEDULER_LEDGER_SCHEMA_VERSION = "v1";
const DEFAULT_SCHEDULER_RUN_WINDOW_MINUTES = 15;

type StoreRootSource = "runtime" | "env" | "config" | "default";

type LexicalRootLike = {
  root?: {
    children?: unknown;
    [key: string]: unknown;
  };
};

type AnnotationOperations = {
  annotationNodes: unknown[];
  tagsToAdd: string[];
  tagsToRemove: string[];
  titleOverride?: string;
};

export interface CoreStatus extends ServiceStatus {
  storeRoot: string;
  notes: number;
  proposals: number;
  events: number;
  plugins: number;
  lastIndexedEventAt: string | null;
  healthHints: string[];
}

export interface SaveNoteInput {
  id?: string;
  title: string;
  noteType?: string;
  lexicalState: unknown;
  tags?: string[];
  plugins?: Record<string, unknown>;
  actor?: Actor;
  overrideReason?: string;
  approvedBy?: string;
  sourcePlugin?: string;
}

export interface SaveNoteResult {
  noteId: string;
  eventId: string;
  created: boolean;
  meta: NoteMeta;
}

export interface CoreSearchResult {
  id: string;
  title: string;
  updatedAt: string;
  snippet: string;
}

export interface SearchNotesInput {
  limit?: number;
  tags?: string[];
  noteTypes?: string[];
  pluginNamespaces?: string[];
  createdSince?: string;
  createdUntil?: string;
  updatedSince?: string;
  updatedUntil?: string;
}

export type NoteFormat = "lexical" | "text" | "md";

export interface CoreCanonicalNote {
  noteId: string;
  lexicalState: unknown;
  meta: NoteMeta;
  sectionIndex: NoteSectionIndex;
}

export interface CoreFormattedNote {
  noteId: string;
  format: NoteFormat;
  content: unknown;
  meta: NoteMeta;
}

export interface CoreSectionLookupInput {
  noteId: string;
  sectionId: string;
  fallbackPath?: string[];
}

export interface CreateProposalInput {
  id?: string;
  actor: Actor;
  target: ProposalTarget;
  proposalType: ProposalType;
  content: {
    format: ProposalContent["format"];
    content: unknown;
    schemaVersion?: string;
  };
  rationale?: string;
  confidence?: number;
  source?: string;
}

export interface CoreProposalRecord {
  proposal: Proposal;
  content: ProposalContent;
  meta: ProposalMeta;
}

export interface CreateProposalResult {
  proposalId: string;
  eventId: string;
  record: CoreProposalRecord;
}

export interface ListProposalsInput {
  status?: ProposalStatus;
}

export interface ListEventsInput {
  since?: string;
  limit?: number;
  type?: string;
  actorKind?: RemEvent["actor"]["kind"];
  actorId?: string;
  entityKind?: RemEvent["entity"]["kind"];
  entityId?: string;
}

export interface CoreEventRecord {
  eventId: string;
  timestamp: string;
  type: string;
  actor: {
    kind: RemEvent["actor"]["kind"];
    id?: string;
  };
  entity: {
    kind: RemEvent["entity"]["kind"];
    id: string;
  };
  payload: Record<string, unknown>;
}

export interface MigrateSectionIdentityResult {
  migration: string;
  scanned: number;
  migrated: number;
  skipped: number;
  events: number;
  noteIds: string[];
}

export interface RegisterPluginInput {
  manifest: PluginManifestInput;
  registrationKind?: "static" | "dynamic";
  actor?: Actor;
}

export interface RegisterPluginResult {
  namespace: string;
  eventId: string;
  created: boolean;
  manifest: PluginManifest;
  meta: PluginMeta;
}

export interface CorePluginRecord {
  manifest: PluginManifest;
  meta: PluginMeta;
}

export interface PluginLifecycleActionInput {
  namespace: string;
  actor?: Actor;
  disableReason?: string;
}

export interface PluginLifecycleActionResult {
  namespace: string;
  state: PluginLifecycleState;
  eventId: string;
  meta: PluginMeta;
}

export interface PluginSchedulerRun {
  namespace: string;
  taskId: string;
  actionId: string;
  scheduledFor: string;
  slotKey: string;
  timezone: string;
  idempotencyKey: PluginScheduledTaskDefinition["idempotencyKey"];
  runWindowMinutes: number;
  dedupeKey: string;
}

export interface RunPluginSchedulerInput {
  now?: string;
  namespaces?: string[];
  actor?: Actor;
  executor?: (run: PluginSchedulerRun) => Promise<void>;
}

export interface RunPluginSchedulerResult {
  now: string;
  consideredTasks: number;
  dueRuns: number;
  executedRuns: PluginSchedulerRun[];
  failedRuns: Array<{ run: PluginSchedulerRun; error: string }>;
  skippedAsDuplicate: number;
  ledgerEntries: number;
}

export interface GetPluginSchedulerStatusInput {
  namespace?: string;
  limit?: number;
}

export interface PluginSchedulerTaskStatus {
  namespace: string;
  taskId: string;
  actionId: string;
  idempotencyKey: PluginScheduledTaskDefinition["idempotencyKey"];
  runs: number;
  lastScheduledFor: string;
  lastExecutedAt: string;
}

export interface PluginSchedulerStatus {
  ledgerEntries: number;
  updatedAt: string | null;
  taskSummaries: PluginSchedulerTaskStatus[];
  recentRuns: PluginSchedulerLedgerEntry[];
}

export interface ListPluginTemplatesInput {
  namespace?: string;
  includeUnavailable?: boolean;
}

export interface CorePluginTemplateRecord {
  namespace: string;
  lifecycleState: PluginLifecycleState;
  available: boolean;
  template: PluginTemplateDefinition;
}

export interface ApplyPluginTemplateInput {
  namespace: string;
  templateId: string;
  title?: string;
  noteType?: string;
  tags?: string[];
  actor?: Actor;
}

export interface ApplyPluginTemplateResult extends SaveNoteResult {
  namespace: string;
  templateId: string;
}

export type PluginActionHost = "cli" | "api";

export interface RecordPluginActionEventInput {
  namespace: string;
  actionId: string;
  requestId: string;
  actor?: Actor;
  host: PluginActionHost;
  status: "success" | "failure";
  durationMs: number;
  inputBytes?: number;
  outputBytes?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface RecordPluginActionEventResult {
  eventId: string;
  type: "plugin.action_invoked" | "plugin.action_failed";
  timestamp: string;
}

export interface PluginEntityCompatibility {
  manifestSchemaVersion: string;
  entitySchemaVersion: string;
  mode: "current" | "mixed";
}

export interface CorePluginEntityRecord {
  entity: PluginEntityRecord;
  meta: PluginEntityMeta;
  compatibility: PluginEntityCompatibility;
}

export interface CreatePluginEntityInput {
  namespace: string;
  entityType: string;
  id?: string;
  schemaVersion?: string;
  data: Record<string, unknown>;
  links?: PluginEntityMeta["links"];
  actor?: Actor;
}

export interface UpdatePluginEntityInput {
  namespace: string;
  entityType: string;
  id: string;
  schemaVersion?: string;
  data: Record<string, unknown>;
  links?: PluginEntityMeta["links"];
  actor?: Actor;
}

export interface GetPluginEntityInput {
  namespace: string;
  entityType: string;
  id: string;
}

export interface ListPluginEntitiesInput {
  namespace: string;
  entityType: string;
  schemaVersion?: string;
}

export interface ProposalActionInput {
  proposalId: string;
  actor?: Actor;
}

export interface ProposalActionResult {
  proposalId: string;
  noteId: string;
  status: ProposalStatus;
  eventId: string;
  noteEventId?: string;
}

export interface RemCoreOptions {
  storeRoot?: string;
}

export interface CoreStoreRootConfig extends RemConfig {
  configPath: string;
  defaultStoreRoot: string;
  configuredStoreRoot: string | null;
  effectiveStoreRoot: string;
  source: StoreRootSource;
}

let runtimeStoreRootOverride: string | null = null;

function expandHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }

  return value;
}

function normalizePathInput(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return path.resolve(expandHomePath(trimmed));
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function resolveConfigPath(): string {
  return (
    normalizePathInput(process.env.REM_CONFIG_PATH) ?? path.join(DEFAULT_STORE_ROOT, "config.json")
  );
}

async function loadStoredCoreConfig(): Promise<RemConfig | null> {
  const configPath = resolveConfigPath();

  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }

    const normalizedStoreRoot = normalizePathInput(parsed.data.storeRoot);
    if (!normalizedStoreRoot) {
      return null;
    }

    return {
      ...parsed.data,
      storeRoot: normalizedStoreRoot,
    };
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }

    return null;
  }
}

async function persistCoreConfig(storeRoot: string): Promise<RemConfig> {
  const normalizedStoreRoot = normalizePathInput(storeRoot);
  if (!normalizedStoreRoot) {
    throw new Error("Store root must be a non-empty path.");
  }

  const config = configSchema.parse({
    schemaVersion: CORE_CONFIG_SCHEMA_VERSION,
    storeRoot: normalizedStoreRoot,
  });

  const configPath = resolveConfigPath();
  const configDir = path.dirname(configPath);
  const tempConfigPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(configDir, { recursive: true });

  try {
    await writeFile(tempConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(tempConfigPath, configPath);
  } catch (error) {
    await rm(tempConfigPath, { force: true }).catch(() => {});
    throw error;
  }

  return config;
}

async function clearStoredCoreConfig(): Promise<void> {
  await rm(resolveConfigPath(), { force: true }).catch((error) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  });
}

async function resolveStoreRoot(): Promise<{ storeRoot: string; source: StoreRootSource }> {
  if (runtimeStoreRootOverride) {
    return { storeRoot: runtimeStoreRootOverride, source: "runtime" };
  }

  const fromEnv = normalizePathInput(process.env.REM_STORE_ROOT);
  if (fromEnv) {
    return { storeRoot: fromEnv, source: "env" };
  }

  const fromConfig = await loadStoredCoreConfig();
  if (fromConfig) {
    return { storeRoot: fromConfig.storeRoot, source: "config" };
  }

  return { storeRoot: DEFAULT_STORE_ROOT, source: "default" };
}

function extractRootChildren(lexicalState: unknown): unknown[] {
  const state = lexicalState as LexicalRootLike;
  if (!state?.root || !Array.isArray(state.root.children)) {
    return [];
  }

  return state.root.children;
}

function textToReplacementNodes(text: string): unknown[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const normalized = lines.length > 0 ? lines : [""];

  return normalized.map((line) => ({
    type: "paragraph",
    version: 1,
    children: [
      {
        type: "text",
        version: 1,
        text: line,
      },
    ],
  }));
}

function proposalContentToReplacementNodes(content: ProposalContent): unknown[] {
  if (content.format === "text") {
    return textToReplacementNodes(content.content as string);
  }

  if (content.format === "lexical") {
    const parsed = lexicalStateSchema.parse(content.content);
    return extractRootChildren(parsed);
  }

  const jsonPayload = content.content as LexicalRootLike;
  if (jsonPayload && typeof jsonPayload === "object" && Array.isArray(jsonPayload.root?.children)) {
    return jsonPayload.root.children;
  }

  throw new Error("JSON proposal content must include root.children for section replacement");
}

function dedupeNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function parseStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return dedupeNonEmptyStrings(raw.filter((value): value is string => typeof value === "string"));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function areSectionIndexesEquivalent(left: NoteSectionIndex, right: NoteSectionIndex): boolean {
  if (left.sections.length !== right.sections.length) {
    return false;
  }

  for (let index = 0; index < left.sections.length; index += 1) {
    const leftSection = left.sections[index];
    const rightSection = right.sections[index];
    if (!leftSection || !rightSection) {
      return false;
    }

    if (
      leftSection.sectionId !== rightSection.sectionId ||
      leftSection.noteId !== rightSection.noteId ||
      leftSection.headingText !== rightSection.headingText ||
      leftSection.headingLevel !== rightSection.headingLevel ||
      leftSection.startNodeIndex !== rightSection.startNodeIndex ||
      leftSection.endNodeIndex !== rightSection.endNodeIndex ||
      leftSection.position !== rightSection.position
    ) {
      return false;
    }

    if (leftSection.fallbackPath.length !== rightSection.fallbackPath.length) {
      return false;
    }

    for (let pathIndex = 0; pathIndex < leftSection.fallbackPath.length; pathIndex += 1) {
      if (leftSection.fallbackPath[pathIndex] !== rightSection.fallbackPath[pathIndex]) {
        return false;
      }
    }
  }

  return true;
}

function doesValueMatchPluginType(
  value: unknown,
  type: "string" | "number" | "boolean" | "object" | "array",
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function assertPluginPayloadMatchesSchema(
  scope: string,
  payload: unknown,
  schema: PluginPayloadSchema,
): void {
  if (!isPlainObject(payload)) {
    throw new Error(`Plugin payload for ${scope} must be an object`);
  }

  for (const requiredField of schema.required) {
    if (!(requiredField in payload)) {
      throw new Error(`Plugin payload for ${scope} missing required field: ${requiredField}`);
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    const field = schema.properties[key];

    if (!field) {
      if (!schema.additionalProperties) {
        throw new Error(`Plugin payload for ${scope} has unknown field: ${key}`);
      }
      continue;
    }

    if (!doesValueMatchPluginType(value, field.type)) {
      throw new Error(`Plugin payload for ${scope}.${key} must be ${field.type}`);
    }

    if (field.type === "array" && field.items && Array.isArray(value)) {
      const itemType = field.items.type;
      const invalidItem = value.find((item) => !doesValueMatchPluginType(item, itemType));
      if (invalidItem !== undefined) {
        throw new Error(`Plugin payload for ${scope}.${key} must contain ${itemType} values`);
      }
    }
  }
}

const PLUGIN_LIFECYCLE_ALLOWED_TRANSITIONS: Record<PluginLifecycleState, PluginLifecycleState[]> = {
  registered: ["installed"],
  installed: ["registered", "enabled", "disabled"],
  enabled: ["registered", "disabled"],
  disabled: ["registered", "installed", "enabled"],
};

function isPluginLifecycleTransitionAllowed(
  from: PluginLifecycleState,
  to: PluginLifecycleState,
): boolean {
  if (from === to) {
    return true;
  }

  return PLUGIN_LIFECYCLE_ALLOWED_TRANSITIONS[from].includes(to);
}

function didPluginPermissionsExpand(previous: PluginManifest, next: PluginManifest): boolean {
  const previousPermissions = new Set(previous.permissions ?? []);
  for (const permission of next.permissions ?? []) {
    if (!previousPermissions.has(permission)) {
      return true;
    }
  }

  return false;
}

function applyPluginLifecycleMetaUpdate(
  meta: PluginMeta,
  nextState: PluginLifecycleState,
  nowIso: string,
  disableReason?: string,
): PluginMeta {
  const isRegistered = nextState === "registered";
  return pluginMetaSchema.parse({
    ...meta,
    updatedAt: nowIso,
    lifecycleState: nextState,
    disableReason: nextState === "disabled" ? (disableReason ?? "manual_disable") : undefined,
    installedAt: isRegistered
      ? undefined
      : nextState === "installed"
        ? (meta.installedAt ?? nowIso)
        : meta.installedAt,
    enabledAt: isRegistered ? undefined : nextState === "enabled" ? nowIso : meta.enabledAt,
    disabledAt: isRegistered ? undefined : nextState === "disabled" ? nowIso : meta.disabledAt,
  });
}

function isPluginTemplateAvailable(state: PluginLifecycleState): boolean {
  return state === "installed" || state === "enabled";
}

function resolveEntitySchemaVersionForWrite(
  schemaVersionInput: string | undefined,
  manifestSchemaVersion: string,
  namespace: string,
  entityType: string,
): string {
  const requestedSchemaVersion = schemaVersionInput?.trim();
  if (!requestedSchemaVersion) {
    return manifestSchemaVersion;
  }

  if (requestedSchemaVersion !== manifestSchemaVersion) {
    throw new Error(
      `Entity schemaVersion ${requestedSchemaVersion} is not writable for ${namespace}/${entityType}; current schemaVersion is ${manifestSchemaVersion}`,
    );
  }

  return requestedSchemaVersion;
}

function buildPluginEntityCompatibility(
  entity: PluginEntityRecord,
  manifestSchemaVersion: string,
): PluginEntityCompatibility {
  return {
    manifestSchemaVersion,
    entitySchemaVersion: entity.schemaVersion,
    mode: entity.schemaVersion === manifestSchemaVersion ? "current" : "mixed",
  };
}

function assertEntityReadCompatibility(
  entity: PluginEntityRecord,
  entityTypeDefinition: PluginEntityTypeDefinition,
  manifestSchemaVersion: string,
): PluginEntityCompatibility {
  const compatibility = buildPluginEntityCompatibility(entity, manifestSchemaVersion);
  if (compatibility.mode === "current") {
    assertPluginPayloadMatchesSchema(
      `${entity.namespace}.${entity.entityType}`,
      entity.data,
      entityTypeDefinition.schema,
    );
  }

  return compatibility;
}

type SchedulerWeekdayToken = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

type ZonedMinuteParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: SchedulerWeekdayToken;
};

type SchedulerCandidateSlot = {
  scheduledFor: string;
  scheduledForMs: number;
  slotKey: string;
};

const SCHEDULER_WEEKDAY_MAP: Record<string, SchedulerWeekdayToken> = {
  Mon: "MO",
  Tue: "TU",
  Wed: "WE",
  Thu: "TH",
  Fri: "FR",
  Sat: "SA",
  Sun: "SU",
};

const schedulerFormatterByTimeZone = new Map<string, Intl.DateTimeFormat>();

function getHostTimeZone(): string {
  const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof resolvedTimeZone === "string" && resolvedTimeZone.length > 0
    ? resolvedTimeZone
    : "UTC";
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function resolveTaskTimeZone(timeZoneInput: string | undefined): string {
  if (timeZoneInput && isValidTimeZone(timeZoneInput)) {
    return timeZoneInput;
  }

  return getHostTimeZone();
}

function getSchedulerFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = schedulerFormatterByTimeZone.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  schedulerFormatterByTimeZone.set(timeZone, formatter);
  return formatter;
}

function parseZonedMinuteParts(instantMs: number, timeZone: string): ZonedMinuteParts {
  const parts = getSchedulerFormatter(timeZone).formatToParts(new Date(instantMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = SCHEDULER_WEEKDAY_MAP[values.weekday ?? ""];

  if (!weekday) {
    throw new Error(`Unable to parse scheduler weekday for timezone ${timeZone}`);
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday,
  };
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatSchedulerSlotKey(parts: ZonedMinuteParts, timeZone: string): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}@${timeZone}`;
}

function isTaskScheduledForMinute(
  task: PluginScheduledTaskDefinition,
  parts: ZonedMinuteParts,
): boolean {
  const targetMinute = task.schedule.minute ?? 0;
  const targetHour = task.schedule.hour ?? 0;

  if (task.schedule.kind === "hourly") {
    return parts.minute === targetMinute;
  }

  if (task.schedule.kind === "weekly") {
    return (
      parts.weekday === task.schedule.weekday &&
      parts.hour === targetHour &&
      parts.minute === targetMinute
    );
  }

  return parts.hour === targetHour && parts.minute === targetMinute;
}

function collectDueTaskSlots(
  task: PluginScheduledTaskDefinition,
  nowMinuteMs: number,
  timeZone: string,
): SchedulerCandidateSlot[] {
  const runWindowMinutes = task.runWindowMinutes ?? DEFAULT_SCHEDULER_RUN_WINDOW_MINUTES;
  const slots: SchedulerCandidateSlot[] = [];
  const seenSlotKeys = new Set<string>();

  for (let deltaMinutes = runWindowMinutes; deltaMinutes >= 0; deltaMinutes -= 1) {
    const slotMs = nowMinuteMs - deltaMinutes * 60_000;
    const parts = parseZonedMinuteParts(slotMs, timeZone);
    if (!isTaskScheduledForMinute(task, parts)) {
      continue;
    }

    const slotKey = formatSchedulerSlotKey(parts, timeZone);
    if (seenSlotKeys.has(slotKey)) {
      continue;
    }

    seenSlotKeys.add(slotKey);
    slots.push({
      scheduledForMs: slotMs,
      scheduledFor: new Date(slotMs).toISOString(),
      slotKey,
    });
  }

  return slots;
}

function buildSchedulerDedupeKey(
  namespace: string,
  task: PluginScheduledTaskDefinition,
  slot: SchedulerCandidateSlot,
): string {
  if (task.idempotencyKey === "calendar_slot") {
    return `${namespace}:${task.id}:${task.idempotencyKey}:${slot.slotKey}`;
  }

  const hashInput = JSON.stringify({
    namespace,
    taskId: task.id,
    actionId: task.actionId,
    scheduledFor: slot.scheduledFor,
    slotKey: slot.slotKey,
  });

  return `${namespace}:${task.id}:${task.idempotencyKey}:${createHash("sha256").update(hashInput).digest("hex")}`;
}

function resolveSchedulerLedgerPath(paths: StorePaths): string {
  return path.join(paths.root, "runtime", "scheduler-ledger.json");
}

async function loadSchedulerLedger(paths: StorePaths): Promise<PluginSchedulerLedger> {
  const ledgerPath = resolveSchedulerLedgerPath(paths);
  try {
    const raw = await readFile(ledgerPath, "utf8");
    const parsed = pluginSchedulerLedgerSchema.parse(JSON.parse(raw));
    const dedupedEntries = new Map<string, PluginSchedulerLedgerEntry>();
    for (const entry of parsed.entries) {
      dedupedEntries.set(entry.dedupeKey, entry);
    }

    return pluginSchedulerLedgerSchema.parse({
      schemaVersion: SCHEDULER_LEDGER_SCHEMA_VERSION,
      updatedAt: parsed.updatedAt,
      entries: Array.from(dedupedEntries.values()).sort((left, right) =>
        left.executedAt.localeCompare(right.executedAt),
      ),
    });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return pluginSchedulerLedgerSchema.parse({
        schemaVersion: SCHEDULER_LEDGER_SCHEMA_VERSION,
        updatedAt: new Date(0).toISOString(),
        entries: [],
      });
    }

    throw error;
  }
}

async function saveSchedulerLedger(
  paths: StorePaths,
  ledger: PluginSchedulerLedger,
): Promise<void> {
  const ledgerPath = resolveSchedulerLedgerPath(paths);
  const runtimeDir = path.dirname(ledgerPath);
  const tempPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;

  await mkdir(runtimeDir, { recursive: true });
  try {
    await writeFile(
      tempPath,
      `${JSON.stringify(pluginSchedulerLedgerSchema.parse(ledger), null, 2)}\n`,
      "utf8",
    );
    await rename(tempPath, ledgerPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function proposalContentToAnnotationOperations(content: ProposalContent): AnnotationOperations {
  if (content.format === "text") {
    return {
      annotationNodes: textToReplacementNodes(content.content as string),
      tagsToAdd: [],
      tagsToRemove: [],
    };
  }

  if (content.format === "lexical") {
    const parsed = lexicalStateSchema.parse(content.content);
    return {
      annotationNodes: extractRootChildren(parsed),
      tagsToAdd: [],
      tagsToRemove: [],
    };
  }

  const payload = content.content;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Annotate proposal JSON content must be an object");
  }

  const jsonPayload = payload as {
    root?: { children?: unknown };
    tagsToAdd?: unknown;
    tagsToRemove?: unknown;
    tags?: { add?: unknown; remove?: unknown };
    setTitle?: unknown;
    title?: unknown;
  };

  const annotationNodes = Array.isArray(jsonPayload.root?.children)
    ? jsonPayload.root.children
    : [];
  const tagsToAdd = dedupeNonEmptyStrings([
    ...parseStringList(jsonPayload.tagsToAdd),
    ...parseStringList(jsonPayload.tags?.add),
  ]);
  const tagsToRemove = dedupeNonEmptyStrings([
    ...parseStringList(jsonPayload.tagsToRemove),
    ...parseStringList(jsonPayload.tags?.remove),
  ]);

  const rawTitle = jsonPayload.setTitle ?? jsonPayload.title;
  const titleOverride =
    typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : undefined;

  if (
    annotationNodes.length === 0 &&
    tagsToAdd.length === 0 &&
    tagsToRemove.length === 0 &&
    !titleOverride
  ) {
    throw new Error(
      "Annotate proposal JSON content must include root.children, tagsToAdd/tagsToRemove, or setTitle/title",
    );
  }

  return {
    annotationNodes,
    tagsToAdd,
    tagsToRemove,
    titleOverride,
  };
}

function replaceSectionInLexicalState(
  lexicalState: unknown,
  section: NoteSection,
  replacementNodes: unknown[],
): unknown {
  const parsed = lexicalStateSchema.parse(lexicalState) as LexicalRootLike;
  const root = parsed.root;

  if (!root || !Array.isArray(root.children)) {
    throw new Error("Target note has invalid lexical root children");
  }

  if (section.startNodeIndex > section.endNodeIndex) {
    throw new Error(`Invalid section bounds for ${section.sectionId}`);
  }

  const nextChildren = [...root.children];
  if (section.endNodeIndex >= nextChildren.length) {
    throw new Error(`Section ${section.sectionId} is out of bounds for target note`);
  }

  nextChildren.splice(
    section.startNodeIndex,
    section.endNodeIndex - section.startNodeIndex + 1,
    ...replacementNodes,
  );

  return {
    ...parsed,
    root: {
      ...root,
      children: nextChildren,
    },
  };
}

function appendToSectionInLexicalState(
  lexicalState: unknown,
  section: NoteSection,
  annotationNodes: unknown[],
): unknown {
  const parsed = lexicalStateSchema.parse(lexicalState) as LexicalRootLike;
  const root = parsed.root;

  if (!root || !Array.isArray(root.children)) {
    throw new Error("Target note has invalid lexical root children");
  }

  if (section.startNodeIndex > section.endNodeIndex) {
    throw new Error(`Invalid section bounds for ${section.sectionId}`);
  }

  const nextChildren = [...root.children];
  if (section.endNodeIndex >= nextChildren.length) {
    throw new Error(`Section ${section.sectionId} is out of bounds for target note`);
  }

  nextChildren.splice(section.endNodeIndex + 1, 0, ...annotationNodes);

  return {
    ...parsed,
    root: {
      ...root,
      children: nextChildren,
    },
  };
}

export class RemCore {
  private readonly paths: StorePaths;
  private index: RemIndex;

  private constructor(paths: StorePaths) {
    this.paths = paths;
    this.index = new RemIndex(paths.dbPath);
  }

  static async create(options?: RemCoreOptions): Promise<RemCore> {
    const optionStoreRoot = normalizePathInput(options?.storeRoot);
    const storeRoot = optionStoreRoot ?? (await resolveStoreRoot()).storeRoot;
    const paths = resolveStorePaths(storeRoot);
    await ensureStoreLayout(paths);
    return new RemCore(paths);
  }

  async close(): Promise<void> {
    this.index.close();
  }

  private async validatePluginPayloads(plugins: Record<string, unknown>): Promise<void> {
    const namespaces = Object.keys(plugins);
    if (namespaces.length === 0) {
      return;
    }

    for (const namespace of namespaces) {
      const payload = plugins[namespace];
      const stored = await loadStoredPlugin(this.paths, namespace);
      if (!stored) {
        throw new Error(`Plugin not registered: ${namespace}`);
      }

      assertPluginPayloadMatchesSchema(namespace, payload, stored.manifest.payloadSchema);
    }
  }

  async status(): Promise<CoreStatus> {
    const stats = this.index.getStats();
    const latestEvent = this.index.listEvents({ limit: 1 })[0];
    const healthHints: string[] = [];

    if (stats.eventCount === 0) {
      healthHints.push("No indexed events yet; save a note or proposal to populate history.");
    }

    if (stats.eventCount > 0 && stats.noteCount === 0) {
      healthHints.push(
        "Events are indexed but no notes are indexed; run rebuild-index if unexpected.",
      );
    }

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      storeRoot: this.paths.root,
      notes: stats.noteCount,
      proposals: stats.proposalCount,
      events: stats.eventCount,
      plugins: stats.pluginCount,
      lastIndexedEventAt: latestEvent?.timestamp ?? null,
      healthHints,
    };
  }

  async saveNote(input: SaveNoteInput): Promise<SaveNoteResult> {
    const actor = actorSchema.parse(input.actor ?? { kind: "human" });
    const note = lexicalStateSchema.parse(input.lexicalState);
    const nowIso = new Date().toISOString();
    const overrideReason = input.overrideReason?.trim() || undefined;
    const approvedBy = input.approvedBy?.trim() || undefined;
    const sourcePlugin = input.sourcePlugin?.trim() || undefined;

    const noteId = input.id ?? randomUUID();
    const existing = await loadNote(this.paths, noteId);
    const created = !existing;
    const createdAt = existing?.meta.createdAt ?? nowIso;
    const plugins = input.plugins ?? existing?.meta.plugins ?? {};
    await this.validatePluginPayloads(plugins);

    const meta = noteMetaSchema.parse({
      id: noteId,
      schemaVersion: CORE_SCHEMA_VERSION,
      title: input.title,
      noteType: input.noteType ?? existing?.meta.noteType ?? "note",
      createdAt,
      updatedAt: nowIso,
      author: actor,
      tags: input.tags ?? [],
      plugins,
      sectionIndexVersion: SECTION_INDEX_VERSION,
    });

    const sectionIndex = noteSectionIndexSchema.parse(
      buildSectionIndexFromLexical(noteId, note, {
        schemaVersion: CORE_SCHEMA_VERSION,
        existingSectionIndex: existing?.sectionIndex ?? undefined,
        existingLexicalState: existing?.note,
      }),
    );

    await saveNote(this.paths, noteId, note, meta, sectionIndex);

    const extracted = extractPlainTextFromLexical(note);
    this.index.upsertNote(meta, extracted);
    this.index.upsertSections(noteId, sectionIndex.sections);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: created ? "note.created" : "note.updated",
      actor,
      entity: {
        kind: "note",
        id: noteId,
      },
      payload: {
        noteId,
        title: meta.title,
        tags: meta.tags,
        overrideReason,
        approvedBy,
        sourcePlugin,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      noteId,
      eventId: event.eventId,
      created,
      meta,
    };
  }

  async searchNotes(query: string, input?: SearchNotesInput | number): Promise<CoreSearchResult[]> {
    const normalizedInput =
      typeof input === "number"
        ? {
            limit: input,
          }
        : input;

    return this.index.search(query, normalizedInput);
  }

  async listEvents(input?: ListEventsInput): Promise<CoreEventRecord[]> {
    const indexedEvents = this.index.listEvents(input);
    return indexedEvents.map((event) => ({
      eventId: event.eventId,
      timestamp: event.timestamp,
      type: event.type,
      actor: {
        kind: event.actorKind,
        id: event.actorId ?? undefined,
      },
      entity: {
        kind: event.entityKind,
        id: event.entityId,
      },
      payload: event.payload,
    }));
  }

  async recordPluginActionEvent(
    input: RecordPluginActionEventInput,
  ): Promise<RecordPluginActionEventResult> {
    const namespace = pluginNamespaceSchema.parse(input.namespace.trim());
    const actionId = input.actionId.trim();
    if (!actionId) {
      throw new Error("Plugin actionId is required");
    }

    const requestId = input.requestId.trim();
    if (!requestId) {
      throw new Error("Plugin requestId is required");
    }

    const storedPlugin = await loadStoredPlugin(this.paths, namespace);
    if (!storedPlugin) {
      throw new Error(`Plugin not registered: ${namespace}`);
    }

    const actor = actorSchema.parse(input.actor ?? { kind: "human", id: `${input.host}-runtime` });
    const nowIso = new Date().toISOString();
    const durationMs = Number.isFinite(input.durationMs)
      ? Math.max(0, Math.floor(input.durationMs))
      : 0;
    const inputBytes =
      typeof input.inputBytes === "number" && Number.isFinite(input.inputBytes)
        ? Math.max(0, Math.floor(input.inputBytes))
        : undefined;
    const outputBytes =
      typeof input.outputBytes === "number" && Number.isFinite(input.outputBytes)
        ? Math.max(0, Math.floor(input.outputBytes))
        : undefined;
    const errorCode =
      input.status === "failure" ? input.errorCode?.trim() || "plugin_run_failed" : undefined;
    const errorMessage =
      input.status === "failure" ? input.errorMessage?.trim() || "Plugin action failed" : undefined;

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: input.status === "success" ? "plugin.action_invoked" : "plugin.action_failed",
      actor,
      entity: {
        kind: "plugin",
        id: namespace,
      },
      payload: {
        namespace,
        actionId,
        requestId,
        actorKind: actor.kind,
        actorId: actor.id,
        host: input.host,
        durationMs,
        inputBytes,
        outputBytes,
        status: input.status,
        errorCode,
        errorMessage,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      eventId: event.eventId,
      timestamp: event.timestamp,
      type: event.type as "plugin.action_invoked" | "plugin.action_failed",
    };
  }

  async registerPlugin(input: RegisterPluginInput): Promise<RegisterPluginResult> {
    const manifest = pluginManifestSchema.parse(input.manifest);
    const actor = actorSchema.parse(input.actor ?? { kind: "human", id: "plugin-admin" });
    const existing = await loadStoredPlugin(this.paths, manifest.namespace);
    const nowIso = new Date().toISOString();
    const existingMeta = existing ? pluginMetaSchema.parse(existing.meta) : null;
    const permissionsExpanded =
      existing !== null ? didPluginPermissionsExpand(existing.manifest, manifest) : false;

    const nextLifecycleState: PluginLifecycleState = permissionsExpanded
      ? "disabled"
      : (existingMeta?.lifecycleState ?? "registered");

    const meta = pluginMetaSchema.parse({
      namespace: manifest.namespace,
      schemaVersion: manifest.schemaVersion,
      registeredAt: existingMeta?.registeredAt ?? nowIso,
      updatedAt: nowIso,
      registrationKind: input.registrationKind ?? existingMeta?.registrationKind ?? "dynamic",
      lifecycleState: nextLifecycleState,
      disableReason: permissionsExpanded
        ? "permissions_expanded"
        : nextLifecycleState === "disabled"
          ? existingMeta?.disableReason
          : undefined,
      installedAt: existingMeta?.installedAt,
      enabledAt: existingMeta?.enabledAt,
      disabledAt: permissionsExpanded ? nowIso : existingMeta?.disabledAt,
    });

    await savePluginToStore(this.paths, manifest, meta);
    this.index.upsertPluginManifest(
      manifest.namespace,
      manifest.schemaVersion,
      meta.registeredAt,
      meta.updatedAt,
      manifest,
    );

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: existing ? "plugin.updated" : "plugin.registered",
      actor,
      entity: {
        kind: "plugin",
        id: manifest.namespace,
      },
      payload: {
        namespace: manifest.namespace,
        schemaVersion: manifest.schemaVersion,
        registrationKind: meta.registrationKind,
        lifecycleState: meta.lifecycleState,
        disableReason: meta.disableReason,
        permissionsExpanded,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      namespace: manifest.namespace,
      eventId: event.eventId,
      created: !existing,
      manifest,
      meta,
    };
  }

  async getPlugin(namespace: string): Promise<CorePluginRecord | null> {
    const stored = await loadStoredPlugin(this.paths, namespace);
    if (!stored) {
      return null;
    }

    return {
      manifest: pluginManifestSchema.parse(stored.manifest),
      meta: pluginMetaSchema.parse(stored.meta),
    };
  }

  private async resolvePluginEntityTypeDefinition(
    namespace: string,
    entityType: string,
  ): Promise<{
    plugin: CorePluginRecord;
    entityTypeDefinition: PluginEntityTypeDefinition;
  }> {
    const plugin = await this.getPlugin(namespace);
    if (!plugin) {
      throw new Error(`Plugin not found: ${namespace}`);
    }

    if (!plugin.manifest.capabilities?.includes("entities")) {
      throw new Error(`Plugin ${namespace} does not expose entities capability`);
    }

    const entityTypeDefinition = plugin.manifest.entityTypes?.find(
      (entry) => entry.id === entityType,
    );
    if (!entityTypeDefinition) {
      throw new Error(`Entity type not found: ${namespace}/${entityType}`);
    }

    return {
      plugin,
      entityTypeDefinition,
    };
  }

  private toCorePluginEntityRecord(
    entity: PluginEntityRecord,
    meta: PluginEntityMeta,
    entityTypeDefinition: PluginEntityTypeDefinition,
    manifestSchemaVersion: string,
  ): CorePluginEntityRecord {
    const compatibility = assertEntityReadCompatibility(
      entity,
      entityTypeDefinition,
      manifestSchemaVersion,
    );

    return {
      entity,
      meta,
      compatibility,
    };
  }

  async createPluginEntity(input: CreatePluginEntityInput): Promise<CorePluginEntityRecord> {
    const namespace = pluginNamespaceSchema.parse(input.namespace.trim());
    const entityType = pluginEntityTypeIdSchema.parse(input.entityType.trim());
    const entityId = pluginEntityIdSchema.parse((input.id ?? randomUUID()).trim());
    const actor = actorSchema.parse(input.actor ?? { kind: "human", id: "entity-admin" });

    if (!isPlainObject(input.data)) {
      throw new Error(`Plugin payload for ${namespace}.${entityType} must be an object`);
    }

    const { plugin, entityTypeDefinition } = await this.resolvePluginEntityTypeDefinition(
      namespace,
      entityType,
    );
    const schemaVersion = resolveEntitySchemaVersionForWrite(
      input.schemaVersion,
      plugin.manifest.schemaVersion,
      namespace,
      entityType,
    );

    assertPluginPayloadMatchesSchema(
      `${namespace}.${entityType}`,
      input.data,
      entityTypeDefinition.schema,
    );

    const existing = await loadStoredPluginEntity(this.paths, namespace, entityType, entityId);
    if (existing) {
      throw new Error(`Entity already exists: ${namespace}/${entityType}/${entityId}`);
    }

    const nowIso = new Date().toISOString();
    const entity = pluginEntityRecordSchema.parse({
      id: entityId,
      namespace,
      entityType,
      schemaVersion,
      data: input.data,
    });
    const meta = pluginEntityMetaSchema.parse({
      createdAt: nowIso,
      updatedAt: nowIso,
      actor,
      links: input.links,
    });

    await savePluginEntityToStore(this.paths, entity, meta);
    this.index.upsertEntity(entity, meta, entityTypeDefinition.indexes?.textFields);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "entity.created",
      actor,
      entity: {
        kind: "plugin",
        id: namespace,
      },
      payload: {
        namespace,
        entityType,
        entityId,
        schemaVersion,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return this.toCorePluginEntityRecord(
      entity,
      meta,
      entityTypeDefinition,
      plugin.manifest.schemaVersion,
    );
  }

  async updatePluginEntity(input: UpdatePluginEntityInput): Promise<CorePluginEntityRecord> {
    const namespace = pluginNamespaceSchema.parse(input.namespace.trim());
    const entityType = pluginEntityTypeIdSchema.parse(input.entityType.trim());
    const entityId = pluginEntityIdSchema.parse(input.id.trim());
    const actor = actorSchema.parse(input.actor ?? { kind: "human", id: "entity-admin" });

    if (!isPlainObject(input.data)) {
      throw new Error(`Plugin payload for ${namespace}.${entityType} must be an object`);
    }

    const existing = await loadStoredPluginEntity(this.paths, namespace, entityType, entityId);
    if (!existing) {
      throw new Error(`Entity not found: ${namespace}/${entityType}/${entityId}`);
    }

    const { plugin, entityTypeDefinition } = await this.resolvePluginEntityTypeDefinition(
      namespace,
      entityType,
    );
    const schemaVersion = resolveEntitySchemaVersionForWrite(
      input.schemaVersion,
      plugin.manifest.schemaVersion,
      namespace,
      entityType,
    );

    assertPluginPayloadMatchesSchema(
      `${namespace}.${entityType}`,
      input.data,
      entityTypeDefinition.schema,
    );

    const nowIso = new Date().toISOString();
    const entity = pluginEntityRecordSchema.parse({
      id: entityId,
      namespace,
      entityType,
      schemaVersion,
      data: input.data,
    });
    const meta = pluginEntityMetaSchema.parse({
      createdAt: existing.meta.createdAt,
      updatedAt: nowIso,
      actor,
      links: input.links ?? existing.meta.links,
    });

    await savePluginEntityToStore(this.paths, entity, meta);
    this.index.upsertEntity(entity, meta, entityTypeDefinition.indexes?.textFields);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "entity.updated",
      actor,
      entity: {
        kind: "plugin",
        id: namespace,
      },
      payload: {
        namespace,
        entityType,
        entityId,
        schemaVersion,
        previousSchemaVersion: existing.entity.schemaVersion,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return this.toCorePluginEntityRecord(
      entity,
      meta,
      entityTypeDefinition,
      plugin.manifest.schemaVersion,
    );
  }

  async getPluginEntity(input: GetPluginEntityInput): Promise<CorePluginEntityRecord | null> {
    const namespace = pluginNamespaceSchema.parse(input.namespace.trim());
    const entityType = pluginEntityTypeIdSchema.parse(input.entityType.trim());
    const entityId = pluginEntityIdSchema.parse(input.id.trim());
    const loaded = await loadStoredPluginEntity(this.paths, namespace, entityType, entityId);
    if (!loaded) {
      return null;
    }

    const { plugin, entityTypeDefinition } = await this.resolvePluginEntityTypeDefinition(
      namespace,
      entityType,
    );

    return this.toCorePluginEntityRecord(
      loaded.entity,
      loaded.meta,
      entityTypeDefinition,
      plugin.manifest.schemaVersion,
    );
  }

  async listPluginEntities(input: ListPluginEntitiesInput): Promise<CorePluginEntityRecord[]> {
    const namespace = pluginNamespaceSchema.parse(input.namespace.trim());
    const entityType = pluginEntityTypeIdSchema.parse(input.entityType.trim());
    const schemaVersionFilter = input.schemaVersion?.trim();
    const { plugin, entityTypeDefinition } = await this.resolvePluginEntityTypeDefinition(
      namespace,
      entityType,
    );
    const entities = await listStoredPluginEntities(this.paths, namespace, entityType);

    return entities
      .map((entry) =>
        this.toCorePluginEntityRecord(
          entry.entity,
          entry.meta,
          entityTypeDefinition,
          plugin.manifest.schemaVersion,
        ),
      )
      .filter((entry) =>
        schemaVersionFilter ? entry.entity.schemaVersion === schemaVersionFilter : true,
      )
      .sort((left, right) => left.entity.id.localeCompare(right.entity.id));
  }

  private async transitionPluginLifecycle(
    namespace: string,
    nextState: PluginLifecycleState,
    actorInput: Actor | undefined,
    disableReason?: string,
  ): Promise<PluginLifecycleActionResult> {
    const actor = actorSchema.parse(actorInput ?? { kind: "human", id: "plugin-admin" });
    const stored = await loadStoredPlugin(this.paths, namespace);
    if (!stored) {
      throw new Error(`Plugin not registered: ${namespace}`);
    }

    const manifest = pluginManifestSchema.parse(stored.manifest);
    const currentMeta = pluginMetaSchema.parse(stored.meta);
    const currentState = currentMeta.lifecycleState;
    if (
      !isPluginLifecycleTransitionAllowed(currentState, nextState) ||
      currentState === nextState
    ) {
      throw new Error(
        `Invalid plugin lifecycle transition from ${currentState} to ${nextState} for ${namespace}`,
      );
    }

    const nowIso = new Date().toISOString();
    const nextMeta = applyPluginLifecycleMetaUpdate(currentMeta, nextState, nowIso, disableReason);
    await savePluginToStore(this.paths, manifest, nextMeta);
    this.index.upsertPluginManifest(
      manifest.namespace,
      manifest.schemaVersion,
      nextMeta.registeredAt,
      nextMeta.updatedAt,
      manifest,
    );

    const eventType =
      nextState === "registered"
        ? "plugin.uninstalled"
        : nextState === "enabled"
          ? "plugin.activated"
          : nextState === "disabled"
            ? "plugin.deactivated"
            : "plugin.installed";

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: eventType,
      actor,
      entity: {
        kind: "plugin",
        id: manifest.namespace,
      },
      payload: {
        namespace: manifest.namespace,
        schemaVersion: manifest.schemaVersion,
        previousLifecycleState: currentState,
        lifecycleState: nextMeta.lifecycleState,
        disableReason: nextMeta.disableReason,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      namespace: manifest.namespace,
      state: nextMeta.lifecycleState,
      eventId: event.eventId,
      meta: nextMeta,
    };
  }

  async installPlugin(input: PluginLifecycleActionInput): Promise<PluginLifecycleActionResult> {
    return this.transitionPluginLifecycle(input.namespace, "installed", input.actor);
  }

  async enablePlugin(input: PluginLifecycleActionInput): Promise<PluginLifecycleActionResult> {
    return this.transitionPluginLifecycle(input.namespace, "enabled", input.actor);
  }

  async disablePlugin(input: PluginLifecycleActionInput): Promise<PluginLifecycleActionResult> {
    return this.transitionPluginLifecycle(
      input.namespace,
      "disabled",
      input.actor,
      input.disableReason,
    );
  }

  async uninstallPlugin(input: PluginLifecycleActionInput): Promise<PluginLifecycleActionResult> {
    return this.transitionPluginLifecycle(input.namespace, "registered", input.actor);
  }

  async runPluginScheduler(input: RunPluginSchedulerInput = {}): Promise<RunPluginSchedulerResult> {
    const now = input.now ? new Date(input.now) : new Date();
    if (Number.isNaN(now.valueOf())) {
      throw new Error(`Invalid scheduler now value: ${input.now}`);
    }

    const nowMinuteMs = Math.floor(now.valueOf() / 60_000) * 60_000;
    const schedulerActor = actorSchema.parse(
      input.actor ?? { kind: "agent", id: "scheduler-host" },
    );
    const namespaceFilter = input.namespaces ? new Set(input.namespaces) : null;
    const ledger = await loadSchedulerLedger(this.paths);
    const ledgerEntriesByDedupeKey = new Map<string, PluginSchedulerLedgerEntry>(
      ledger.entries.map((entry) => [entry.dedupeKey, entry]),
    );

    const plugins = (await listStoredPlugins(this.paths))
      .map((plugin) => ({
        manifest: pluginManifestSchema.parse(plugin.manifest),
        meta: pluginMetaSchema.parse(plugin.meta),
      }))
      .filter((plugin) => plugin.meta.lifecycleState === "enabled")
      .filter((plugin) => (namespaceFilter ? namespaceFilter.has(plugin.manifest.namespace) : true))
      .sort((left, right) => left.manifest.namespace.localeCompare(right.manifest.namespace));

    let consideredTasks = 0;
    let skippedAsDuplicate = 0;
    const dueRuns: PluginSchedulerRun[] = [];

    for (const plugin of plugins) {
      const namespace = plugin.manifest.namespace;
      const scheduledTasks = [...(plugin.manifest.scheduledTasks ?? [])].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      consideredTasks += scheduledTasks.length;

      for (const task of scheduledTasks) {
        const timeZone = resolveTaskTimeZone(task.schedule.timezone);
        const dueTaskSlots = collectDueTaskSlots(task, nowMinuteMs, timeZone);
        for (const slot of dueTaskSlots) {
          const dedupeKey = buildSchedulerDedupeKey(namespace, task, slot);
          if (ledgerEntriesByDedupeKey.has(dedupeKey)) {
            skippedAsDuplicate += 1;
            continue;
          }

          dueRuns.push({
            namespace,
            taskId: task.id,
            actionId: task.actionId,
            scheduledFor: slot.scheduledFor,
            slotKey: slot.slotKey,
            timezone: timeZone,
            idempotencyKey: task.idempotencyKey,
            runWindowMinutes: task.runWindowMinutes ?? DEFAULT_SCHEDULER_RUN_WINDOW_MINUTES,
            dedupeKey,
          });
        }
      }
    }

    dueRuns.sort((left, right) => {
      if (left.scheduledFor !== right.scheduledFor) {
        return left.scheduledFor.localeCompare(right.scheduledFor);
      }

      if (left.namespace !== right.namespace) {
        return left.namespace.localeCompare(right.namespace);
      }

      return left.taskId.localeCompare(right.taskId);
    });

    const executeRun = input.executor ?? (async () => {});
    const executedRuns: PluginSchedulerRun[] = [];
    const failedRuns: Array<{ run: PluginSchedulerRun; error: string }> = [];

    for (const run of dueRuns) {
      const startedAt = new Date().toISOString();
      let finishedAt = startedAt;
      let errorMessage: string | undefined;

      try {
        await executeRun(run);
        finishedAt = new Date().toISOString();
        const entry = pluginSchedulerLedgerEntrySchema.parse({
          dedupeKey: run.dedupeKey,
          namespace: run.namespace,
          taskId: run.taskId,
          actionId: run.actionId,
          idempotencyKey: run.idempotencyKey,
          scheduledFor: run.scheduledFor,
          slotKey: run.slotKey,
          timezone: run.timezone,
          executedAt: finishedAt,
        });
        ledgerEntriesByDedupeKey.set(entry.dedupeKey, entry);
        executedRuns.push(run);
      } catch (error) {
        finishedAt = new Date().toISOString();
        errorMessage = error instanceof Error ? error.message : "Scheduler run failed";
        failedRuns.push({ run, error: errorMessage });
      }

      const durationMs = Math.max(
        0,
        new Date(finishedAt).valueOf() - new Date(startedAt).valueOf(),
      );
      const taskEvent = remEventSchema.parse({
        eventId: randomUUID(),
        schemaVersion: CORE_SCHEMA_VERSION,
        timestamp: finishedAt,
        type: "plugin.task_ran",
        actor: schedulerActor,
        entity: {
          kind: "plugin",
          id: run.namespace,
        },
        payload: {
          namespace: run.namespace,
          taskId: run.taskId,
          actionId: run.actionId,
          scheduledFor: run.scheduledFor,
          startedAt,
          finishedAt,
          idempotencyKey: run.idempotencyKey,
          status: errorMessage ? "failure" : "success",
          durationMs,
          errorCode: errorMessage ? "execution_failed" : undefined,
          errorMessage,
        },
      });

      await appendEvent(this.paths, taskEvent);
      this.index.insertEvent(taskEvent);
    }

    if (executedRuns.length > 0) {
      const updatedAt = Array.from(ledgerEntriesByDedupeKey.values()).reduce<string>(
        (latest, entry) => (entry.executedAt > latest ? entry.executedAt : latest),
        ledger.updatedAt,
      );
      await saveSchedulerLedger(
        this.paths,
        pluginSchedulerLedgerSchema.parse({
          schemaVersion: SCHEDULER_LEDGER_SCHEMA_VERSION,
          updatedAt,
          entries: Array.from(ledgerEntriesByDedupeKey.values()).sort((left, right) =>
            left.executedAt.localeCompare(right.executedAt),
          ),
        }),
      );
    }

    return {
      now: now.toISOString(),
      consideredTasks,
      dueRuns: dueRuns.length,
      executedRuns,
      failedRuns,
      skippedAsDuplicate,
      ledgerEntries: ledgerEntriesByDedupeKey.size,
    };
  }

  async getPluginSchedulerStatus(
    input: GetPluginSchedulerStatusInput = {},
  ): Promise<PluginSchedulerStatus> {
    const namespaceFilter = input.namespace?.trim();
    const limit = Math.max(1, Number.isNaN(Number(input.limit)) ? 20 : Number(input.limit));
    const ledger = await loadSchedulerLedger(this.paths);
    const filteredEntries = namespaceFilter
      ? ledger.entries.filter((entry) => entry.namespace === namespaceFilter)
      : ledger.entries;

    const summariesByTask = new Map<string, PluginSchedulerTaskStatus>();
    for (const entry of filteredEntries) {
      const key = `${entry.namespace}:${entry.taskId}`;
      const existing = summariesByTask.get(key);
      if (existing) {
        existing.runs += 1;
        if (entry.scheduledFor > existing.lastScheduledFor) {
          existing.lastScheduledFor = entry.scheduledFor;
        }
        if (entry.executedAt > existing.lastExecutedAt) {
          existing.lastExecutedAt = entry.executedAt;
        }
        continue;
      }

      summariesByTask.set(key, {
        namespace: entry.namespace,
        taskId: entry.taskId,
        actionId: entry.actionId,
        idempotencyKey: entry.idempotencyKey,
        runs: 1,
        lastScheduledFor: entry.scheduledFor,
        lastExecutedAt: entry.executedAt,
      });
    }

    return {
      ledgerEntries: filteredEntries.length,
      updatedAt: filteredEntries.length > 0 ? ledger.updatedAt : null,
      taskSummaries: Array.from(summariesByTask.values()).sort((left, right) => {
        if (left.namespace !== right.namespace) {
          return left.namespace.localeCompare(right.namespace);
        }
        return left.taskId.localeCompare(right.taskId);
      }),
      recentRuns: [...filteredEntries]
        .sort((left, right) => right.executedAt.localeCompare(left.executedAt))
        .slice(0, limit),
    };
  }

  async listPluginTemplates(
    input: ListPluginTemplatesInput = {},
  ): Promise<CorePluginTemplateRecord[]> {
    const namespaceFilter = input.namespace?.trim();
    const stored = await listStoredPlugins(this.paths);
    const records: CorePluginTemplateRecord[] = [];

    for (const plugin of stored.sort((left, right) =>
      left.manifest.namespace.localeCompare(right.manifest.namespace),
    )) {
      const manifest = pluginManifestSchema.parse(plugin.manifest);
      const meta = pluginMetaSchema.parse(plugin.meta);

      if (namespaceFilter && manifest.namespace !== namespaceFilter) {
        continue;
      }

      const available = isPluginTemplateAvailable(meta.lifecycleState);
      if (!input.includeUnavailable && !available) {
        continue;
      }

      for (const template of manifest.templates ?? []) {
        records.push({
          namespace: manifest.namespace,
          lifecycleState: meta.lifecycleState,
          available,
          template,
        });
      }
    }

    return records.sort((left, right) => {
      if (left.namespace !== right.namespace) {
        return left.namespace.localeCompare(right.namespace);
      }

      return left.template.id.localeCompare(right.template.id);
    });
  }

  async applyPluginTemplate(input: ApplyPluginTemplateInput): Promise<ApplyPluginTemplateResult> {
    const namespace = input.namespace.trim();
    const templateId = input.templateId.trim();
    if (!namespace) {
      throw new Error("Plugin namespace is required");
    }
    if (!templateId) {
      throw new Error("Template id is required");
    }

    const actor = actorSchema.parse(input.actor ?? { kind: "human", id: "template-admin" });
    const plugin = await this.getPlugin(namespace);
    if (!plugin) {
      throw new Error(`Plugin not found: ${namespace}`);
    }

    if (!isPluginTemplateAvailable(plugin.meta.lifecycleState)) {
      throw new Error(
        `Plugin ${namespace} templates are unavailable in lifecycle state ${plugin.meta.lifecycleState}`,
      );
    }

    const template = plugin.manifest.templates?.find((entry) => entry.id === templateId);
    if (!template) {
      throw new Error(`Template not found: ${namespace}/${templateId}`);
    }

    const title = input.title?.trim().length ? input.title.trim() : template.title;
    const tags = dedupeNonEmptyStrings([...(template.defaultTags ?? []), ...(input.tags ?? [])]);
    const saved = await this.saveNote({
      title,
      noteType: input.noteType ?? template.defaultNoteType,
      tags,
      lexicalState: lexicalStateSchema.parse(template.lexicalTemplate),
      actor,
    });

    return {
      ...saved,
      namespace,
      templateId,
    };
  }

  async listPlugins(limit = 100): Promise<CorePluginRecord[]> {
    const stored = await listStoredPlugins(this.paths);
    return stored.slice(0, limit).map((plugin) => ({
      manifest: plugin.manifest,
      meta: plugin.meta,
    }));
  }

  async getCanonicalNote(noteId: string): Promise<CoreCanonicalNote | null> {
    const stored = await loadNote(this.paths, noteId);
    if (!stored) {
      return null;
    }

    const meta = noteMetaSchema.parse(stored.meta);
    const note = lexicalStateSchema.parse(stored.note);
    const sectionIndex = stored.sectionIndex
      ? noteSectionIndexSchema.parse(stored.sectionIndex)
      : noteSectionIndexSchema.parse(
          buildSectionIndexFromLexical(noteId, note, {
            schemaVersion: CORE_SCHEMA_VERSION,
          }),
        );

    return {
      noteId,
      lexicalState: note,
      meta,
      sectionIndex,
    };
  }

  async getNote(noteId: string, format: NoteFormat = "lexical"): Promise<CoreFormattedNote | null> {
    const canonical = await this.getCanonicalNote(noteId);
    if (!canonical) {
      return null;
    }

    let content: unknown = canonical.lexicalState;
    if (format === "text") {
      content = extractPlainTextFromLexical(canonical.lexicalState);
    } else if (format === "md") {
      content = extractMarkdownFromLexical(canonical.lexicalState);
    }

    return {
      noteId,
      format,
      content,
      meta: canonical.meta,
    };
  }

  async listSections(noteId: string): Promise<NoteSection[] | null> {
    const indexedSections = this.index.listSections(noteId);
    if (indexedSections.length > 0) {
      return indexedSections;
    }

    const canonical = await this.getCanonicalNote(noteId);
    if (!canonical) {
      return null;
    }

    return canonical.sectionIndex.sections;
  }

  async findSection(input: CoreSectionLookupInput): Promise<NoteSection | null> {
    const sections = await this.listSections(input.noteId);
    if (!sections) {
      return null;
    }

    const exact = sections.find((section) => section.sectionId === input.sectionId);
    if (exact) {
      return exact;
    }

    if (!input.fallbackPath || input.fallbackPath.length === 0) {
      return null;
    }

    const fallbackKey = input.fallbackPath.join("\u001f");
    return sections.find((section) => section.fallbackPath.join("\u001f") === fallbackKey) ?? null;
  }

  async createProposal(input: CreateProposalInput): Promise<CreateProposalResult> {
    const actor = agentActorSchema.parse(input.actor);
    const target = sectionTargetSchema.parse(input.target);
    const proposalType = proposalTypeSchema.parse(input.proposalType);
    const nowIso = new Date().toISOString();

    const targetNote = await this.getCanonicalNote(target.noteId);
    if (!targetNote) {
      throw new Error(`Target note not found: ${target.noteId}`);
    }

    const targetSection = await this.findSection({
      noteId: target.noteId,
      sectionId: target.sectionId,
      fallbackPath: target.fallbackPath,
    });

    if (!targetSection) {
      throw new Error(`Target section not found: ${target.sectionId}`);
    }

    const proposalId = input.id ?? randomUUID();

    const proposal = proposalSchema.parse({
      id: proposalId,
      schemaVersion: CORE_SCHEMA_VERSION,
      status: "open",
      createdAt: nowIso,
      updatedAt: nowIso,
      actor,
      target,
      proposalType,
      contentRef: "content.json",
      rationale: input.rationale,
      confidence: input.confidence,
      source: input.source,
    });

    const content = proposalContentSchema.parse({
      schemaVersion: input.content.schemaVersion ?? CORE_SCHEMA_VERSION,
      format: input.content.format,
      content: input.content.content,
    });

    const meta = proposalMetaSchema.parse({
      id: proposalId,
      schemaVersion: CORE_SCHEMA_VERSION,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: actor,
      source: input.source,
    });

    await saveProposal(this.paths, proposal, content, meta);
    this.index.upsertProposal(proposal);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "proposal.created",
      actor,
      entity: {
        kind: "proposal",
        id: proposalId,
      },
      payload: {
        proposalId,
        noteId: proposal.target.noteId,
        sectionId: proposal.target.sectionId,
        proposalType: proposal.proposalType,
        status: proposal.status,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      proposalId,
      eventId: event.eventId,
      record: {
        proposal,
        content,
        meta,
      },
    };
  }

  async listProposals(input?: ListProposalsInput): Promise<CoreProposalRecord[]> {
    const statusFilter = input?.status ? proposalStatusSchema.parse(input.status) : undefined;
    const indexed = this.index.listProposals(statusFilter);
    const records = await Promise.all(indexed.map(async (item) => this.getProposal(item.id)));
    return records.filter((item): item is CoreProposalRecord => item !== null);
  }

  async getProposal(proposalId: string): Promise<CoreProposalRecord | null> {
    const loaded = await loadProposal(this.paths, proposalId);
    if (!loaded) {
      return null;
    }

    return {
      proposal: loaded.proposal,
      content: loaded.content,
      meta: loaded.meta,
    };
  }

  async acceptProposal(input: ProposalActionInput): Promise<ProposalActionResult | null> {
    const actor = humanActorSchema.parse(input.actor ?? { kind: "human" });
    const record = await this.getProposal(input.proposalId);
    if (!record) {
      return null;
    }

    if (record.proposal.status !== "open") {
      throw new Error(`Cannot accept proposal in status ${record.proposal.status}`);
    }

    const targetNote = await this.getCanonicalNote(record.proposal.target.noteId);
    if (!targetNote) {
      throw new Error(`Target note not found: ${record.proposal.target.noteId}`);
    }

    const targetSection = await this.findSection({
      noteId: record.proposal.target.noteId,
      sectionId: record.proposal.target.sectionId,
      fallbackPath: record.proposal.target.fallbackPath,
    });

    if (!targetSection) {
      throw new Error(`Target section not found: ${record.proposal.target.sectionId}`);
    }

    const nowIso = new Date().toISOString();
    let nextLexicalState = lexicalStateSchema.parse(targetNote.lexicalState);
    let nextMeta = noteMetaSchema.parse({
      ...targetNote.meta,
      updatedAt: nowIso,
      author: actor,
    });

    let applyDetails: Record<string, unknown>;

    if (record.proposal.proposalType === "replace_section") {
      const replacementNodes = proposalContentToReplacementNodes(record.content);
      nextLexicalState = lexicalStateSchema.parse(
        replaceSectionInLexicalState(targetNote.lexicalState, targetSection, replacementNodes),
      );
      applyDetails = {
        applyMode: "replace_section",
        replacementNodeCount: replacementNodes.length,
      };
    } else if (record.proposal.proposalType === "annotate") {
      const annotationOps = proposalContentToAnnotationOperations(record.content);
      if (annotationOps.annotationNodes.length > 0) {
        nextLexicalState = lexicalStateSchema.parse(
          appendToSectionInLexicalState(
            targetNote.lexicalState,
            targetSection,
            annotationOps.annotationNodes,
          ),
        );
      }

      const removedTagSet = new Set(annotationOps.tagsToRemove);
      const mergedTags = dedupeNonEmptyStrings([
        ...targetNote.meta.tags.filter((tag) => !removedTagSet.has(tag)),
        ...annotationOps.tagsToAdd,
      ]);

      nextMeta = noteMetaSchema.parse({
        ...targetNote.meta,
        updatedAt: nowIso,
        author: actor,
        title: annotationOps.titleOverride ?? targetNote.meta.title,
        tags: mergedTags,
      });

      applyDetails = {
        applyMode: "annotate",
        annotationNodeCount: annotationOps.annotationNodes.length,
        tagsAdded: annotationOps.tagsToAdd,
        tagsRemoved: annotationOps.tagsToRemove,
        titleUpdated:
          annotationOps.titleOverride !== undefined &&
          annotationOps.titleOverride !== targetNote.meta.title,
      };
    } else {
      throw new Error(`Unsupported proposal type for accept: ${record.proposal.proposalType}`);
    }

    const nextSectionIndex = noteSectionIndexSchema.parse(
      buildSectionIndexFromLexical(targetNote.noteId, nextLexicalState, {
        schemaVersion: CORE_SCHEMA_VERSION,
        existingSectionIndex: targetNote.sectionIndex,
        existingLexicalState: targetNote.lexicalState,
      }),
    );

    await saveNote(this.paths, targetNote.noteId, nextLexicalState, nextMeta, nextSectionIndex);
    this.index.upsertNote(nextMeta, extractPlainTextFromLexical(nextLexicalState));
    this.index.upsertSections(targetNote.noteId, nextSectionIndex.sections);

    const nextProposal = await updateProposalStatus(
      this.paths,
      input.proposalId,
      "accepted",
      nowIso,
    );
    if (!nextProposal) {
      throw new Error(`Proposal not found during accept transition: ${input.proposalId}`);
    }
    this.index.upsertProposal(nextProposal.proposal);

    const acceptedEvent = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "proposal.accepted",
      actor,
      entity: {
        kind: "proposal",
        id: input.proposalId,
      },
      payload: {
        proposalId: input.proposalId,
        noteId: targetNote.noteId,
        sectionId: nextProposal.proposal.target.sectionId,
        proposalType: nextProposal.proposal.proposalType,
        status: nextProposal.proposal.status,
        ...applyDetails,
      },
    });

    const noteUpdatedEvent = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "note.updated",
      actor,
      entity: {
        kind: "note",
        id: targetNote.noteId,
      },
      payload: {
        noteId: targetNote.noteId,
        title: nextMeta.title,
        tags: nextMeta.tags,
        sourceProposalId: input.proposalId,
        sourceProposalType: nextProposal.proposal.proposalType,
        ...applyDetails,
      },
    });

    await appendEvent(this.paths, acceptedEvent);
    await appendEvent(this.paths, noteUpdatedEvent);
    this.index.insertEvent(acceptedEvent);
    this.index.insertEvent(noteUpdatedEvent);

    return {
      proposalId: input.proposalId,
      noteId: targetNote.noteId,
      status: "accepted",
      eventId: acceptedEvent.eventId,
      noteEventId: noteUpdatedEvent.eventId,
    };
  }

  async rejectProposal(input: ProposalActionInput): Promise<ProposalActionResult | null> {
    const actor = humanActorSchema.parse(input.actor ?? { kind: "human" });
    const record = await this.getProposal(input.proposalId);
    if (!record) {
      return null;
    }

    if (record.proposal.status !== "open") {
      throw new Error(`Cannot reject proposal in status ${record.proposal.status}`);
    }

    const nowIso = new Date().toISOString();
    const nextProposal = await updateProposalStatus(
      this.paths,
      input.proposalId,
      "rejected",
      nowIso,
    );

    if (!nextProposal) {
      throw new Error(`Proposal not found during reject transition: ${input.proposalId}`);
    }
    this.index.upsertProposal(nextProposal.proposal);

    const event = remEventSchema.parse({
      eventId: randomUUID(),
      schemaVersion: CORE_SCHEMA_VERSION,
      timestamp: nowIso,
      type: "proposal.rejected",
      actor,
      entity: {
        kind: "proposal",
        id: input.proposalId,
      },
      payload: {
        proposalId: input.proposalId,
        noteId: nextProposal.proposal.target.noteId,
        sectionId: nextProposal.proposal.target.sectionId,
        proposalType: nextProposal.proposal.proposalType,
        status: nextProposal.proposal.status,
      },
    });

    await appendEvent(this.paths, event);
    this.index.insertEvent(event);

    return {
      proposalId: input.proposalId,
      noteId: nextProposal.proposal.target.noteId,
      status: "rejected",
      eventId: event.eventId,
    };
  }

  async migrateSectionIdentity(): Promise<MigrateSectionIdentityResult> {
    const noteIds = await listNoteIds(this.paths);
    const migratedNoteIds: string[] = [];
    let migrated = 0;
    let skipped = 0;
    let events = 0;

    for (const noteId of noteIds) {
      const stored = await loadNote(this.paths, noteId);
      if (!stored) {
        skipped += 1;
        continue;
      }

      const note = lexicalStateSchema.parse(stored.note);
      const currentMeta = noteMetaSchema.parse(stored.meta);

      const currentSectionIndex = stored.sectionIndex
        ? noteSectionIndexSchema.parse(stored.sectionIndex)
        : noteSectionIndexSchema.parse(
            buildSectionIndexFromLexical(noteId, note, {
              schemaVersion: CORE_SCHEMA_VERSION,
            }),
          );

      const nextSectionIndex = noteSectionIndexSchema.parse(
        buildSectionIndexFromLexical(noteId, note, {
          schemaVersion: CORE_SCHEMA_VERSION,
          existingSectionIndex: currentSectionIndex,
          existingLexicalState: note,
        }),
      );

      const hasEquivalentSections = areSectionIndexesEquivalent(
        currentSectionIndex,
        nextSectionIndex,
      );
      const alreadyMigrated = currentMeta.sectionIndexVersion === SECTION_INDEX_VERSION;
      if (alreadyMigrated && hasEquivalentSections) {
        skipped += 1;
        continue;
      }

      const nowIso = new Date().toISOString();
      const nextMeta = noteMetaSchema.parse({
        ...currentMeta,
        updatedAt: nowIso,
        sectionIndexVersion: SECTION_INDEX_VERSION,
      });

      await saveNote(this.paths, noteId, note, nextMeta, nextSectionIndex);
      this.index.upsertNote(nextMeta, extractPlainTextFromLexical(note));
      this.index.upsertSections(noteId, nextSectionIndex.sections);

      const migrationEvent = remEventSchema.parse({
        eventId: randomUUID(),
        schemaVersion: CORE_SCHEMA_VERSION,
        timestamp: nowIso,
        type: "schema.migration_run",
        actor: {
          kind: "human",
          id: "core-migrator",
        },
        entity: {
          kind: "note",
          id: noteId,
        },
        payload: {
          noteId,
          migration: SECTION_IDENTITY_MIGRATION,
          previousSectionIndexVersion: currentMeta.sectionIndexVersion,
          nextSectionIndexVersion: nextMeta.sectionIndexVersion,
          sectionsBefore: currentSectionIndex.sections.length,
          sectionsAfter: nextSectionIndex.sections.length,
        },
      });

      await appendEvent(this.paths, migrationEvent);
      this.index.insertEvent(migrationEvent);

      migrated += 1;
      events += 1;
      migratedNoteIds.push(noteId);
    }

    return {
      migration: SECTION_IDENTITY_MIGRATION,
      scanned: noteIds.length,
      migrated,
      skipped,
      events,
      noteIds: migratedNoteIds,
    };
  }

  async rebuildIndex(): Promise<CoreStatus> {
    this.index.close();
    await resetIndexDatabase(this.paths.dbPath);
    this.index = new RemIndex(this.paths.dbPath);

    const noteIds = await listNoteIds(this.paths);
    for (const noteId of noteIds) {
      const stored = await loadNote(this.paths, noteId);
      if (!stored) {
        continue;
      }

      const meta = noteMetaSchema.parse(stored.meta);
      const note = lexicalStateSchema.parse(stored.note);
      const sectionIndex = stored.sectionIndex
        ? noteSectionIndexSchema.parse(stored.sectionIndex)
        : noteSectionIndexSchema.parse(
            buildSectionIndexFromLexical(noteId, note, {
              schemaVersion: CORE_SCHEMA_VERSION,
            }),
          );
      await saveNote(this.paths, noteId, note, meta, sectionIndex);
      const extracted = extractPlainTextFromLexical(note);
      this.index.upsertNote(meta, extracted);
      this.index.upsertSections(noteId, sectionIndex.sections);
    }

    const proposalIds = await listProposalIds(this.paths);
    for (const proposalId of proposalIds) {
      const proposal = await loadProposal(this.paths, proposalId);
      if (!proposal) {
        continue;
      }
      this.index.upsertProposal(proposal.proposal);
    }

    const plugins = await listStoredPlugins(this.paths);
    for (const plugin of plugins) {
      const manifest = pluginManifestSchema.parse(plugin.manifest);
      const meta = pluginMetaSchema.parse(plugin.meta);
      this.index.upsertPluginManifest(
        manifest.namespace,
        manifest.schemaVersion,
        meta.registeredAt,
        meta.updatedAt,
        manifest,
      );
    }

    for (const plugin of plugins) {
      const manifest = pluginManifestSchema.parse(plugin.manifest);
      for (const entityTypeDefinition of manifest.entityTypes ?? []) {
        const entities = await listStoredPluginEntities(
          this.paths,
          manifest.namespace,
          entityTypeDefinition.id,
        );
        for (const entry of entities) {
          this.index.upsertEntity(
            entry.entity,
            entry.meta,
            entityTypeDefinition.indexes?.textFields,
          );
        }
      }
    }

    const eventFiles = await listEventFiles(this.paths);
    for (const eventFile of eventFiles) {
      const events = await readEventsFromFile(eventFile);
      for (const event of events) {
        const parsed = remEventSchema.parse(event);
        this.index.insertEvent(parsed);
      }
    }

    return this.status();
  }
}

export const coreVersion = "0.1.0";

let defaultCorePromise: Promise<RemCore> | undefined;
let recoveryCorePromise: Promise<RemCore> | undefined;

async function getDefaultCore(): Promise<RemCore> {
  defaultCorePromise ??= RemCore.create();
  return defaultCorePromise;
}

function isRecoverableStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("disk i/o error");
}

async function recoverDefaultCore(): Promise<RemCore> {
  recoveryCorePromise ??= (async () => {
    const previousPromise = defaultCorePromise;
    defaultCorePromise = undefined;

    if (previousPromise) {
      try {
        const previousCore = await previousPromise;
        await previousCore.close();
      } catch {
        // Ignore close/retrieval failures while recovering the core singleton.
      }
    }

    return getDefaultCore();
  })();

  try {
    return await recoveryCorePromise;
  } finally {
    recoveryCorePromise = undefined;
  }
}

async function withCoreRecovery<T>(operation: (core: RemCore) => Promise<T>): Promise<T> {
  const core = await getDefaultCore();

  try {
    return await operation(core);
  } catch (error) {
    if (!isRecoverableStorageError(error)) {
      throw error;
    }

    const recoveredCore = await recoverDefaultCore();
    return operation(recoveredCore);
  }
}

export async function getCoreStatus(): Promise<CoreStatus> {
  return withCoreRecovery((core) => core.status());
}

export async function getCoreStoreRootConfigViaCore(): Promise<CoreStoreRootConfig> {
  const configured = await loadStoredCoreConfig();
  const effective = await resolveStoreRoot();

  return {
    schemaVersion: CORE_CONFIG_SCHEMA_VERSION,
    storeRoot: effective.storeRoot,
    configPath: resolveConfigPath(),
    defaultStoreRoot: DEFAULT_STORE_ROOT,
    configuredStoreRoot: configured?.storeRoot ?? null,
    effectiveStoreRoot: effective.storeRoot,
    source: effective.source,
  };
}

export async function setCoreStoreRootConfigViaCore(
  storeRoot?: string,
): Promise<CoreStoreRootConfig> {
  const normalizedStoreRoot = normalizePathInput(storeRoot);

  if (normalizedStoreRoot) {
    await persistCoreConfig(normalizedStoreRoot);
    runtimeStoreRootOverride = normalizedStoreRoot;
    process.env.REM_STORE_ROOT = normalizedStoreRoot;
  } else {
    await clearStoredCoreConfig();
    runtimeStoreRootOverride = null;
    process.env.REM_STORE_ROOT = undefined;
  }

  await recoverDefaultCore();
  return getCoreStoreRootConfigViaCore();
}

export async function saveNoteViaCore(input: SaveNoteInput): Promise<SaveNoteResult> {
  return withCoreRecovery((core) => core.saveNote(input));
}

export async function getCanonicalNoteViaCore(noteId: string): Promise<CoreCanonicalNote | null> {
  return withCoreRecovery((core) => core.getCanonicalNote(noteId));
}

export async function getNoteViaCore(
  noteId: string,
  format: NoteFormat = "lexical",
): Promise<CoreFormattedNote | null> {
  return withCoreRecovery((core) => core.getNote(noteId, format));
}

export async function listSectionsViaCore(noteId: string): Promise<NoteSection[] | null> {
  return withCoreRecovery((core) => core.listSections(noteId));
}

export async function findSectionViaCore(
  input: CoreSectionLookupInput,
): Promise<NoteSection | null> {
  return withCoreRecovery((core) => core.findSection(input));
}

export async function createProposalViaCore(
  input: CreateProposalInput,
): Promise<CreateProposalResult> {
  return withCoreRecovery((core) => core.createProposal(input));
}

export async function listProposalsViaCore(
  input?: ListProposalsInput,
): Promise<CoreProposalRecord[]> {
  return withCoreRecovery((core) => core.listProposals(input));
}

export async function getProposalViaCore(proposalId: string): Promise<CoreProposalRecord | null> {
  return withCoreRecovery((core) => core.getProposal(proposalId));
}

export async function acceptProposalViaCore(
  input: ProposalActionInput,
): Promise<ProposalActionResult | null> {
  return withCoreRecovery((core) => core.acceptProposal(input));
}

export async function rejectProposalViaCore(
  input: ProposalActionInput,
): Promise<ProposalActionResult | null> {
  return withCoreRecovery((core) => core.rejectProposal(input));
}

export async function searchNotesViaCore(
  query: string,
  input?: SearchNotesInput | number,
): Promise<CoreSearchResult[]> {
  return withCoreRecovery((core) => core.searchNotes(query, input));
}

export async function listEventsViaCore(input?: ListEventsInput): Promise<CoreEventRecord[]> {
  return withCoreRecovery((core) => core.listEvents(input));
}

export async function recordPluginActionEventViaCore(
  input: RecordPluginActionEventInput,
): Promise<RecordPluginActionEventResult> {
  return withCoreRecovery((core) => core.recordPluginActionEvent(input));
}

export async function registerPluginViaCore(
  input: RegisterPluginInput,
): Promise<RegisterPluginResult> {
  return withCoreRecovery((core) => core.registerPlugin(input));
}

export async function getPluginViaCore(namespace: string): Promise<CorePluginRecord | null> {
  return withCoreRecovery((core) => core.getPlugin(namespace));
}

export async function createPluginEntityViaCore(
  input: CreatePluginEntityInput,
): Promise<CorePluginEntityRecord> {
  return withCoreRecovery((core) => core.createPluginEntity(input));
}

export async function updatePluginEntityViaCore(
  input: UpdatePluginEntityInput,
): Promise<CorePluginEntityRecord> {
  return withCoreRecovery((core) => core.updatePluginEntity(input));
}

export async function getPluginEntityViaCore(
  input: GetPluginEntityInput,
): Promise<CorePluginEntityRecord | null> {
  return withCoreRecovery((core) => core.getPluginEntity(input));
}

export async function listPluginEntitiesViaCore(
  input: ListPluginEntitiesInput,
): Promise<CorePluginEntityRecord[]> {
  return withCoreRecovery((core) => core.listPluginEntities(input));
}

export async function installPluginViaCore(
  input: PluginLifecycleActionInput,
): Promise<PluginLifecycleActionResult> {
  return withCoreRecovery((core) => core.installPlugin(input));
}

export async function enablePluginViaCore(
  input: PluginLifecycleActionInput,
): Promise<PluginLifecycleActionResult> {
  return withCoreRecovery((core) => core.enablePlugin(input));
}

export async function disablePluginViaCore(
  input: PluginLifecycleActionInput,
): Promise<PluginLifecycleActionResult> {
  return withCoreRecovery((core) => core.disablePlugin(input));
}

export async function uninstallPluginViaCore(
  input: PluginLifecycleActionInput,
): Promise<PluginLifecycleActionResult> {
  return withCoreRecovery((core) => core.uninstallPlugin(input));
}

export async function runPluginSchedulerViaCore(
  input?: Omit<RunPluginSchedulerInput, "executor">,
): Promise<RunPluginSchedulerResult> {
  return withCoreRecovery((core) => core.runPluginScheduler(input));
}

export async function getPluginSchedulerStatusViaCore(
  input?: GetPluginSchedulerStatusInput,
): Promise<PluginSchedulerStatus> {
  return withCoreRecovery((core) => core.getPluginSchedulerStatus(input));
}

export async function listPluginTemplatesViaCore(
  input?: ListPluginTemplatesInput,
): Promise<CorePluginTemplateRecord[]> {
  return withCoreRecovery((core) => core.listPluginTemplates(input));
}

export async function applyPluginTemplateViaCore(
  input: ApplyPluginTemplateInput,
): Promise<ApplyPluginTemplateResult> {
  return withCoreRecovery((core) => core.applyPluginTemplate(input));
}

export async function listPluginsViaCore(limit = 100): Promise<CorePluginRecord[]> {
  return withCoreRecovery((core) => core.listPlugins(limit));
}

export async function migrateSectionIdentityViaCore(): Promise<MigrateSectionIdentityResult> {
  return withCoreRecovery((core) => core.migrateSectionIdentity());
}

export async function rebuildIndexViaCore(): Promise<CoreStatus> {
  return withCoreRecovery((core) => core.rebuildIndex());
}
