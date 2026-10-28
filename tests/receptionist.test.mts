/**
 * The receptionist's pure parts: time and slots, the profile, reading a
 * website, the prompt, the proposals, the provider signatures, WAV and
 * transcript handling, the calendar feed and the weekly report.
 *
 * Nothing here needs a database or a network: everything the receptionist
 * decides on its own is decided by code that can be run here.
 *
 *   pnpm test:receptionist
 */

// Modules that read the validated environment parse it on import.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= "test";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test";
process.env.APP_URL = "https://app.humanframe.test";

const { zonedTime, offsetMinutes, localParts, describeLocal, parseClock } = await import(
  "../server/receptionist/time.ts"
);
const { freeSlots, isBookable } = await import("../server/receptionist/slots.ts");
const { emptyProfile, normalizePhone, profileFromRow, profileInputSchema, profileReadiness } = await import(
  "../server/receptionist/profile.ts"
);
const { htmlToText, pickSubpages, isPrivateAddress, normalizeWebsiteUrl, decodeEntities, guardedLookup } = await import(
  "../server/receptionist/web.ts"
);
const { toDraft, mergeDraft } = await import("../server/receptionist/onboarding.ts");
const { buildReceptionistInstructions, buildGreeting, describeHours } = await import(
  "../server/receptionist/prompt.ts"
);
const { proposeActions, bookingPayloadSchema, smsPayloadSchema, UPLOAD_LINK_PLACEHOLDER } = await import(
  "../server/receptionist/intake.ts"
);
const { silentCallIntake } = await import("../server/receptionist/processing.ts");
const { twilioSignature, verifyTwilioSignature, sipUri, escapeXml } = await import(
  "../server/telephony/twilio.ts"
);
const { verifyOpenAIWebhook, signOpenAIWebhook, readIncomingCall, inquiryProof, verifyInquiryProof } = await import(
  "../server/telephony/openai-sip.ts"
);
const { encodeWav, parseWav, splitChannels, rmsLevel } = await import("../server/telephony/wav.ts");
const { cleanSegments, mergeDialogue, formatDialogue } = await import("../server/telephony/transcribe.ts");
const { buildIcsFeed, escapeIcsText, foldLine } = await import("../server/calendar/ics.ts");
const { extractBusy, extractEventId, localIso } = await import("../server/calendar/google.ts");
const { computeWeekStats, previousWeek, weekNumber, renderReport } = await import(
  "../server/receptionist/report.ts"
);
const { hashToken, isAcceptedUpload } = await import("../server/receptionist/uploads.ts");
const { ownerSmsText } = await import("../server/receptionist/notify.ts");
const { fromLocalInput, toLocalInput, formatPhone } = await import("../components/receptionist/format.ts");

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const OSLO = "Europe/Oslo";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

{
  const winter = zonedTime({ year: 2026, month: 1, day: 15 }, { hour: 9, minute: 0 }, OSLO);
  check("time: Oslo winter is UTC+1", winter.toISOString() === "2026-01-15T08:00:00.000Z", winter);
  const summer = zonedTime({ year: 2026, month: 7, day: 15 }, { hour: 9, minute: 0 }, OSLO);
  check("time: Oslo summer is UTC+2", summer.toISOString() === "2026-07-15T07:00:00.000Z", summer);
  // 2026-03-29 02:30 does not exist in Oslo; a person means 03:30.
  const gap = zonedTime({ year: 2026, month: 3, day: 29 }, { hour: 2, minute: 30 }, OSLO);
  check("time: the spring-forward gap lands an hour later", localParts(gap, OSLO).hour === 3, localParts(gap, OSLO));
  check("time: offset in October before the change", offsetMinutes(new Date("2026-10-24T12:00:00Z"), OSLO) === 120);
  check("time: offset after the change", offsetMinutes(new Date("2026-10-26T12:00:00Z"), OSLO) === 60);
  check("time: parseClock", parseClock("08:30") === 510 && parseClock("24:00") === 1440 && parseClock("25:00") === null);
  check(
    "time: describeLocal is Norwegian",
    describeLocal(new Date("2026-10-29T09:00:00Z"), OSLO) === "torsdag 29. oktober kl. 10:00",
    describeLocal(new Date("2026-10-29T09:00:00Z"), OSLO)
  );
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

const weekdays = {
  mon: [["08:00", "16:00"]] as [string, string][],
  tue: [["08:00", "16:00"]] as [string, string][],
  wed: [["08:00", "16:00"]] as [string, string][],
  thu: [["08:00", "16:00"]] as [string, string][],
  fri: [["08:00", "16:00"]] as [string, string][],
};

{
  // Wednesday 28 Oct 2026, 14:00 Oslo (13:00 UTC).
  const now = new Date("2026-10-28T13:00:00Z");
  const slots = freeSlots({
    now,
    timeZone: OSLO,
    hours: weekdays,
    durationMinutes: 60,
    bufferMinutes: 0,
    minNoticeHours: 2,
    busy: [],
  });
  check("slots: six by default", slots.length === 6, slots.length);
  check(
    "slots: respects minimum notice (none before 16:00 today, and 15:00 would end after closing)",
    slots.every((slot) => slot.start.getTime() >= now.getTime() + 2 * 3_600_000),
    slots[0]
  );
  check("slots: first is Thursday 08:00 Oslo", slots[0].start.toISOString() === "2026-10-29T07:00:00.000Z", slots[0]);
  const perDay = new Map<string, number>();
  for (const slot of slots) {
    const day = localParts(slot.start, OSLO).day;
    perDay.set(String(day), (perDay.get(String(day)) ?? 0) + 1);
  }
  check("slots: at most two per day", [...perDay.values()].every((count) => count <= 2), [...perDay.entries()]);
  check(
    "slots: never on a weekend",
    slots.every((slot) => !["sat", "sun"].includes(localParts(slot.start, OSLO).weekday))
  );

  const busy = [{ start: new Date("2026-10-29T07:00:00Z"), end: new Date("2026-10-29T09:00:00Z") }];
  const withBusy = freeSlots({
    now,
    timeZone: OSLO,
    hours: weekdays,
    durationMinutes: 60,
    bufferMinutes: 30,
    minNoticeHours: 2,
    busy,
  });
  check(
    "slots: skip busy time plus buffer",
    withBusy[0].start.getTime() >= new Date("2026-10-29T09:30:00Z").getTime(),
    withBusy[0]
  );

  const closed = freeSlots({
    now,
    timeZone: OSLO,
    hours: {},
    durationMinutes: 60,
    bufferMinutes: 0,
    minNoticeHours: 0,
    busy: [],
  });
  check("slots: no opening hours, no slots", closed.length === 0);

  check(
    "slots: isBookable refuses a clash",
    !isBookable(
      { start: new Date("2026-10-29T08:00:00Z"), end: new Date("2026-10-29T09:00:00Z") },
      { now, bufferMinutes: 0, busy }
    )
  );
  check(
    "slots: isBookable refuses the past",
    !isBookable({ start: new Date("2026-10-27T08:00:00Z"), end: new Date("2026-10-27T09:00:00Z") }, { now, bufferMinutes: 0, busy: [] })
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

{
  check("phone: bare Norwegian number", normalizePhone("912 34 567") === "+4791234567");
  check("phone: 0047 prefix", normalizePhone("0047 91234567") === "+4791234567");
  check("phone: already E.164", normalizePhone("+46701234567") === "+46701234567");
  check("phone: garbage is null", normalizePhone("ring meg") === null);

  const parsed = profileInputSchema.safeParse({ openingHours: { mon: [["16:00", "08:00"]] } });
  check("profile: closing before opening is refused", !parsed.success);
  const sender = profileInputSchema.safeParse({ smsSender: "Rørlegger Hansen AS" });
  check("profile: SMS sender longer than 11 is refused", !sender.success);

  const lenient = profileFromRow({
    workspace_id: "w",
    name: "Test",
    website_url: null,
    summary: "",
    services: "not an array",
    prices: "",
    opening_hours: { mon: "nonsense" },
    address: "",
    service_area: "",
    contact_phone: "",
    contact_email: "",
    info_url: null,
    faq: null,
    instructions: "",
    greeting: "",
    owner_phone: null,
    notify_sms: true,
    notify_email: true,
    sms_sender: null,
    booking_enabled: true,
    appointment_minutes: 60,
    buffer_minutes: 0,
    min_notice_hours: 2,
    timezone: "Mars/Olympus",
    widget_key: "k",
    widget_enabled: true,
    widget_greeting: "",
    widget_color: null,
    price_items: [{ name: "x", unit: "bad", price: -1 }],
    prices_include_vat: true,
    quote_valid_days: 30,
    quote_terms: "",
    calendar_feed_token: "t",
    learned_from: [],
    learned_at: null,
    onboarded_at: null,
  });
  check(
    "profile: a bad stored value degrades to the default",
    lenient.services.length === 0 && Object.keys(lenient.openingHours).length === 0 && lenient.timezone === OSLO,
    lenient
  );

  const empty = emptyProfile("w");
  check(
    "profile: an empty profile is not ready, and says why",
    !profileReadiness(empty).ready && profileReadiness(empty).missing.join() === "name,summary,hours,ownerPhone"
  );
}

// ---------------------------------------------------------------------------
// Website
// ---------------------------------------------------------------------------

{
  const html = `<html><head><title>Hansen Rør AS</title><meta name="description" content="Rørlegger i Bergen">
    <style>.x{}</style><script>alert(1)</script></head><body>
    <nav><a href="/kontakt">Kontakt oss</a><a href="/priser/">Priser</a><a href="https://other.no/x">Annet</a>
    <a href="/bilde.jpg">Bilde</a><a href="/blogg">Blogg</a></nav>
    <h1>Velkommen</h1><p>Åpningstider:<br>Man&ndash;fre 07&ndash;15</p><p>R&oslash;r &amp; bad</p></body></html>`;
  const text = htmlToText(html);
  check("web: title and description lead", text.startsWith("Hansen Rør AS\nRørlegger i Bergen"), text);
  check("web: scripts and styles are gone", !text.includes("alert") && !text.includes(".x{}"));
  check("web: entities decoded, line breaks kept", text.includes("Man–fre 07–15") && text.includes("Rør & bad"), text);
  const subpages = pickSubpages(html, "https://hansenror.no/");
  check(
    "web: picks contact and prices on the same site only",
    subpages.length === 2 && subpages.includes("https://hansenror.no/kontakt") && subpages.includes("https://hansenror.no/priser/"),
    subpages
  );
  check("web: numeric entities", decodeEntities("&#229;&#x00F8;") === "åø");

  check("web: private IPv4", isPrivateAddress("10.1.2.3") && isPrivateAddress("169.254.169.254") && isPrivateAddress("127.0.0.1"));
  check("web: public IPv4", !isPrivateAddress("151.101.1.69"));
  check("web: private IPv6", isPrivateAddress("::1") && isPrivateAddress("fd00::1") && isPrivateAddress("::ffff:10.0.0.1"));
  const refuses = (input: string) => {
    try {
      normalizeWebsiteUrl(input);
      return false;
    } catch {
      return true;
    }
  };
  check("web: embedded IPv4 in IPv6 is private", isPrivateAddress("64:ff9b::a00:1") && isPrivateAddress("2002:a00:1::") && isPrivateAddress("::10.0.0.1"));
  const connectRefused = await new Promise<boolean>((resolve) =>
    guardedLookup("localhost", {}, (error) => resolve(error !== null))
  );
  check("web: the connect-time lookup refuses a name that resolves privately", connectRefused);
  check("web: bare domain gets https", normalizeWebsiteUrl("hansenror.no").toString() === "https://hansenror.no/");
  check(
    "web: refuses internal targets",
    refuses("http://localhost") && refuses("http://169.254.169.254/latest") && refuses("file:///etc/passwd") &&
      refuses("https://user:pw@site.no") && refuses("https://site.no:8080")
  );
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

{
  const learned = {
    name: " Hansen Rør AS ",
    summary: "Rørlegger i Bergen.",
    services: [{ name: "Lekkasje", description: "", price: "fra 1 500 kr" }, { name: " ", description: "", price: "" }],
    prices: "",
    openingHours: { mon: [["07:00", "15:00"]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } as never,
    hoursFound: false,
    address: "Bryggen 1",
    serviceArea: "Bergen",
    contactPhone: "55 12 34 56",
    contactEmail: "post@hansenror.no",
    faq: [],
  };
  const draft = toDraft(learned, "https://hansenror.no/");
  check("onboarding: hours not found on the site are not invented", Object.keys(draft.openingHours ?? {}).length === 0);
  check("onboarding: blank services dropped, names trimmed", draft.services?.length === 1 && draft.name === "Hansen Rør AS");
  check("onboarding: phone normalised", draft.contactPhone === "+4755123456");

  const owner = profileInputSchema.parse({ name: "Hansen Rørleggerservice", summary: "", instructions: "Aldri lov pris" });
  const merged = mergeDraft(owner, draft);
  check("onboarding: the owner's name wins over the website", merged.name === "Hansen Rørleggerservice");
  check("onboarding: empty fields are filled from the website", merged.summary === "Rørlegger i Bergen." && merged.address === "Bryggen 1");
  check("onboarding: the owner's rules survive", merged.instructions === "Aldri lov pris");
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const profile = {
  ...emptyProfile("w"),
  name: "Hansen Rør",
  summary: "Rørlegger i Bergen.",
  openingHours: weekdays,
  prices: "Timepris 950 kr eks. mva.",
  instructions: "Akutt lekkasje: be dem stenge hovedkranen.",
  ownerPhone: "+4790000000",
  infoUrl: "https://hansenror.no",
};

{
  const now = new Date("2026-10-28T13:00:00Z");
  const instructions = buildReceptionistInstructions({
    profile,
    now,
    callerPhone: "+4791234567",
    history: [{ callerName: "Kari", title: "Tett avløp", summary: "Badet.", startedAt: "2026-09-01T10:00:00Z" }],
    slots: [{ start: new Date("2026-10-29T07:00:00Z"), end: new Date("2026-10-29T08:00:00Z") }],
    slotsKnown: true,
  });
  check("prompt: names the business and says it is an AI", instructions.includes("Hansen Rør") && instructions.includes("Du er en AI"));
  check("prompt: offers the slot in local time", instructions.includes("torsdag 29. oktober kl. 08:00"), instructions);
  check("prompt: never says a booking is made", instructions.includes("Ikke si at timen er booket"));
  check("prompt: carries the owner's rules", instructions.includes("stenge hovedkranen"));
  check("prompt: remembers the caller", instructions.includes("Tett avløp") && instructions.includes("Kari"));
  check("prompt: emergency numbers", instructions.includes("113"));
  check("prompt: hours per day", describeHours(profile).includes("lørdag: stengt") && describeHours(profile).includes("mandag: 08:00–16:00"));

  const blind = buildReceptionistInstructions({ profile, now, callerPhone: null, history: [], slots: [], slotsKnown: false });
  check("prompt: unknown calendar offers no times", blind.includes("Du kan ikke se kalenderen") && !blind.includes("Ledige tider"));
  check("prompt: hidden number asks for one", blind.includes("Nummeret til innringeren er skjult"));
  check("prompt: the default greeting says the call is recorded", buildGreeting(profile).includes("tas opp"));
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

const baseIntake = {
  callerName: "Ola Nordmann",
  callerEmail: null,
  callbackNumber: null,
  title: "Lekkasje under vask",
  summary: "Drypper under kjøkkenvasken.",
  category: "booking" as const,
  urgency: "normal" as const,
  address: "Storgata 1",
  wantsAppointment: true,
  agreedSlot: null as string | null,
  preferredTimes: ["torsdag formiddag"],
  wantsPhotoLink: true,
  wantsInfoLink: false,
  openQuestions: [],
  quoteLines: [] as { description: string; quantity: number; priceItem: string }[],
  suggestedReply: "Takk for samtalen!",
};

{
  const now = new Date("2026-10-28T13:00:00Z");
  const freeSlotsList = [{ start: new Date("2026-10-29T07:00:00Z"), end: new Date("2026-10-29T08:00:00Z") }];

  const proposals = proposeActions({ intake: baseIntake, profile, callerPhone: "+4791234567", freeSlots: freeSlotsList, now });
  const kinds = proposals.map((proposal) => proposal.kind);
  check("proposals: booking and photo link, no extra reply", kinds.join() === "booking,sms", kinds);
  const booking = proposals.find((proposal) => proposal.kind === "booking");
  check(
    "proposals: booking takes the first free slot and is schema-valid",
    booking?.kind === "booking" &&
      booking.payload.startsAt === "2026-10-29T07:00:00.000Z" &&
      bookingPayloadSchema.safeParse(booking.payload).success,
    booking
  );
  check(
    "proposals: confirmation text names the time and greets by first name",
    booking?.kind === "booking" && booking.payload.confirmationSms!.startsWith("Hei Ola!") && booking.payload.confirmationSms!.includes("kl. 08:00")
  );
  const sms = proposals.find((proposal) => proposal.kind === "sms");
  check(
    "proposals: the photo SMS carries the placeholder for a fresh link",
    sms?.kind === "sms" && sms.payload.includeUploadLink && sms.payload.body.includes(UPLOAD_LINK_PLACEHOLDER) && smsPayloadSchema.safeParse(sms.payload).success
  );

  const agreed = proposeActions({
    intake: { ...baseIntake, agreedSlot: "2026-10-30T09:00:00+01:00" },
    profile,
    callerPhone: "+4791234567",
    freeSlots: freeSlotsList,
    now,
  }).find((proposal) => proposal.kind === "booking");
  check(
    "proposals: an agreed slot wins over the first free one",
    agreed?.kind === "booking" && agreed.payload.startsAt === "2026-10-30T08:00:00.000Z",
    agreed
  );

  const hidden = proposeActions({ intake: baseIntake, profile, callerPhone: null, freeSlots: freeSlotsList, now });
  check("proposals: nothing can be sent to a hidden number", hidden.length === 0);

  const callback = proposeActions({
    intake: { ...baseIntake, urgency: "high", wantsAppointment: false, wantsPhotoLink: false, callbackNumber: "41 23 45 67" },
    profile,
    callerPhone: "+4791234567",
    freeSlots: freeSlotsList,
    now,
  });
  check(
    "proposals: urgent means call back, on the number they asked for",
    callback[0]?.kind === "callback" && callback[0].payload.phone === "+4741234567",
    callback
  );

  const spam = proposeActions({ intake: { ...baseIntake, category: "spam" }, profile, callerPhone: "+4791234567", freeSlots: freeSlotsList, now });
  check("proposals: spam gets nothing", spam.length === 0);

  const silent = proposeActions({ intake: silentCallIntake(profile), profile, callerPhone: "+4791234567", freeSlots: freeSlotsList, now });
  check(
    "proposals: a silent call becomes a text back",
    silent.length === 1 && silent[0].kind === "reply" && silent[0].payload.body.includes("Hansen Rør"),
    silent
  );
}

// ---------------------------------------------------------------------------
// Provider signatures
// ---------------------------------------------------------------------------

{
  const params = { CallSid: "CA123", From: "+4791234567", To: "+4759999999" };
  const url = "https://app.humanframe.test/api/telephony/voice";
  const signature = twilioSignature("token", url, params);
  check("twilio: a correct signature verifies", verifyTwilioSignature({ authToken: "token", signature, urls: [url], params }));
  check(
    "twilio: a tampered parameter fails",
    !verifyTwilioSignature({ authToken: "token", signature, urls: [url], params: { ...params, From: "+4700000000" } })
  );
  check(
    "twilio: the second candidate URL is tried",
    verifyTwilioSignature({ authToken: "token", signature, urls: ["http://internal/api/telephony/voice", url], params })
  );
  check("twilio: no signature, no entry", !verifyTwilioSignature({ authToken: "token", signature: null, urls: [url], params }));
  check(
    "twilio: SIP URI carries the header",
    sipUri({ projectId: "proj_1", headers: { "X-Humanframe-Inquiry": "abc" } }) ===
      "sip:proj_1@sip.api.openai.com;transport=tls?X-Humanframe-Inquiry=abc"
  );
  check("twilio: XML escaping", escapeXml(`a&b<"c">`) === "a&amp;b&lt;&quot;c&quot;&gt;");

  const secret = `whsec_${Buffer.from("secret-key").toString("base64")}`;
  const body = JSON.stringify({
    type: "realtime.call.incoming",
    data: { call_id: "rtc_1", sip_headers: [{ name: "X-Humanframe-Inquiry", value: "00000000-0000-0000-0000-000000000001" }] },
  });
  const now = new Date("2026-10-28T12:00:00Z");
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signed = signOpenAIWebhook(secret, "wh_1", timestamp, body);
  const event = verifyOpenAIWebhook({ secret, body, id: "wh_1", timestamp, signature: signed, now });
  check("openai: a correct signature verifies", event !== null);
  const call = readIncomingCall(event);
  check(
    "openai: the call id and lower-cased headers are read",
    call?.callId === "rtc_1" && call.headers["x-humanframe-inquiry"] === "00000000-0000-0000-0000-000000000001"
  );
  check(
    "openai: a stale timestamp fails",
    verifyOpenAIWebhook({ secret, body, id: "wh_1", timestamp, signature: signed, now: new Date(now.getTime() + 10 * 60_000) }) === null
  );
  check(
    "openai: a tampered body fails",
    verifyOpenAIWebhook({ secret, body: body.replace("rtc_1", "rtc_2"), id: "wh_1", timestamp, signature: signed, now }) === null
  );
  const sip = { apiKey: "k", projectId: "p", webhookSecret: secret, model: "m", voice: "v" };
  const proof = inquiryProof(sip, "00000000-0000-0000-0000-000000000001");
  check(
    "openai: the inquiry proof binds the header to our own call",
    verifyInquiryProof(sip, "00000000-0000-0000-0000-000000000001", proof) &&
      !verifyInquiryProof(sip, "00000000-0000-0000-0000-000000000002", proof) &&
      !verifyInquiryProof(sip, "00000000-0000-0000-0000-000000000001", undefined)
  );
  check("openai: other events are not calls", readIncomingCall({ type: "response.done", data: {} }) === null);
}

// ---------------------------------------------------------------------------
// WAV and transcripts
// ---------------------------------------------------------------------------

{
  const frames = 800;
  const stereo = Buffer.alloc(frames * 4);
  for (let index = 0; index < frames; index += 1) {
    stereo.writeInt16LE(Math.round(Math.sin(index / 5) * 8000), index * 4); // caller speaks
    stereo.writeInt16LE(0, index * 4 + 2); // AI silent
  }
  const wav = encodeWav(stereo, 8000, 2);
  const info = parseWav(wav);
  check("wav: header round-trips", info.channels === 2 && info.sampleRate === 8000 && info.bitsPerSample === 16);
  const [caller, assistant] = splitChannels(info);
  check("wav: split gives mono files", parseWav(caller).channels === 1 && parseWav(caller).data.length === frames * 2);
  check("wav: the silent channel is silent", rmsLevel(assistant) === 0 && rmsLevel(caller) > 0.1);

  // µ-law: 0xFF is silence, 0x00 is the loudest negative sample.
  const mulawData = Buffer.from([0xff, 0x00]);
  const header = encodeWav(Buffer.alloc(0), 8000).subarray(0, 44);
  header.writeUInt16LE(7, 20);
  header.writeUInt16LE(8, 34);
  header.writeUInt32LE(2, 40);
  const [decoded] = splitChannels(parseWav(Buffer.concat([header, mulawData])));
  const samples = parseWav(decoded).data;
  check("wav: µ-law decodes", samples.readInt16LE(0) === 0 && samples.readInt16LE(2) < -30000, [samples.readInt16LE(0), samples.readInt16LE(2)]);

  const cleaned = cleanSegments("caller", [
    { start: 0, end: 2, text: " Hei, jeg har en lekkasje. " },
    { start: 2, end: 3, text: "Teksting av Nicolai Winther", no_speech_prob: 0.1 },
    { start: 3, end: 4, text: "noe", no_speech_prob: 0.9 },
  ]);
  check("transcript: hallucinations and no-speech dropped", cleaned.length === 1 && cleaned[0].text === "Hei, jeg har en lekkasje.");

  const dialogue = mergeDialogue([
    { role: "assistant", start: 2.5, end: 4, text: "Hvor er lekkasjen?" },
    { role: "caller", start: 0, end: 1, text: "Hei." },
    { role: "caller", start: 1.1, end: 2.4, text: "Jeg har en lekkasje." },
    { role: "caller", start: 4.2, end: 5, text: "Under vasken." },
  ]);
  check(
    "transcript: interleaved by time, consecutive lines merged",
    formatDialogue(dialogue) === "Innringer: Hei. Jeg har en lekkasje.\nResepsjonist: Hvor er lekkasjen?\nInnringer: Under vasken.",
    formatDialogue(dialogue)
  );
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

{
  const feed = buildIcsFeed({
    name: "Hansen Rør, bookinger",
    now: new Date("2026-10-28T12:00:00Z"),
    events: [
      {
        id: "b1",
        start: new Date("2026-10-29T07:00:00Z"),
        end: new Date("2026-10-29T08:00:00Z"),
        title: "Lekkasje; Ola",
        description: "Linje 1\nLinje 2",
        location: "Storgata 1, Bergen",
      },
    ],
  });
  check("ics: CRLF line endings", feed.includes("\r\nBEGIN:VEVENT\r\n") && feed.endsWith("END:VCALENDAR\r\n"));
  check("ics: UTC stamps", feed.includes("DTSTART:20261029T070000Z") && feed.includes("DTEND:20261029T080000Z"));
  check("ics: text escaped", feed.includes("SUMMARY:Lekkasje\\; Ola") && feed.includes("Linje 1\\nLinje 2") && feed.includes("Storgata 1\\, Bergen"));
  check("ics: escape helper", escapeIcsText("a,b;c\\d") === "a\\,b\\;c\\\\d");
  check("ics: a bare CR cannot start a new property", escapeIcsText("x\rDTSTART:1") === "x\\nDTSTART:1");
  const folded = foldLine(`DESCRIPTION:${"ø".repeat(60)}`);
  check(
    "ics: long lines fold at 75 octets",
    folded.split("\r\n ").every((part, index) => Buffer.byteLength(part) <= (index === 0 ? 75 : 74)) && folded.includes("\r\n "),
    folded
  );

  const freebusy = {
    data: {
      response_data: {
        calendars: { primary: { busy: [{ start: "2026-10-29T07:00:00Z", end: "2026-10-29T08:00:00Z" }] } },
        free_slots: [{ start: "2026-10-29T09:00:00Z", end: "2026-10-29T10:00:00Z" }],
      },
    },
  };
  const busy = extractBusy(freebusy);
  check("calendar: busy found under nesting, free slots ignored", busy.length === 1 && busy[0].start.toISOString() === "2026-10-29T07:00:00.000Z", busy);
  check(
    "calendar: dateTime objects too",
    extractBusy([{ start: { dateTime: "2026-10-29T07:00:00+01:00" }, end: { dateTime: "2026-10-29T08:00:00+01:00" } }]).length === 1
  );
  check("calendar: event id", extractEventId({ data: { response_data: { id: "evt123", htmlLink: "x" } } }) === "evt123");
  check("calendar: local ISO for Google", localIso(new Date("2026-10-29T07:00:00Z"), OSLO) === "2026-10-29T08:00:00");
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

{
  check("report: ISO week numbers", weekNumber("2026-10-26") === 44 && weekNumber("2020-12-28") === 53 && weekNumber("2021-01-04") === 1, [
    weekNumber("2026-10-26"),
    weekNumber("2020-12-28"),
    weekNumber("2021-01-04"),
  ]);
  const week = previousWeek(new Date("2026-10-28T13:00:00Z"), OSLO);
  check(
    "report: previous week is Monday to Monday, local",
    week.label === "2026-10-19" && week.start.toISOString() === "2026-10-18T22:00:00.000Z" && week.end.toISOString() === "2026-10-25T23:00:00.000Z",
    week
  );

  const stats = computeWeekStats({
    weekStart: "2026-10-19",
    inquiries: [
      { channel: "phone", status: "handled", title: "Lekkasje", urgency: "high", durationSeconds: 180, transcript: "Innringer: hei" },
      { channel: "phone", status: "open", title: "Ubesvart anrop", urgency: "normal", durationSeconds: 5, transcript: "" },
      { channel: "voicemail", status: "open", title: "Tilbud", urgency: "normal", durationSeconds: 40, transcript: "Innringer: ring meg" },
      { channel: "sms", status: "dismissed", title: "Reklame", urgency: "low", durationSeconds: null, transcript: "x" },
    ],
    actions: [
      { kind: "booking", status: "done" },
      { kind: "reply", status: "done" },
      { kind: "sms", status: "failed" },
    ],
    customerSmsSent: 3,
  });
  check(
    "report: counts",
    stats.calls === 3 && stats.answeredByAi === 1 && stats.voicemails === 1 && stats.silent === 1 &&
      stats.smsInquiries === 1 && stats.bookings === 1 && stats.repliesSent === 1 && stats.urgent === 1 &&
      stats.openNow === 2 && stats.minutes === 4,
    stats
  );
  check("report: dismissed titles are not listed", !stats.topTitles.includes("Reklame"));
  const email = renderReport(stats, "Hansen Rør");
  check("report: the subject leads with what was caught", email.subject.startsWith("3 forespørsler"), email.subject);
  check("report: the body links to the reports page", email.text.includes("https://app.humanframe.test/reports"));
}

// ---------------------------------------------------------------------------
// Uploads, notifications, formatting
// ---------------------------------------------------------------------------

{
  check("uploads: token hash is sha-256 hex", /^[0-9a-f]{64}$/.test(hashToken("abc")));
  check(
    "uploads: images and PDFs up to 15 MB",
    isAcceptedUpload("image/jpeg", 1000) && isAcceptedUpload("application/pdf", 15 * 1024 * 1024) &&
      !isAcceptedUpload("image/jpeg", 15 * 1024 * 1024 + 1) && !isAcceptedUpload("text/html", 10)
  );

  const text = ownerSmsText({
    inquiry: { title: "Lekkasje", callerName: null, callerPhone: "+4791234567", urgency: "high", channel: "phone" },
    proposals: 2,
    url: "https://app.humanframe.test/inbox/1",
  });
  check("notify: owner text", text === "HASTER: Lekkasje – +4791234567. 2 forslag venter på deg: https://app.humanframe.test/inbox/1", text);

  check("format: Norwegian phone", formatPhone("+4791234567") === "912 34 567");
  const local = toLocalInput("2026-10-29T07:00:00.000Z", OSLO);
  check("format: datetime-local in the business's zone", local === "2026-10-29T08:00", local);
  check("format: and back", fromLocalInput(local, OSLO) === "2026-10-29T07:00:00.000Z", fromLocalInput(local, OSLO));
  check("format: summer and back", fromLocalInput("2026-07-01T09:30", OSLO) === "2026-07-01T07:30:00.000Z");
}

// ---------------------------------------------------------------------------
// Web: quotes, widget, customer page
// ---------------------------------------------------------------------------

{
  const { quoteTotals, groundLines } = await import("../server/receptionist/quotes.ts");
  const { canSubmit, buildWebInstructions, formatTranscript, EMPTY_COLLECTED } = await import("../server/widget/conversation.ts");
  const { mergeCollected } = await import("../server/widget/sessions.ts");
  const { withPortalLink } = await import("../server/receptionist/portal.ts");
  const { withDisplayName } = await import("../agent/lib/email.ts");
  const { renderCustomerEmail } = await import("../server/receptionist/customer-email.ts");

  const incl = quoteTotals([{ description: "Arbeid", quantity: 2, unit: "time", unitPrice: 1250 }], true);
  check("quotes: prices incl. VAT — total is the sum, VAT a fifth", incl.total === 2500 && incl.vat === 500 && incl.subtotal === 2000, incl);
  const excl = quoteTotals([{ description: "Arbeid", quantity: 2, unit: "time", unitPrice: 1000 }], false);
  check("quotes: prices excl. VAT — 25 % on top", excl.subtotal === 2000 && excl.vat === 500 && excl.total === 2500, excl);

  const priceItems = [
    { name: "Timepris", unit: "time" as const, price: 950 },
    { name: "Oppmøte", unit: "fast" as const, price: 690 },
  ];
  const grounded = groundLines(
    [
      { description: "Feilsøking", quantity: 2, priceItem: "timepris" },
      { description: "Oppmøte", quantity: 1, priceItem: "Oppmøte" },
      { description: "Nytt blandebatteri", quantity: 1, priceItem: "Blandebatteri" },
    ],
    priceItems
  );
  check(
    "quotes: only the owner's prices survive, units from the list",
    grounded.length === 2 && grounded[0].unitPrice === 950 && grounded[0].unit === "time" && grounded[1].unitPrice === 690,
    grounded
  );

  const priced = { ...profile, priceItems };
  const now = new Date("2026-10-28T13:00:00Z");
  const quoteIntake = {
    ...baseIntake,
    wantsAppointment: false,
    wantsPhotoLink: false,
    category: "quote" as const,
    quoteLines: [{ description: "Feilsøking", quantity: 2, priceItem: "Timepris" }],
  };
  const withQuote = proposeActions({ intake: quoteIntake, profile: priced, callerPhone: null, callerEmail: "ola@example.no", channel: "web", freeSlots: [], now });
  const quote = withQuote.find((proposal) => proposal.kind === "quote");
  check(
    "proposals: a priced quote for an email-only web customer, and no duplicate reply",
    quote?.kind === "quote" && quote.payload.customerEmail === "ola@example.no" && quote.payload.lines[0].unitPrice === 950 &&
      !withQuote.some((proposal) => proposal.kind === "reply"),
    withQuote
  );
  const unpriced = proposeActions({ intake: quoteIntake, profile, callerPhone: "+4791234567", freeSlots: [], now });
  check("proposals: no price list, no quote", !unpriced.some((proposal) => proposal.kind === "quote"));
  const webPhotos = proposeActions({
    intake: { ...baseIntake, wantsAppointment: false },
    profile,
    callerPhone: "+4791234567",
    channel: "web",
    freeSlots: [],
    now,
  });
  check("proposals: no photo-link SMS for a web customer who could attach in the chat", !webPhotos.some((proposal) => proposal.kind === "sms"));
  const emailReply = proposeActions({
    intake: { ...baseIntake, wantsAppointment: false, wantsPhotoLink: false },
    profile,
    callerPhone: null,
    callerEmail: "kari@example.no",
    channel: "web",
    freeSlots: [],
    now,
  });
  check(
    "proposals: an email-only customer gets an email reply",
    emailReply[0]?.kind === "reply" && emailReply[0].payload.email === "kari@example.no" && emailReply[0].payload.to === null,
    emailReply
  );

  check("widget: cannot send without a name", !canSubmit({ ...EMPTY_COLLECTED, job: "Lekkasje", phone: "91234567" }));
  check("widget: cannot send without contact", !canSubmit({ ...EMPTY_COLLECTED, job: "Lekkasje", name: "Ola" }));
  check("widget: job, name and email is enough", canSubmit({ ...EMPTY_COLLECTED, job: "Lekkasje", name: "Ola", email: "o@x.no" }));
  const merged = mergeCollected(
    { ...EMPTY_COLLECTED, name: "Ola", phone: "91234567" },
    { ...EMPTY_COLLECTED, name: null, phone: "", job: "Lekkasje" }
  );
  check("widget: a later turn never erases what the customer gave", merged.name === "Ola" && merged.phone === "91234567" && merged.job === "Lekkasje");
  const webPrompt = buildWebInstructions({ profile: priced, now, slots: [], photos: 2, collected: EMPTY_COLLECTED });
  check(
    "widget: the prompt asks for photos, carries the price list and never promises totals",
    webPrompt.includes("binders-knappen") && webPrompt.includes("Timepris: 950 kr") && webPrompt.includes("Lov aldri en totalpris") && webPrompt.includes("Bilder lagt ved så langt: 2")
  );
  check(
    "widget: transcript notes the photos",
    formatTranscript([{ role: "user", content: "Hei", at: "" }], 3) === "Kunde: Hei\n[Kunden la ved 3 bilder]"
  );

  check("portal: the link is appended once", withPortalLink("Hei", "https://x/k/a") === "Hei\n\nSe saken din: https://x/k/a" && withPortalLink("Se https://x/k/a", "https://x/k/a") === "Se https://x/k/a");
  check("email: the business is the sender's name", withDisplayName("Maya <varsel@humanframe.app>", "Hansen \"Rør\"") === `"Hansen Rør" <varsel@humanframe.app>`);
  const rendered = renderCustomerEmail({ businessName: "Hansen <Rør>", body: "Hei\n\nLinje", link: { url: "https://x/k/a", label: "Se tilbudet" } });
  check("email: escaped, with a button", rendered.html.includes("Hansen &lt;Rør&gt;") && rendered.html.includes("Se tilbudet") && rendered.text.endsWith("Se tilbudet: https://x/k/a"));

  const kroner = computeWeekStats({
    weekStart: "2026-10-19",
    inquiries: [{ channel: "web", status: "open", title: "Bad", urgency: "normal", durationSeconds: null, transcript: "x" }],
    actions: [],
    customerSmsSent: 0,
    quotes: [{ status: "accepted", total: 48500 }, { status: "sent", total: 12000 }],
  });
  check(
    "report: kroner from quotes",
    kroner.webRequests === 1 && kroner.quotesSent === 2 && kroner.quotesAccepted === 1 && kroner.acceptedValue === 48500 && kroner.quotedValue === 60500,
    kroner
  );
  check("report: the subject leads with accepted kroner", /^48\s500 kr i godtatte tilbud/.test(renderReport(kroner, "Hansen").subject), renderReport(kroner, "Hansen").subject);
}

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
