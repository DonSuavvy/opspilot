/**
 * The visitor's workspace, for server components and route handlers.
 *
 * Server only. Everything below reads the request, and two callers exist for
 * two reasons: a server component has no `Request` object and reaches for
 * `headers()`, while a route handler has one in its hand and should use it.
 *
 * Both go through `x-opspilot-sandbox`, never through the cookie. The proxy is
 * the single place that decides whether a cookie is worth trusting, and
 * reading the cookie again here would be a second opinion nobody asked for.
 */
import { headers } from "next/headers";

import { getDb } from "@/db/client";
import { ensureSandbox, type SandboxWorkspace } from "@/db/sandbox";

import { isSandboxSlug, SANDBOX_HEADER } from "./sandbox";

/**
 * The header the proxy sets is missing or malformed.
 *
 * A deployment fault, not a visitor fault, and typed so a page can tell the
 * two apart. Reported as "run npm run db:seed" alongside every other load
 * failure it would send whoever reads it to rebuild Postgres over a matcher
 * that stopped covering a route.
 */
export class SandboxHeaderMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxHeaderMissingError";
  }
}

/** The visitor's sandbox, plus the slug it answers to. */
export interface VisitorSandbox extends SandboxWorkspace {
  slug: string;
}

/**
 * Pull the slug out of a header value, or say why there is not one.
 *
 * Pure, so the failure message is testable. There is no fallback to the first
 * workspace in the table and there must not be: a silent fallback would put
 * one visitor in another visitor's tenant, which is the exact failure this
 * whole feature exists to prevent.
 */
export function requireSandboxHeader(value: string | null | undefined): string {
  if (!isSandboxSlug(value)) {
    throw new SandboxHeaderMissingError(
      `no ${SANDBOX_HEADER} on this request. The proxy did not run for this ` +
        `route, so there is no sandbox to read. Check the matcher in ` +
        `src/proxy.ts.`,
    );
  }

  return value;
}

/** The visitor's sandbox, for a server component. Seeds it if it has expired. */
export async function currentSandbox(
  now: Date = new Date(),
): Promise<VisitorSandbox> {
  const slug = requireSandboxHeader((await headers()).get(SANDBOX_HEADER));
  return { slug, ...(await ensureSandbox(getDb(), slug, now)) };
}

/** The visitor's sandbox, for a route handler holding the request. */
export async function sandboxFromRequest(
  request: Request,
  now: Date = new Date(),
): Promise<VisitorSandbox> {
  const slug = requireSandboxHeader(request.headers.get(SANDBOX_HEADER));
  return { slug, ...(await ensureSandbox(getDb(), slug, now)) };
}
