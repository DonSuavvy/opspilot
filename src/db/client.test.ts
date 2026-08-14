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

  /**
   * `URL` lowercases hostnames only for *special* schemes (http, https, ws,
   * wss, ftp, file). `postgres:` is not one, so the host arrives cased exactly
   * as typed and the loopback lookup has to fold it itself. Capitalising the
   * host in `.env.local` otherwise attempts TLS against a Docker Postgres that
   * offers none — a fail-*closed* bug that costs local availability, never
   * confidentiality.
   */
  it("disables TLS for a loopback host spelled in uppercase", () => {
    expect(resolveSsl("postgres://u:p@LOCALHOST:5434/db")).toBe(false);
  });

  it.each([
    ["mixed case", "postgres://u:p@LocalHost:5434/db"],
    ["alternating case", "postgres://u:p@LoCaLhOsT:5434/db"],
    // No letters to fold, but the fold must not break bracket stripping.
    ["bracketed IPv6 loopback", "postgres://u:p@[::1]:5434/db"],
    // `URL` compresses IPv6 literals to RFC 5952 form even for this scheme.
    ["expanded IPv6 loopback", "postgres://u:p@[0:0:0:0:0:0:0:1]:5434/db"],
  ])("disables TLS for a loopback host (%s)", (_label, url) => {
    expect(resolveSsl(url)).toBe(false);
  });

  /**
   * The load-bearing half of the case fold. Folding widens the loopback match,
   * so these pin down *how far*: only exact case variants of a loopback name
   * count. A "simplification" to `hostname.toLowerCase().includes("localhost")`
   * passes every other test in this file and fails these.
   */
  it.each([
    ["uppercase subdomain trick", "postgres://u:p@LOCALHOST.EVIL.COM/db"],
    ["uppercase infix", "postgres://u:p@MY-LOCALHOST-DB.AWS.COM/db"],
    ["uppercase password", "postgres://u:LOCALHOST@PROD.NEON.TECH/db"],
    ["uppercase suffix", "postgres://u:p@NOTLOCALHOST.EXAMPLE.COM/db"],
    ["uppercase database name", "postgres://u:p@PROD.NEON.TECH/LOCALHOST"],
  ])("requires verified TLS for a remote host (%s)", (_label, url) => {
    expect(resolveSsl(url)).toEqual({ rejectUnauthorized: true });
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
