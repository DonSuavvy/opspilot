/**
 * The hero. Four short claims about the engineering, not four adjectives
 * about the product, rendered as a plain list rather than cards: they are
 * independent facts, not a sequence, so no numbering and no card grid.
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";

import { landingCopy } from "./copy";

export function Hero() {
  const { hero } = landingCopy;

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-16 sm:py-20">
      <h1 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
        {hero.headline}
      </h1>
      <p className="mt-3 max-w-2xl text-lg text-zinc-600 dark:text-zinc-300">
        {hero.subhead}
      </p>

      <ul className="mt-8 flex max-w-2xl flex-col gap-3">
        {hero.principles.map((line) => (
          <li
            key={line}
            className="border-l-2 border-zinc-300 pl-4 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
          >
            {line}
          </li>
        ))}
      </ul>

      <div className="mt-9 flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href={hero.primaryCta.href}>{hero.primaryCta.label}</Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href={hero.secondaryCta.href}>{hero.secondaryCta.label}</Link>
        </Button>
      </div>
    </section>
  );
}
