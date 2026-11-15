/**
 * "How it is built" — a diagram made of plain boxes and arrows, no
 * mermaid, no canvas, no diagramming library. Structure and reading order
 * come from the DOM (a definition list of stages), so it degrades to plain
 * text for a screen reader instead of going silent the way an SVG or
 * canvas render would.
 */
import { landingCopy, type DiagramNode } from "./copy";

function Box({ node }: { node: DiagramNode }) {
  return (
    <div className="flex min-w-40 flex-1 flex-col gap-0.5 rounded-lg border border-zinc-300 bg-white px-4 py-3 text-center dark:border-zinc-700 dark:bg-zinc-900">
      <span className="text-sm font-medium">{node.label}</span>
      <span className="text-xs text-zinc-500">{node.detail}</span>
    </div>
  );
}

function DownArrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-1 text-zinc-400 dark:text-zinc-600">
      <span aria-hidden className="leading-none">
        ↓
      </span>
      {label ? <span className="text-xs">{label}</span> : null}
    </div>
  );
}

export function Architecture() {
  const { architecture } = landingCopy;
  const [browser, routeHandlers, toolLoop] = architecture.pipeline;
  const [policyEngine, tools, postgres] = architecture.fanOut;
  const [approvalQueue, evalSuite] = architecture.downstream;

  return (
    <section className="mx-auto w-full max-w-6xl px-6 py-16">
      <h2 className="text-2xl font-semibold tracking-tight">
        {architecture.title}
      </h2>

      <div className="mt-8 flex flex-col gap-10 lg:flex-row">
        <div className="flex-1 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
          <div className="mx-auto flex max-w-xs flex-col">
            <Box node={browser} />
            <DownArrow label={architecture.streamLabel} />
            <Box node={routeHandlers} />
            <DownArrow />
            <Box node={toolLoop} />
          </div>

          <div className="mx-auto mt-2 flex max-w-xs flex-col items-center text-zinc-400 dark:text-zinc-600">
            <span aria-hidden className="leading-none">
              ↓
            </span>
            <span className="text-xs">{architecture.fanOutLabel}</span>
          </div>

          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Box node={policyEngine} />
            <Box node={tools} />
            <Box node={postgres} />
          </div>

          <div className="mt-6 flex flex-col gap-3 border-t border-dashed border-zinc-200 pt-6 sm:flex-row dark:border-zinc-800">
            <div className="flex flex-1 flex-col items-center gap-1">
              <span className="text-xs text-zinc-400 dark:text-zinc-600">
                {architecture.approvalLabel}
              </span>
              <Box node={approvalQueue} />
            </div>
            <div className="flex flex-1 flex-col items-center gap-3 sm:flex-row">
              <Box node={evalSuite} />
              <span
                aria-hidden
                className="text-zinc-400 sm:hidden dark:text-zinc-600"
              >
                ↓
              </span>
              <span
                aria-hidden
                className="hidden text-zinc-400 sm:inline dark:text-zinc-600"
              >
                →
              </span>
              <Box node={architecture.ci} />
            </div>
          </div>
        </div>

        <ul className="flex w-full flex-col gap-4 lg:w-72 lg:shrink-0">
          {architecture.facts.map((fact) => (
            <li
              key={fact}
              className="border-l-2 border-zinc-300 pl-4 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
            >
              {fact}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
