import { describe, expect, it } from "vitest";

import { authorizeCron } from "./cron-auth";

const SECRET = "s3cret-value-nobody-should-see";

describe("authorizeCron", () => {
  it("admits Vercel's scheduler", () => {
    // Vercel sends `Authorization: Bearer ${CRON_SECRET}`. That spelling is
    // the contract; nothing else needs to work.
    expect(authorizeCron(`Bearer ${SECRET}`, SECRET)).toEqual({ ok: true });
  });

  it("accepts the scheme in any case, as RFC 7235 requires", () => {
    expect(authorizeCron(`bearer ${SECRET}`, SECRET)).toEqual({ ok: true });
  });

  it.each([
    ["no header at all", null],
    ["an empty header", ""],
    ["the secret with no scheme", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["a wrong secret", "Bearer not-the-secret"],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 8)}`],
    ["the secret plus a suffix", `Bearer ${SECRET}x`],
  ])("refuses %s with 401", (_label, header) => {
    expect(authorizeCron(header, SECRET)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it.each([undefined, "", "   "])(
    "fails closed with 500 when CRON_SECRET is %s",
    (secret) => {
      // 500 rather than 401 because an unconfigured deployment is the
      // operator's bug, and a 401 would have them hunting for a bad token.
      expect(authorizeCron("Bearer anything", secret)).toMatchObject({
        ok: false,
        status: 500,
      });
    },
  );

  it("never puts the secret in anything it returns", () => {
    // The route logs and returns whatever comes back here, so a message that
    // quoted the expected value would print it to the deployment log.
    const outcomes = [
      authorizeCron(`Bearer ${SECRET}x`, SECRET),
      authorizeCron(null, SECRET),
      authorizeCron("Bearer anything", undefined),
    ];

    for (const outcome of outcomes) {
      expect(JSON.stringify(outcome)).not.toContain(SECRET);
    }
  });
});
