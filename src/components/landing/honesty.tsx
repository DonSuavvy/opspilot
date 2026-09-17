/**
 * "What keeps it honest" — the three controls PLAN.md calls out as the
 * actual product. A card grid is the right call here, not the generic
 * default: these are three independent, parallel guarantees, which is
 * exactly the shape a card grid is for.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { landingCopy } from "./copy";

export function Honesty() {
  const { honesty } = landingCopy;

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-16">
      <h2 className="text-2xl font-semibold tracking-tight">
        {honesty.title}
      </h2>
      <div className="mt-8 grid gap-6 md:grid-cols-3">
        {honesty.cards.map((card) => (
          <Card key={card.title}>
            <CardHeader>
              <CardTitle>{card.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-zinc-600 dark:text-zinc-300">
                {card.description}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
