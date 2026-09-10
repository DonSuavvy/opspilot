/**
 * The landing page's header. Same shape as the nav row on `/inbox` and
 * `/ops` (wordmark, small underlined links) so arriving from one of those
 * pages, or leaving to one, does not feel like switching sites.
 */
import Link from "next/link";

import { landingCopy } from "./copy";

export function SiteHeader() {
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-baseline gap-x-5 gap-y-2 px-6 py-5">
        <span className="text-lg font-semibold tracking-tight">
          {landingCopy.brand}
        </span>
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          {landingCopy.nav.map((link) => (
            <Link
              key={link.href + link.label}
              href={link.href}
              className="text-sm text-zinc-500 underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
