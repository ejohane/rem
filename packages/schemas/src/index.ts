import { z } from "zod";

export const schemaVersion = z.string().min(1);

export const configSchema = z.object({
  storeRoot: z.string().min(1),
  schemaVersion,
});

export type RemConfig = z.infer<typeof configSchema>;
