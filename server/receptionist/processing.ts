import type { SupabaseClient } from "@supabase/supabase-js";

import { errorFields, logger } from "@/lib/logger";
import { deleteRecording, downloadRecording, readTwilioConfig } from "@/server/telephony/twilio";
import { transcribeRecording } from "@/server/telephony/transcribe";

import { loadAvailability } from "./availability";
import { extractIntake, proposeActions, type Intake, type Proposal } from "./intake";
import { notifyOwner } from "./notify";
import { ensurePortal } from "./portal";
import type { BusinessProfile } from "./profile";
import { loadProfile, toInquiry, type Inquiry, type InquiryRow } from "./store";

/**
 * After the call: recording → transcript → intake → proposals → owner told.
 *
 * Runs right after the recording webhook (in `after()`), and again from the
 * daily sweep for anything that failed or was stranded. The claim makes it
 * safe to run twice at once: only one worker gets a row.
 */

// Longer than any one run can take (transcription, the model, the calendar),
// so a sweep never claims a row that a live worker still holds.
const LEASE_MS = 15 * 60_000;

export async function processInquiry(admin: SupabaseClient, inquiryId: string | null, limit = 1) {
  const { data, error } = await admin.rpc("claim_inquiry_processing", {
    p_id: inquiryId,
    p_lease_ms: LEASE_MS,
    p_limit: limit,
  });
  if (error) {
    logger.error("receptionist.claim_failed", errorFields(error));
    return [];
  }

  const outcomes: { id: string; ok: boolean }[] = [];
  for (const row of (data ?? []) as InquiryRow[]) {
    const inquiry = toInquiry(row);
    // The attempt counter is this run's claim token: every claim bumps it, so
    // a run that lost its lease finds a different number and writes nothing.
    const attempt = (row as InquiryRow & { processing_attempts: number }).processing_attempts;
    try {
      await runPipeline(admin, inquiry, attempt);
      outcomes.push({ id: inquiry.id, ok: true });
    } catch (failure) {
      logger.error("receptionist.processing_failed", { inquiryId: inquiry.id, ...errorFields(failure) });
      await admin
        .from("inquiries")
        .update({
          processing: "failed",
          processing_error: failure instanceof Error ? failure.message.slice(0, 500) : "failed",
        })
        .eq("id", inquiry.id)
        .eq("processing", "processing")
        .eq("processing_attempts", attempt);
      outcomes.push({ id: inquiry.id, ok: false });
    }
  }
  return outcomes;
}

async function runPipeline(admin: SupabaseClient, inquiry: Inquiry, attempt: number): Promise<void> {
  const profile = await loadProfile(admin, inquiry.workspaceId);
  const now = new Date();

  const transcript = await obtainTranscript(inquiry, profile);
  const availability = await loadAvailability(admin, profile, { now, calendarTimeoutMs: 8000 });

  let intake: Intake;
  if (transcript.trim()) {
    intake = await extractIntake({
      transcript,
      profile,
      offeredSlots: availability.slots,
      now,
      channel: inquiry.channel,
    });
  } else {
    intake = silentCallIntake(profile);
  }

  const proposals = proposeActions({
    intake,
    profile,
    callerPhone: inquiry.callerPhone,
    callerEmail: inquiry.callerEmail,
    channel: inquiry.channel,
    freeSlots: availability.slots,
    now,
  });

  // Still ours? A run that outlived its lease must not replace the proposals
  // of the run that took over.
  const { data: held } = await admin
    .from("inquiries")
    .select("id")
    .eq("id", inquiry.id)
    .eq("processing", "processing")
    .eq("processing_attempts", attempt)
    .maybeSingle<{ id: string }>();
  if (!held) return;

  await saveProposals(admin, inquiry, proposals);
  // Every inquiry gets a customer page, so the owner can share it at once.
  await ensurePortal(admin, { workspaceId: inquiry.workspaceId, inquiryId: inquiry.id });

  const { data: updated, error } = await admin
    .from("inquiries")
    .update({
      transcript,
      title: intake.title.slice(0, 200),
      summary: intake.summary.slice(0, 2000),
      intake,
      urgency: intake.urgency,
      caller_name: intake.callerName ?? inquiry.callerName,
      caller_email: intake.callerEmail ?? inquiry.callerEmail,
      // A new inquiry is already `open`; a retry must not reopen one the
      // owner has since handled or dismissed.
      ...(intake.category === "spam" && inquiry.status === "open" ? { status: "dismissed" } : {}),
      processing: "done",
      processing_error: null,
    })
    .eq("id", inquiry.id)
    .eq("processing", "processing")
    .eq("processing_attempts", attempt)
    .select("*")
    .maybeSingle<InquiryRow>();
  if (error) throw new Error("Could not save the processed inquiry");
  if (!updated) return;

  // The audio is not kept once its words are. Failing to delete is logged,
  // not fatal: the transcript is already safe.
  const config = readTwilioConfig();
  if (config && inquiry.recordingSid) {
    const deleted = await deleteRecording(config, inquiry.recordingSid);
    if (deleted) {
      await admin
        .from("inquiries")
        .update({ recording_deleted_at: new Date().toISOString(), recording_url: null })
        .eq("id", inquiry.id);
    } else {
      logger.warn("receptionist.recording_not_deleted", { inquiryId: inquiry.id });
    }
  }

  if (intake.category !== "spam") {
    await notifyOwner(admin, {
      inquiry: toInquiry(updated),
      profile,
      proposals: proposals.length,
    });
  }
}

async function obtainTranscript(inquiry: Inquiry, profile: BusinessProfile): Promise<string> {
  if (inquiry.channel === "sms") return inquiry.transcript;
  if (!inquiry.recordingUrl) return inquiry.transcript;

  const config = readTwilioConfig();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!config || !apiKey) {
    throw new Error("Transcription needs Twilio credentials and OPENAI_API_KEY");
  }
  const wav = await downloadRecording(config, inquiry.recordingUrl);
  const vocabulary = [profile.name, ...profile.services.map((service) => service.name)]
    .filter(Boolean)
    .join(", ");
  const { text } = await transcribeRecording({ apiKey, wav, vocabulary });
  return text;
}

/**
 * A call where nobody spoke: the caller hung up during the greeting, or the
 * line dropped. Still a lost customer worth a text back — that is the point
 * of the product.
 */
export function silentCallIntake(profile: BusinessProfile): Intake {
  const name = profile.name || "oss";
  return {
    callerName: null,
    callerEmail: null,
    callbackNumber: null,
    title: "Ubesvart anrop",
    summary: "Innringeren la på før det ble sagt noe. Send en SMS eller ring tilbake.",
    category: "other",
    urgency: "normal",
    address: null,
    wantsAppointment: false,
    agreedSlot: null,
    preferredTimes: [],
    wantsPhotoLink: false,
    wantsInfoLink: false,
    openQuestions: [],
    quoteLines: [],
    suggestedReply: `Hei! Vi så at du ringte ${name}. Hva kan vi hjelpe deg med? Svar gjerne her, så tar vi kontakt.`,
  };
}

/** Replaces any still-undecided proposals, so a retried run never doubles them. */
async function saveProposals(admin: SupabaseClient, inquiry: Inquiry, proposals: Proposal[]) {
  await admin
    .from("inquiry_actions")
    .delete()
    .eq("inquiry_id", inquiry.id)
    .eq("status", "proposed");

  if (proposals.length === 0) return;
  const { error } = await admin.from("inquiry_actions").insert(
    proposals.map((proposal) => ({
      workspace_id: inquiry.workspaceId,
      inquiry_id: inquiry.id,
      kind: proposal.kind,
      payload: proposal.payload,
      rationale: proposal.rationale,
    }))
  );
  if (error) throw new Error("Could not save the proposals");
}
