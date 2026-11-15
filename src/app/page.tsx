import { Architecture } from "@/components/landing/architecture";
import { DemoArc } from "@/components/landing/demo-arc";
import { Hero } from "@/components/landing/hero";
import { Honesty } from "@/components/landing/honesty";
import { Sandbox } from "@/components/landing/sandbox";
import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";

/**
 * The landing page.
 *
 * Static and server-rendered on purpose: no database read, no `cookies()`,
 * no `headers()`, no fetch. Every other page in this app reflects live run
 * state and says so with `force-dynamic`; this one is the front door, and a
 * front door that only opens when Postgres and the model provider are both
 * up is the wrong front door for a reliability-engineering portfolio piece.
 * It has to render the same way whichever of those are down.
 */
export default function Home() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <DemoArc />
        <Architecture />
        <Honesty />
        <Sandbox />
      </main>
      <SiteFooter />
    </>
  );
}
