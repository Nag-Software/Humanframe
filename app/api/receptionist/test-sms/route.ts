import { getServiceRoleClient } from "@/lib/supabase/server";
import { requireApiScope } from "@/server/receptionist/scope";
import { sendLoggedSms } from "@/server/receptionist/sms";
import { loadProfile } from "@/server/receptionist/store";

/** Sends the owner a test text, so they can see notifications reach them. */
export async function POST() {
  const auth = await requireApiScope({ configure: true });
  if ("response" in auth) return auth.response;
  const admin = getServiceRoleClient();
  const profile = await loadProfile(admin, auth.scope.workspaceId);
  if (!profile.ownerPhone) return Response.json({ error: "no_owner_phone" }, { status: 400 });

  const result = await sendLoggedSms(admin, {
    profile,
    to: profile.ownerPhone,
    body: `Test fra Humanframe: slik ser varslene om nye henvendelser ut.`,
    audience: "owner",
    from: process.env.TWILIO_NOTIFY_FROM || null,
  });
  return Response.json({ result: result.kind }, { status: result.kind === "sent" ? 200 : 502 });
}
