/**
 * Give every visitor a sandbox, and tell the rest of the app which one.
 *
 * Written against `node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/proxy.md`. Next 16 renamed `middleware` to `proxy`; the
 * file runs on the Node runtime and the `runtime` segment config is an error
 * here, so there is nothing to declare.
 *
 * The whole file is one decision: which slug this request belongs to. Pages
 * and route handlers read `x-opspilot-sandbox` off the request and never touch
 * the cookie, which keeps validation in one place. `headers.set` is what makes
 * a spoofed inbound header irrelevant, because it overwrites whatever arrived.
 * The `delete` above it costs nothing and documents the intent.
 *
 * Everything real happens in `resolveSandbox`, which is pure and unit tested.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  resolveSandbox,
  SANDBOX_COOKIE,
  SANDBOX_COOKIE_MAX_AGE_S,
  SANDBOX_HEADER,
} from "@/lib/sandbox";

export function proxy(request: NextRequest) {
  const { slug, fresh } = resolveSandbox({
    cookie: request.cookies.get(SANDBOX_COOKIE)?.value,
    random: () => crypto.getRandomValues(new Uint8Array(16)),
  });

  const headers = new Headers(request.headers);
  headers.delete(SANDBOX_HEADER);
  headers.set(SANDBOX_HEADER, slug);

  // `next({ request: { headers } })` sends the headers upstream to the route.
  // `next({ headers })` would send them downstream to the browser instead,
  // which is the mistake the bundled docs call out by name.
  const response = NextResponse.next({ request: { headers } });

  if (fresh) {
    response.cookies.set({
      name: SANDBOX_COOKIE,
      value: slug,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SANDBOX_COOKIE_MAX_AGE_S,
      // Local development is plain http, so a hardcoded `secure` would drop
      // the cookie on every request and mint a new sandbox each page load.
      secure: process.env.NODE_ENV === "production",
    });
  }

  return response;
}

/**
 * Every page and every API route, minus four paths.
 *
 * `/api/health` and `/api/cron/:path*` stay global on purpose. Health reports
 * the deployment, not a visitor, and the cron sweep runs with no browser
 * attached, so handing either one a freshly minted sandbox would seed a
 * workspace nobody will ever open. `_next` and the favicon are static and do
 * not need a database row to be served.
 *
 * The `(?:$|/)` guards are not decoration. A bare `api/health` prefix would
 * also exclude a future `/api/healthz`, which is the kind of hole that only
 * shows up as a page mysteriously reading the wrong tenant.
 */
export const config = {
  matcher: [
    "/((?!api/health(?:$|/)|api/cron(?:$|/)|_next(?:$|/)|favicon\\.ico$).*)",
  ],
};
