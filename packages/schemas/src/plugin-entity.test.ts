import { describe, expect, test } from "bun:test";

import { pluginEntityMetaSchema, pluginEntityRecordSchema } from "./index";

describe("plugin entity schemas", () => {
  test("parses canonical plugin entity record and metadata", () => {
    const entity = pluginEntityRecordSchema.parse({
      id: "person-alice",
      namespace: "people",
      entityType: "person",
      schemaVersion: "v1",
      data: {
        name: "Alice",
        team: "ops",
      },
    });
    const meta = pluginEntityMetaSchema.parse({
      createdAt: "2026-02-11T00:00:00.000Z",
      updatedAt: "2026-02-11T00:00:00.000Z",
      actor: { kind: "human", id: "entity-admin" },
      links: [
        { kind: "note", noteId: "note-1" },
        {
          kind: "entity",
          namespace: "meetings",
          entityType: "meeting",
          entityId: "meeting-123",
        },
      ],
    });

    expect(entity.entityType).toBe("person");
    expect(meta.links?.length).toBe(2);
  });

  test("rejects invalid entity identifiers and malformed links", () => {
    expect(() =>
      pluginEntityRecordSchema.parse({
        id: "bad/id",
        namespace: "people",
        entityType: "person",
        schemaVersion: "v1",
        data: {},
      }),
    ).toThrow("Entity id must use [a-zA-Z0-9._-] characters");

    expect(() =>
      pluginEntityMetaSchema.parse({
        createdAt: "2026-02-11T00:00:00.000Z",
        updatedAt: "2026-02-11T00:00:00.000Z",
        actor: { kind: "human", id: "entity-admin" },
        links: [
          {
            kind: "entity",
            namespace: "meetings",
            entityType: "meeting",
          },
        ],
      }),
    ).toThrow();
  });
});
