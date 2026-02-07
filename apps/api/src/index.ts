import { Hono } from "hono";

import { getCoreStatus } from "@rem/core";

const app = new Hono();

app.get("/status", (c) => c.json(getCoreStatus()));

export { app };
