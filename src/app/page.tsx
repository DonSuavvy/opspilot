import { redirect } from "next/navigation";

/**
 * Placeholder. Day 8 puts the landing page here; until it lands, `/` sends
 * visitors straight to the inbox that used to live at this path.
 */
export default function Home() {
  redirect("/inbox");
}
