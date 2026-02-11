import { z } from "zod";

export const schemaVersion = z.string().min(1);

export const configSchema = z.object({
  storeRoot: z.string().min(1),
  schemaVersion,
});

export type RemConfig = z.infer<typeof configSchema>;

export const actorKindSchema = z.enum(["human", "agent"]);

export const actorSchema = z
  .object({
    kind: actorKindSchema,
    id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "agent" && !value.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent actors must include an id",
      });
    }
  });

export const humanActorSchema = z.object({
  kind: z.literal("human"),
  id: z.string().min(1).optional(),
});

export const agentActorSchema = z.object({
  kind: z.literal("agent"),
  id: z.string().min(1),
});

export type LexicalNode = {
  type: string;
  version?: number;
  text?: string;
  children?: LexicalNode[];
  [key: string]: unknown;
};

export const lexicalNodeSchema: z.ZodType<LexicalNode> = z.lazy(() =>
  z
    .object({
      type: z.string().min(1),
      version: z.number().int().nonnegative().optional(),
      text: z.string().optional(),
      children: z.array(lexicalNodeSchema).optional(),
    })
    .passthrough(),
);

export const lexicalStateSchema = z
  .object({
    root: lexicalNodeSchema,
  })
  .passthrough();

export const noteMetaSchema = z.object({
  id: z.string().min(1),
  schemaVersion,
  title: z.string(),
  noteType: z.string().min(1).default("note"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  author: actorSchema,
  tags: z.array(z.string()),
  plugins: z.record(z.string(), z.unknown()).default({}),
  sectionIndexVersion: z.string().min(1).default("v1"),
});

export const proposalStatusSchema = z.enum(["open", "accepted", "rejected", "superseded"]);

export const proposalTypeSchema = z.enum(["replace_section", "annotate"]);

export const sectionTargetSchema = z.object({
  noteId: z.string().min(1),
  sectionId: z.string().min(1),
  fallbackPath: z.array(z.string().min(1)).optional(),
});

export const noteSectionSchema = z.object({
  sectionId: z.string().min(1),
  noteId: z.string().min(1),
  headingText: z.string().min(1),
  headingLevel: z.number().int().min(1).max(6),
  fallbackPath: z.array(z.string().min(1)),
  startNodeIndex: z.number().int().nonnegative(),
  endNodeIndex: z.number().int().nonnegative(),
  position: z.number().int().nonnegative(),
});

export const noteSectionIndexSchema = z.object({
  noteId: z.string().min(1),
  schemaVersion,
  generatedAt: z.string().datetime(),
  sections: z.array(noteSectionSchema),
});

export const proposalContentSchema = z
  .object({
    schemaVersion,
    format: z.enum(["lexical", "text", "json"]),
    content: z.unknown(),
  })
  .superRefine((value, ctx) => {
    if (value.format === "text" && typeof value.content !== "string") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Text proposal content must be a string",
        path: ["content"],
      });
    }

    if (value.format === "lexical" && !lexicalStateSchema.safeParse(value.content).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Lexical proposal content must match lexicalStateSchema",
        path: ["content"],
      });
    }

    if (
      value.format === "json" &&
      (value.content === null || typeof value.content !== "object" || Array.isArray(value.content))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JSON proposal content must be an object",
        path: ["content"],
      });
    }
  });

export const proposalMetaSchema = z.object({
  id: z.string().min(1),
  schemaVersion,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: actorSchema,
  source: z.string().min(1).optional(),
});

export const proposalSchema = z.object({
  id: z.string().min(1),
  schemaVersion,
  status: proposalStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  actor: agentActorSchema,
  target: sectionTargetSchema,
  proposalType: proposalTypeSchema,
  contentRef: z.string().min(1).default("content.json"),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.string().min(1).optional(),
});

export const pluginNamespaceSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const pluginFieldTypeSchema = z.enum(["string", "number", "boolean", "object", "array"]);

export const pluginFieldSchema = z.object({
  type: pluginFieldTypeSchema,
  items: z
    .object({
      type: pluginFieldTypeSchema,
    })
    .optional(),
});

export const pluginPayloadSchemaSchema = z.object({
  type: z.literal("object"),
  required: z.array(z.string().min(1)).default([]),
  properties: z.record(z.string().min(1), pluginFieldSchema).default({}),
  additionalProperties: z.boolean().default(true),
});

export const pluginManifestV1Schema = z.object({
  namespace: pluginNamespaceSchema,
  schemaVersion,
  payloadSchema: pluginPayloadSchemaSchema,
});

export const pluginManifestVersionSchema = z.literal("v2");

export const pluginCapabilitySchema = z.enum([
  "templates",
  "scheduled_tasks",
  "entities",
  "cli_actions",
  "ui_panels",
]);

export const pluginPermissionSchema = z.enum([
  "notes.read",
  "notes.write",
  "search.read",
  "events.read",
  "proposals.create",
  "proposals.review",
  "entities.read",
  "entities.write",
]);

export const pluginTaskScheduleWeekdaySchema = z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

export const pluginTaskScheduleSchema = z
  .object({
    kind: z.enum(["daily", "weekly", "hourly"]),
    hour: z.number().int().min(0).max(23).optional(),
    minute: z.number().int().min(0).max(59).optional(),
    weekday: pluginTaskScheduleWeekdaySchema.optional(),
    timezone: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "weekly" && !value.weekday) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Weekly schedules must include weekday",
        path: ["weekday"],
      });
    }

    if (value.kind === "hourly" && value.weekday) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Hourly schedules cannot include weekday",
        path: ["weekday"],
      });
    }
  });

export const pluginTemplateDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  defaultNoteType: z.string().min(1).optional(),
  defaultTags: z.array(z.string().min(1)).optional(),
  lexicalTemplate: z.unknown(),
});

export const pluginScheduledTaskDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  schedule: pluginTaskScheduleSchema,
  actionId: z.string().min(1),
  idempotencyKey: z.enum(["calendar_slot", "action_input_hash"]),
  runWindowMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
  maxRuntimeSeconds: z.number().int().min(1).optional(),
});

export const pluginEntityTypeDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  schema: pluginPayloadSchemaSchema,
  indexes: z
    .object({
      textFields: z.array(z.string().min(1)).optional(),
      facetFields: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

export const pluginCliActionDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  requiredPermissions: z.array(pluginPermissionSchema).optional(),
});

export const pluginUiPanelDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  slot: z.enum(["note.sidebar", "note.toolbar", "proposal.review"]),
  requiredPermissions: z.array(pluginPermissionSchema).optional(),
});

export const pluginLifecycleSchema = z.object({
  defaultEnabled: z.boolean().optional(),
  updatePolicy: z.enum(["manual", "auto_minor"]).optional(),
});

export const pluginCliManifestSchema = z.object({
  actions: z.array(pluginCliActionDefinitionSchema).min(1),
  entrypoint: z.string().min(1).optional(),
});

export const pluginUiManifestSchema = z.object({
  panels: z.array(pluginUiPanelDefinitionSchema).min(1),
  entrypoint: z.string().min(1).optional(),
});

export const pluginManifestV2Schema = z
  .object({
    manifestVersion: pluginManifestVersionSchema,
    namespace: pluginNamespaceSchema,
    schemaVersion,
    remVersionRange: z.string().min(1),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    capabilities: z.array(pluginCapabilitySchema).default([]),
    permissions: z.array(pluginPermissionSchema).default([]),
    payloadSchema: pluginPayloadSchemaSchema.optional(),
    notePayloadSchema: pluginPayloadSchemaSchema.optional(),
    templates: z.array(pluginTemplateDefinitionSchema).optional(),
    scheduledTasks: z.array(pluginScheduledTaskDefinitionSchema).optional(),
    entityTypes: z.array(pluginEntityTypeDefinitionSchema).optional(),
    cli: pluginCliManifestSchema.optional(),
    ui: pluginUiManifestSchema.optional(),
    lifecycle: pluginLifecycleSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const capabilities = new Set(value.capabilities);
    const hasTemplates = (value.templates?.length ?? 0) > 0;
    const hasScheduledTasks = (value.scheduledTasks?.length ?? 0) > 0;
    const hasEntityTypes = (value.entityTypes?.length ?? 0) > 0;
    const hasCliActions = (value.cli?.actions.length ?? 0) > 0;
    const hasUiPanels = (value.ui?.panels.length ?? 0) > 0;

    if (capabilities.has("templates") && !hasTemplates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability templates requires templates definitions",
        path: ["templates"],
      });
    }
    if (!capabilities.has("templates") && hasTemplates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "templates definitions require templates capability",
        path: ["capabilities"],
      });
    }

    if (capabilities.has("scheduled_tasks") && !hasScheduledTasks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability scheduled_tasks requires scheduledTasks definitions",
        path: ["scheduledTasks"],
      });
    }
    if (!capabilities.has("scheduled_tasks") && hasScheduledTasks) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scheduledTasks definitions require scheduled_tasks capability",
        path: ["capabilities"],
      });
    }

    if (capabilities.has("entities") && !hasEntityTypes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability entities requires entityTypes definitions",
        path: ["entityTypes"],
      });
    }
    if (!capabilities.has("entities") && hasEntityTypes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entityTypes definitions require entities capability",
        path: ["capabilities"],
      });
    }

    if (capabilities.has("cli_actions") && !hasCliActions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability cli_actions requires cli.actions definitions",
        path: ["cli"],
      });
    }
    if (!capabilities.has("cli_actions") && hasCliActions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cli.actions definitions require cli_actions capability",
        path: ["capabilities"],
      });
    }

    if (capabilities.has("ui_panels") && !hasUiPanels) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Capability ui_panels requires ui.panels definitions",
        path: ["ui"],
      });
    }
    if (!capabilities.has("ui_panels") && hasUiPanels) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ui.panels definitions require ui_panels capability",
        path: ["capabilities"],
      });
    }

    const actionIds = new Set(value.cli?.actions.map((action) => action.id) ?? []);
    for (const [index, task] of (value.scheduledTasks ?? []).entries()) {
      if (!actionIds.has(task.actionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scheduledTasks[${index}] actionId must reference a cli action id`,
          path: ["scheduledTasks", index, "actionId"],
        });
      }
    }

    const declaredPermissions = new Set(value.permissions);
    for (const [actionIndex, action] of (value.cli?.actions ?? []).entries()) {
      for (const [permissionIndex, permission] of (action.requiredPermissions ?? []).entries()) {
        if (!declaredPermissions.has(permission)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `cli action requiredPermission ${permission} must be declared in manifest permissions`,
            path: ["cli", "actions", actionIndex, "requiredPermissions", permissionIndex],
          });
        }
      }
    }
    for (const [panelIndex, panel] of (value.ui?.panels ?? []).entries()) {
      for (const [permissionIndex, permission] of (panel.requiredPermissions ?? []).entries()) {
        if (!declaredPermissions.has(permission)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `ui panel requiredPermission ${permission} must be declared in manifest permissions`,
            path: ["ui", "panels", panelIndex, "requiredPermissions", permissionIndex],
          });
        }
      }
    }
  });

const pluginManifestNormalizedSchema = z.object({
  namespace: pluginNamespaceSchema,
  schemaVersion,
  payloadSchema: pluginPayloadSchemaSchema,
  manifestVersion: pluginManifestVersionSchema.optional(),
  remVersionRange: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  capabilities: z.array(pluginCapabilitySchema).optional(),
  permissions: z.array(pluginPermissionSchema).optional(),
  notePayloadSchema: pluginPayloadSchemaSchema.optional(),
  templates: z.array(pluginTemplateDefinitionSchema).optional(),
  scheduledTasks: z.array(pluginScheduledTaskDefinitionSchema).optional(),
  entityTypes: z.array(pluginEntityTypeDefinitionSchema).optional(),
  cli: pluginCliManifestSchema.optional(),
  ui: pluginUiManifestSchema.optional(),
  lifecycle: pluginLifecycleSchema.optional(),
});

export const pluginManifestInputSchema = z.union([pluginManifestV2Schema, pluginManifestV1Schema]);

const defaultPluginPayloadSchema = pluginPayloadSchemaSchema.parse({
  type: "object",
  required: [],
  properties: {},
  additionalProperties: true,
});

export const pluginManifestSchema = pluginManifestInputSchema
  .transform((manifest) => {
    if ("manifestVersion" in manifest && manifest.manifestVersion === "v2") {
      const notePayloadSchema = manifest.notePayloadSchema ?? manifest.payloadSchema;
      const payloadSchema = notePayloadSchema ?? defaultPluginPayloadSchema;

      return {
        namespace: manifest.namespace,
        schemaVersion: manifest.schemaVersion,
        payloadSchema,
        manifestVersion: "v2" as const,
        remVersionRange: manifest.remVersionRange,
        displayName: manifest.displayName,
        description: manifest.description,
        capabilities: manifest.capabilities,
        permissions: manifest.permissions,
        notePayloadSchema,
        templates: manifest.templates,
        scheduledTasks: manifest.scheduledTasks,
        entityTypes: manifest.entityTypes,
        cli: manifest.cli,
        ui: manifest.ui,
        lifecycle: manifest.lifecycle,
      };
    }

    return {
      namespace: manifest.namespace,
      schemaVersion: manifest.schemaVersion,
      payloadSchema: manifest.payloadSchema,
      capabilities: [],
      permissions: [],
    };
  })
  .pipe(pluginManifestNormalizedSchema);

export const pluginLifecycleStateSchema = z.enum([
  "registered",
  "installed",
  "enabled",
  "disabled",
]);

export const pluginMetaSchema = z.object({
  namespace: pluginNamespaceSchema,
  schemaVersion,
  registeredAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  registrationKind: z.enum(["static", "dynamic"]).default("dynamic"),
  lifecycleState: pluginLifecycleStateSchema.default("registered"),
  disableReason: z.string().min(1).optional(),
  installedAt: z.string().datetime().optional(),
  enabledAt: z.string().datetime().optional(),
  disabledAt: z.string().datetime().optional(),
});

export const pluginEntityTypeIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._-]+$/, "Entity type must use [a-zA-Z0-9._-] characters");

export const pluginEntityIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._-]+$/, "Entity id must use [a-zA-Z0-9._-] characters");

export const pluginEntityRecordSchema = z.object({
  id: pluginEntityIdSchema,
  namespace: pluginNamespaceSchema,
  entityType: pluginEntityTypeIdSchema,
  schemaVersion,
  data: z.record(z.string(), z.unknown()),
});

export const pluginEntityLinkSchema = z.union([
  z.object({
    kind: z.literal("note"),
    noteId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("entity"),
    namespace: pluginNamespaceSchema,
    entityType: pluginEntityTypeIdSchema,
    entityId: pluginEntityIdSchema,
  }),
]);

export const pluginEntityMetaSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  actor: actorSchema,
  links: z.array(pluginEntityLinkSchema).optional(),
});

export const pluginSchedulerLedgerEntrySchema = z.object({
  dedupeKey: z.string().min(1),
  namespace: pluginNamespaceSchema,
  taskId: z.string().min(1),
  actionId: z.string().min(1),
  idempotencyKey: z.enum(["calendar_slot", "action_input_hash"]),
  scheduledFor: z.string().datetime(),
  slotKey: z.string().min(1),
  timezone: z.string().min(1),
  executedAt: z.string().datetime(),
});

export const pluginSchedulerLedgerSchema = z.object({
  schemaVersion: z.literal("v1").default("v1"),
  updatedAt: z.string().datetime(),
  entries: z.array(pluginSchedulerLedgerEntrySchema).default([]),
});

const PROPOSAL_STATUS_TRANSITIONS: Record<
  z.infer<typeof proposalStatusSchema>,
  Array<z.infer<typeof proposalStatusSchema>>
> = {
  open: ["accepted", "rejected", "superseded"],
  accepted: [],
  rejected: [],
  superseded: [],
};

export function isProposalStatusTransitionAllowed(
  from: z.infer<typeof proposalStatusSchema>,
  to: z.infer<typeof proposalStatusSchema>,
): boolean {
  if (from === to) {
    return true;
  }

  return PROPOSAL_STATUS_TRANSITIONS[from].includes(to);
}

export const entitySchema = z.object({
  kind: z.enum(["note", "proposal", "plugin"]),
  id: z.string().min(1),
});

export const remEventSchema = z.object({
  eventId: z.string().min(1),
  schemaVersion,
  timestamp: z.string().datetime(),
  type: z.string().min(1),
  actor: actorSchema,
  entity: entitySchema,
  payload: z.record(z.string(), z.unknown()),
});

export type Actor = z.infer<typeof actorSchema>;
export type ActorKind = z.infer<typeof actorKindSchema>;
export type AgentActor = z.infer<typeof agentActorSchema>;
export type HumanActor = z.infer<typeof humanActorSchema>;
export type LexicalState = z.infer<typeof lexicalStateSchema>;
export type NoteMeta = z.infer<typeof noteMetaSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type ProposalType = z.infer<typeof proposalTypeSchema>;
export type ProposalTarget = z.infer<typeof sectionTargetSchema>;
export type NoteSection = z.infer<typeof noteSectionSchema>;
export type NoteSectionIndex = z.infer<typeof noteSectionIndexSchema>;
export type ProposalContent = z.infer<typeof proposalContentSchema>;
export type ProposalMeta = z.infer<typeof proposalMetaSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type PluginManifestV1 = z.infer<typeof pluginManifestV1Schema>;
export type PluginManifestV2 = z.infer<typeof pluginManifestV2Schema>;
export type PluginManifestInput = z.infer<typeof pluginManifestInputSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginMeta = z.infer<typeof pluginMetaSchema>;
export type PluginPayloadSchema = z.infer<typeof pluginPayloadSchemaSchema>;
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;
export type PluginPermission = z.infer<typeof pluginPermissionSchema>;
export type PluginLifecycleState = z.infer<typeof pluginLifecycleStateSchema>;
export type PluginTemplateDefinition = z.infer<typeof pluginTemplateDefinitionSchema>;
export type PluginScheduledTaskDefinition = z.infer<typeof pluginScheduledTaskDefinitionSchema>;
export type PluginEntityTypeDefinition = z.infer<typeof pluginEntityTypeDefinitionSchema>;
export type PluginEntityRecord = z.infer<typeof pluginEntityRecordSchema>;
export type PluginEntityMeta = z.infer<typeof pluginEntityMetaSchema>;
export type PluginEntityLink = z.infer<typeof pluginEntityLinkSchema>;
export type PluginCliActionDefinition = z.infer<typeof pluginCliActionDefinitionSchema>;
export type PluginUiPanelDefinition = z.infer<typeof pluginUiPanelDefinitionSchema>;
export type PluginLifecycle = z.infer<typeof pluginLifecycleSchema>;
export type PluginSchedulerLedgerEntry = z.infer<typeof pluginSchedulerLedgerEntrySchema>;
export type PluginSchedulerLedger = z.infer<typeof pluginSchedulerLedgerSchema>;
export type RemEvent = z.infer<typeof remEventSchema>;
