import { describe, expect, test } from "bun:test";

import type { ActorKind } from "./index";

describe("shared types", () => {
  test("actor kind allows human", () => {
    const actor: ActorKind = "human";
    expect(actor).toBe("human");
  });
});
