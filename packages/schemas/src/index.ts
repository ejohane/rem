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

export const draftMetaSchema = z.object({
  id: z.string().min(1),
  schemaVersion,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  author: actorSchema,
  targetNoteId: z.string().min(1).optional(),
  title: z.string().default(""),
  tags: z.array(z.string()).default([]),
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
  kind: z.enum(["note", "proposal", "draft", "plugin"]),
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
export type DraftMeta = z.infer<typeof draftMetaSchema>;
export type RemEvent = z.infer<typeof remEventSchema>;
