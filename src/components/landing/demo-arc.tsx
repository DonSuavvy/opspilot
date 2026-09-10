/**
 * "The 3-minute arc" — the four steps a reviewer actually runs. Numbered
 * because the content really is a sequence (each step changes what the next
 * one shows), which is the one case the design brief carves out for numeric
 * markers.
 */
import Link from "next/link";

import { landingCopy } from "./copy";

export function DemoArc() {
  const { arc } = landingCopy;

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-16">
      <h2 className="text-2xl font-semibold tracking-tight">{arc.title}</h2>
      <ol className="mt-8 flex flex-col gap-8">
        {arc.steps.map((step, index) => (
          <li key={step.title} className="flex gap-5">
            <span className="mt-0.5 font-mono text-sm text-zinc-400 tabular-nums dark:text-zinc-600">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="flex flex-col gap-1.5">
              <h3 className="font-medium">{step.title}</h3>
              <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
                {step.description}
              </p>
              <Link
                href={step.href}
                className="mt-1 w-fit text-sm text-zinc-500 underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-200"
              >
                {step.linkLabel}
              </Link>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
