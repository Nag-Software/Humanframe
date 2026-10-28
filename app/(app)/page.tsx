import { redirect } from "next/navigation";

/**
 * The default screen is the receptionist's inbox (docs/PIVOT.md): what came
 * in, and what is waiting for a yes. The query survives the hop so
 * `/?settings=billing` still opens the dialog on the other side.
 */
export default async function RootPage({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      query.set(key, value);
    }
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  redirect(`/inbox${suffix}`);
}
