import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import { createCalendarEvent, findCalendarAccount } from "@/server/calendar/google";

import {
  bookingPayloadSchema,
  callbackPayloadSchema,
  replyPayloadSchema,
  smsPayloadSchema,
  UPLOAD_LINK_PLACEHOLDER,
  type BookingPayload,
} from "./intake";
import { normalizePhone } from "./profile";
import { isBookable } from "./slots";
import { sendLoggedSms, type SendOutcome } from "./sms";
import {
  getInquiry,
  listBookings,
  loadProfile,
  transitionAction,
  type InquiryAction,
} from "./store";
import { createUploadLink } from "./uploads";

/**
 * The owner said yes (or no). This is where a proposal becomes an effect.
 *
 * The caller has already proved the owner is a member of the action's
 * workspace by reading the action through their own session. Everything here
 * runs with the service role, scoped to that workspace explicitly.
 *
 * One tap, one effect: the action is claimed by moving it to `executing` in a
 * conditional update, so a double tap or a second tab finds nothing to claim.
 */

export type Decision =
  | { kind: "dismiss" }
  | { kind: "approve"; payload?: unknown; force?: boolean };

export type DecisionResult =
  | { ok: true; action: InquiryAction }
  | { ok: false; reason: "not_found" | "already_decided" | "invalid" | "clash" | "failed"; message?: string };

export async function decideAction(
  admin: SupabaseClient,
  input: { action: InquiryAction; userId: string; decision: Decision }
): Promise<DecisionResult> {
  const { action, userId, decision } = input;
  const decided = { decided_by: userId, decided_at: new Date().toISOString() };

  if (decision.kind === "dismiss") {
    const dismissed = await transitionAction(admin, {
      id: action.id,
      workspaceId: action.workspaceId,
      from: ["proposed", "failed"],
      to: "dismissed",
      patch: decided,
    });
    if (dismissed) await settleInquiry(admin, action);
    return dismissed ? { ok: true, action: dismissed } : { ok: false, reason: "already_decided" };
  }

  const schema = {
    booking: bookingPayloadSchema,
    sms: smsPayloadSchema,
    reply: replyPayloadSchema,
    callback: callbackPayloadSchema,
  }[action.kind];
  const parsed = schema.safeParse(decision.payload ?? action.payload);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", message: parsed.error.issues[0]?.message };
  }
  const payload = parsed.data as Record<string, unknown>;

  // Phone numbers are normalised once, here, so what is stored is what is dialled.
  for (const key of ["to", "customerPhone", "phone"] as const) {
    if (typeof payload[key] === "string") {
      const normalized = normalizePhone(payload[key] as string);
      if (!normalized) return { ok: false, reason: "invalid", message: "Ugyldig telefonnummer" };
      payload[key] = normalized;
    }
  }

  if (action.kind === "booking" && !decision.force) {
    const clash = await bookingClashes(admin, action.workspaceId, payload as BookingPayload);
    if (clash) return { ok: false, reason: "clash" };
  }

  // `failed` may be retried: a refused SMS or a booking that hit an error
  // never reached anyone. `unknown` may not — it may have.
  const claimed = await transitionAction(admin, {
    id: action.id,
    workspaceId: action.workspaceId,
    from: ["proposed", "failed"],
    to: "executing",
    patch: { ...decided, payload, error: null },
  });
  if (!claimed) return { ok: false, reason: "already_decided" };

  try {
    const outcome = await execute(admin, claimed);
    const finished = await transitionAction(admin, {
      id: claimed.id,
      workspaceId: claimed.workspaceId,
      from: "executing",
      to: outcome.status,
      patch: {
        result: outcome.result,
        error: outcome.error ?? null,
        executed_at: new Date().toISOString(),
      },
    });
    await settleInquiry(admin, claimed);
    return finished ? { ok: true, action: finished } : { ok: false, reason: "failed" };
  } catch (error) {
    logger.error("receptionist.action_failed", { actionId: claimed.id, ...errorFields(error) });
    await transitionAction(admin, {
      id: claimed.id,
      workspaceId: claimed.workspaceId,
      from: "executing",
      to: "failed",
      patch: { error: error instanceof Error ? error.message.slice(0, 500) : "failed" },
    });
    return { ok: false, reason: "failed", message: error instanceof Error ? error.message : undefined };
  }
}

type Outcome = {
  status: "done" | "failed" | "unknown";
  result: Record<string, unknown>;
  error?: string;
};

function smsOutcome(result: SendOutcome): Outcome {
  switch (result.kind) {
    case "sent":
      return { status: "done", result: { smsSid: result.sid } };
    case "refused":
      return { status: "failed", result: {}, error: result.message };
    case "unconfigured":
      return { status: "failed", result: {}, error: result.reason };
    case "unknown":
      return {
        status: "unknown",
        result: {},
        error: "SMS-leverandøren svarte ikke. Meldingen kan ha blitt sendt.",
      };
  }
}

async function execute(admin: SupabaseClient, action: InquiryAction): Promise<Outcome> {
  const profile = await loadProfile(admin, action.workspaceId);

  if (action.kind === "callback") {
    // Calling back is the owner's own act; approving records that they did.
    return { status: "done", result: {} };
  }

  if (action.kind === "sms" || action.kind === "reply") {
    const payload = action.payload as { to: string; body: string; includeUploadLink?: boolean };
    let body = payload.body;
    if (payload.includeUploadLink) {
      const link = await createUploadLink(admin, {
        workspaceId: action.workspaceId,
        inquiryId: action.inquiryId,
      });
      body = body.includes(UPLOAD_LINK_PLACEHOLDER)
        ? body.replace(UPLOAD_LINK_PLACEHOLDER, link)
        : `${body}\n${link}`;
    }
    const result = await sendLoggedSms(admin, {
      profile,
      to: payload.to,
      body,
      audience: "customer",
      inquiryId: action.inquiryId,
      actionId: action.id,
    });
    return smsOutcome(result);
  }

  // Booking: ours first, then the calendar, then the customer's confirmation.
  const payload = action.payload as BookingPayload;
  const { data: booking, error } = await admin
    .from("bookings")
    .upsert(
      {
        workspace_id: action.workspaceId,
        inquiry_id: action.inquiryId,
        action_id: action.id,
        starts_at: payload.startsAt,
        ends_at: payload.endsAt,
        title: payload.title,
        customer_name: payload.customerName,
        customer_phone: payload.customerPhone,
        address: payload.address,
        notes: payload.notes,
      },
      { onConflict: "action_id" }
    )
    .select("id, calendar_event_id")
    .single<{ id: string; calendar_event_id: string | null }>();
  if (error || !booking) throw new Error("Could not save the booking");

  const result: Record<string, unknown> = { bookingId: booking.id };

  const account = booking.calendar_event_id ? null : await findCalendarAccount(admin, action.workspaceId);
  if (account) {
    try {
      const eventId = await createCalendarEvent(admin, account, {
        start: new Date(payload.startsAt),
        end: new Date(payload.endsAt),
        timeZone: profile.timezone,
        summary: payload.title,
        description: [
          payload.notes,
          payload.customerName,
          payload.customerPhone,
          "Booket via Humanframe",
        ]
          .filter(Boolean)
          .join("\n"),
        location: payload.address,
      });
      await admin
        .from("bookings")
        .update({ calendar_provider: "googlecalendar", calendar_event_id: eventId, calendar_error: null })
        .eq("id", booking.id);
      result.calendarEventId = eventId;
    } catch (calendarError) {
      // The booking stands; the owner sees that the calendar copy failed.
      const message = calendarError instanceof Error ? calendarError.message.slice(0, 300) : "failed";
      await admin.from("bookings").update({ calendar_error: message }).eq("id", booking.id);
      result.calendarError = message;
    }
  }

  if (payload.confirmationSms && payload.customerPhone) {
    const sms = await sendLoggedSms(admin, {
      profile,
      to: payload.customerPhone,
      body: payload.confirmationSms,
      audience: "customer",
      inquiryId: action.inquiryId,
      actionId: action.id,
    });
    const outcome = smsOutcome(sms);
    result.sms = outcome.status;
    if (outcome.status !== "done") {
      // The booking is made either way; only the text is in doubt.
      return { status: "done", result, error: `Timen er booket, men SMS-en: ${outcome.error}` };
    }
  }

  return { status: "done", result };
}

async function bookingClashes(
  admin: SupabaseClient,
  workspaceId: string,
  payload: BookingPayload
): Promise<boolean> {
  const start = new Date(payload.startsAt);
  const end = new Date(payload.endsAt);
  if (!(end > start)) return true;
  const profile = await loadProfile(admin, workspaceId);
  const existing = await listBookings(admin, workspaceId, {
    from: new Date(start.getTime() - 86_400_000),
    to: new Date(end.getTime() + 86_400_000),
  });
  return !isBookable(
    { start, end },
    {
      now: new Date(),
      bufferMinutes: profile.bufferMinutes,
      busy: existing.map((booking) => ({
        start: new Date(booking.startsAt),
        end: new Date(booking.endsAt),
      })),
    }
  );
}

/** When nothing is left to decide, the inquiry is handled. */
async function settleInquiry(admin: SupabaseClient, action: InquiryAction): Promise<void> {
  const { count } = await admin
    .from("inquiry_actions")
    .select("id", { count: "exact", head: true })
    .eq("inquiry_id", action.inquiryId)
    .in("status", ["proposed", "approved", "executing", "failed"]);
  if ((count ?? 0) === 0) {
    const inquiry = await getInquiry(admin, action.inquiryId, action.workspaceId);
    if (inquiry?.status === "open") {
      await admin
        .from("inquiries")
        .update({ status: "handled" })
        .eq("id", action.inquiryId)
        .eq("workspace_id", action.workspaceId);
    }
  }
}
