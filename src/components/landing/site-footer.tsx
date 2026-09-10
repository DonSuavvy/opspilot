/**
 * Footer: links to the docs that back up every claim above, plus the one
 * line of attribution. No sitemap, no newsletter signup, nothing this
 * project does not actually have.
 */
import { landingCopy } from "./copy";

export function SiteFooter() {
  const { footer } = landingCopy;

  return (
    <footer className="border-t border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          {footer.docs.map((doc) => (
            <a
              key={doc.href}
              href={doc.href}
              className="text-sm text-zinc-500 underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-200"
            >
              {doc.label}
            </a>
          ))}
        </nav>
        <p className="text-sm text-zinc-500">{footer.credit}</p>
      </div>
    </footer>
  );
}
