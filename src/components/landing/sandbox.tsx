/**
 * "Your sandbox" — sets expectations about what a visitor is looking at
 * before they click into the demo: their own workspace, not a shared one,
 * and not permanent.
 */
import { landingCopy } from "./copy";

export function Sandbox() {
  const { sandbox } = landingCopy;

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-16">
      <h2 className="text-2xl font-semibold tracking-tight">
        {sandbox.title}
      </h2>
      <div className="mt-6 max-w-2xl rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
        <div className="flex flex-col gap-2">
          {sandbox.paragraphs.map((line) => (
            <p key={line} className="text-sm text-zinc-600 dark:text-zinc-300">
              {line}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
