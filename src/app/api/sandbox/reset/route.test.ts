import { beforeEach, describe, expect, it, vi } from "vitest";

import { SANDBOX_HEADER } from "@/lib/sandbox";

/**
 * The route, with Postgres mocked out.
 *
 * `npm test` never touches a database, and the branch worth pinning here is
 * not what `resetSandbox` writes — `npm run verify:sandbox` proves that
 * against a real one. It is that a cooldown refusal leaves as a 429 carrying
 * `Retry-After` rather than as the catch-all 500, which is what a plain
 * `throw` inside a `try` that ends in `status: 500` would have made of it.
 */
const resetSandbox = vi.fn();

vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/db/sandbox", async () => {
  const actual = await vi.importActual<typeof import("@/db/sandbox")>(
    "@/db/sandbox",
  );
  return { ...actual, resetSandbox: (...args: unknown[]) => resetSandbox(...args) };
});

const { ResetTooSoonError } = await import("@/db/sandbox");
const { POST } = await import("./route");

const slug = `sb_${"a".repeat(32)}`;

const post = () =>
  POST(
    new Request("http://localhost/api/sandbox/reset", {
      method: "POST",
      headers: { [SANDBOX_HEADER]: slug },
    }),
  );

beforeEach(() => {
  resetSandbox.mockReset();
});

describe("POST /api/sandbox/reset", () => {
  it("re-seeds and reports when the sandbox expires", async () => {
    resetSandbox.mockResolvedValue({
      workspaceId: "ws-1",
      expiresAt: new Date("2026-09-11T03:00:00.000Z"),
      seeded: true,
    });

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      expiresAt: "2026-09-11T03:00:00.000Z",
    });
  });

  it("answers 429 and says when, rather than re-seeding again", async () => {
    resetSandbox.mockRejectedValue(new ResetTooSoonError(18));

    const response = await post();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("18");
    expect(await response.json()).toEqual({
      error: "This sandbox was just reset. Try again in 18 seconds.",
      retry_after_seconds: 18,
    });
  });

  it("still refuses a request the proxy never stamped", async () => {
    const response = await POST(
      new Request("http://localhost/api/sandbox/reset", { method: "POST" }),
    );

    expect(response.status).toBe(400);
    expect(resetSandbox).not.toHaveBeenCalled();
  });
});
