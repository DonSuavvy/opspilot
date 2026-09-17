import Link from "next/link";

import { SopEditor } from "@/components/sop-editor";
import { getDb } from "@/db/client";
import { listSopVersions, loadActiveSop } from "@/db/sops";
import { currentSandbox } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Loads on the server so the editor paints populated rather than flashing a
 * spinner and then a document. The client island only handles editing.
 */
export default async function SopPage() {
  const db = getDb();
  // The empty-workspace branch that used to live here is gone: `currentSandbox`
  // seeds on demand, so by the time this returns there is a SOP to edit.
  const { workspaceId } = await currentSandbox();

  const [active, versions] = await Promise.all([
    loadActiveSop(db, workspaceId),
    listSopVersions(db, workspaceId),
  ]);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">SOP</h1>
          <Link href="/inbox" className="text-sm text-zinc-500 underline">
            back to the inbox
          </Link>
        </div>
        <p className="max-w-2xl text-sm text-zinc-500">
          The policy and the document are two halves of one versioned row. Edit
          the refund window, save, then re-run the same ticket — the agent is
          told the new rule because the prompt is compiled from what you just
          saved, not from a figure typed into the prose.
        </p>
      </header>
      <SopEditor
        initialActive={active}
        initialVersions={versions.map((v) => ({
          ...v,
          createdAt: v.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
