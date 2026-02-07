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
export type LexicalState = z.infer<typeof lexicalStateSchema>;
export type NoteMeta = z.infer<typeof noteMetaSchema>;
export type RemEvent = z.infer<typeof remEventSchema>;
