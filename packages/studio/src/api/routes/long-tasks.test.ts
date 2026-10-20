import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.js";
import { registerLongTask, resetLongTasksForTests } from "../lib/long-task.js";
import { registerLongTaskRoutes } from "./long-tasks.js";

afterEach(() => {
  resetLongTasksForTests();
});

function createApp() {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: String(error) } }, 500);
  });
  registerLongTaskRoutes(app);
  return app;
}

describe("long-task routes", () => {
  it("estimates duration from char count", async () => {
    const res = await createApp().request("/api/v1/long-tasks/estimate?chars=11000");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      charCount: 11000,
      estimateMs: 390000,
      reference: { chars: 11000, minutes: [6, 7] },
    });
  });

  it("cancels a registered task", async () => {
    const controller = registerLongTask("live-1");
    const res = await createApp().request("/api/v1/long-tasks/live-1/cancel", { method: "POST" });
    expect(res.status).toBe(200);
    expect(controller.signal.aborted).toBe(true);
    const missing = await createApp().request("/api/v1/long-tasks/nope/cancel", { method: "POST" });
    expect(missing.status).toBe(404);
  });
});
