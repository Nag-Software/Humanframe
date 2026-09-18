import { redirect } from "next/navigation";

/** One colleague for now; the team lives in the sidebar. */
export default function AssistantsPage() {
  redirect("/assistants/maya");
}
