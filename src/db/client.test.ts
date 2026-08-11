import { describe, expect, it } from "vitest";

import { resolveSsl } from "./client";

/**
 * TLS was selected by substring-matching the *whole* connection string, so a
 * password or database name containing "localhost" silently disabled
 * encryption against a remote host. It failed open, in the direction that
 * loses confidentiality — the decision belongs to the parsed hostname alone.
 */
describe("resolveSsl", () => {
  it.each([
    ["localhost", "postgres://opspilot:opspilot@localhost:5434/opspilot"],
    ["127.0.0.1", "postgres://opspilot:opspilot@127.0.0.1:5434/opspilot"],
    ["::1", "postgres://opspilot:opspilot@[::1]:5434/opspilot"],
  ])("disables TLS for a real local host (%s)", (_label, url) => {
    expect(resolveSsl(url)).toBe(false);
  });

  it.each([
    ["ordinary credentials", "postgres://u:s3cret@db.prod.example.com:5432/app"],
    ["password contains localhost", "postgres://u:localhost99@db.prod.example.com:5432/app"],
    ["username contains localhost", "postgres://localhost_admin:p@db.prod.example.com:5432/app"],
    ["database name contains 127.0.0.1", "postgres://u:p@db.prod.example.com:5432/db127.0.0.1"],
    ["query string contains localhost", "postgres://u:p@db.prod.example.com:5432/app?fallback=localhost"],
  ])("requires verified TLS for a remote host (%s)", (_label, url) => {
    expect(resolveSsl(url)).toEqual({ rejectUnauthorized: true });
  });

  it("never disables TLS for a host that merely ends in localhost", () => {
    expect(resolveSsl("postgres://u:p@notlocalhost.example.com:5432/app")).toEqual(
      { rejectUnauthorized: true },
    );
  });

  /** A malformed URL must fail loudly here, not on the first query. */
  it("throws on a connection string that is not a URL", () => {
    expect(() => resolveSsl("this is not a url")).toThrow();
  });
});
