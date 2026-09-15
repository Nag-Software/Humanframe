/**
 * All user-visible strings live here. English is the source of truth for the
 * key shape; every other locale is type-checked against it.
 */
export const en = {
  meta: {
    description: "AI that feels like a real colleague.",
  },
  locale: {
    label: "Language",
    description: "Menus and pages follow this language.",
    names: {
      en: "English",
      no: "Norsk",
    },
  },
  common: {
    save: "Save",
    saving: "Saving…",
  },
  auth: {
    metaTitle: "Sign in",
    title: "Sign in to Humanframe",
    description: "We email you a sign-in link. No password needed.",
    emailLabel: "Email",
    emailPlaceholder: "you@company.com",
    submit: "Send sign-in link",
    submitting: "Sending…",
    sent: "Check your inbox. The link is valid for one hour.",
    genericError: "Could not send the sign-in link. Try again.",
    invalidEmail: "Enter a valid email address.",
    expiredLink: "The sign-in link expired. Request a new one.",
    signOut: "Sign out",
    continueWithGoogle: "Continue with Google",
    dividerOr: "or",
    googleError: "Could not start Google sign-in. Try again.",
    brandTagline: "A colleague who remembers.",
  },
  nav: {
    platform: "Platform",
    overview: "Overview",
    assistants: "Assistants",
    maya: "Maya",
    routineTasks: "Routine tasks",
    calendar: "Calendar",
    billing: "Billing",
    account: "Account",
    notifications: "Notifications",
    upgrade: "Upgrade to Pro",
    plans: {
      free: "Free",
      pro: "Pro",
    },
  },
  pages: {
    overview: {
      metaTitle: "Overview",
      title: "Overview",
      description: "Activity across assistants and tasks.",
      recentActivity: "Recent activity",
    },
    routineTasks: {
      metaTitle: "Routine tasks",
      title: "Routine tasks",
      description: "Tasks that run on a set schedule.",
    },
    calendar: {
      metaTitle: "Calendar",
      title: "Calendar",
      description: "Meetings and appointments.",
    },
    assistants: {
      metaTitle: "Assistants",
      title: "Assistants",
      description: "Assistants set up for your workspace.",
      mayaAvailable: "AI assistant · available",
    },
  },
  settings: {
    title: "Settings",
    description: "Manage your account and workspace.",
    upgrade: {
      description: "Unlock higher limits and extra assistants.",
      current: "Current plan",
      included: "Pro includes",
      onPro: "This workspace is already on Pro.",
      features: {
        assistants: "More assistants in the workspace",
        history: "Longer memory and history",
        priority: "Priority support",
      },
    },
    account: {
      description: "Your profile and sign-in details.",
      name: "Name",
      email: "Email",
    },
    billing: {
      description: "Subscription, invoices, and payment method.",
      plan: "Plan",
      invoices: "Invoices",
    },
    notifications: {
      description: "Maya only emails you if you turn this on.",
      form: {
        emailTitle: "Email notifications",
        emailDescription: "Sent to the address you're signed in with.",
        emailDescriptionNamed:
          "Sent to {email}. We use the address you're signed in with.",
        remindersTitle: "Reminders",
        remindersDescription:
          "When Maya comes back to something she promised to follow up.",
        backgroundTitle: "Background work finished",
        backgroundDescription:
          "When something she was working on in the background is done.",
        approvalTitle: "Needs approval",
        approvalDescription:
          "When she has stopped and is waiting for you to approve a step.",
        quietHoursTitle: "Quiet hours",
        quietHoursDescription:
          "Notifications wait until quiet hours end. Nothing is lost.",
        from: "From",
        to: "to",
        timezone: "Time zone",
        saved: "Saved.",
        invalid: "Those settings were not valid.",
        saveFailed: "Could not save. Try again.",
        signInRequired: "Sign in to change these settings.",
      },
    },
  },
  maya: {
    greeting: "Hi, I'm Maya",
    tagline: "Ask me anything — I can search, write and build files for you.",
    composerPlaceholder: "Message Maya",
    send: "Send",
    startFailed: "Could not start the conversation. Try again.",
    role: "AI assistant · available",
    voiceCall: "Start a voice call",
    videoCall: "Start a video call",
    call: {
      title: "Call with Maya",
      ready: "Ready",
      requestingMic: "Asking for microphone access…",
      connecting: "Connecting…",
      connected: "In a call",
      muted: "Microphone is off",
      ending: "Ending…",
      failed: "The call ended unexpectedly",
      mute: "Turn the microphone off",
      unmute: "Turn the microphone on",
      hangUp: "End the call",
      retry: "Try again",
      micDenied:
        "Maya needs access to your microphone. Allow it in your browser and try again.",
      micMissing: "No microphone was found.",
      connectionLost: "The connection dropped.",
      startFailed: "Could not start the call.",
      threadTitle: "Call with Maya",
    },
    helpToday: "How can I help you today?",
    starters: {
      news: "Summarise the latest AI news from Norway",
      email: "Draft an email to a new customer",
      agenda: "Prepare an agenda for tomorrow's standup",
    },
    thread: {
      loadingConversation: "Loading conversation",
      scrollToBottom: "Scroll to bottom",
      composerAria: "Message field",
      dictate: "Voice input",
      stopDictate: "Stop dictation",
      stopGeneration: "Stop generating",
      working: "Maya is working",
      copy: "Copy",
      retry: "Try again",
      more: "More",
      exportMarkdown: "Export as Markdown",
      edit: "Edit",
      cancel: "Cancel",
      update: "Update",
      previous: "Previous",
      next: "Next",
      reasoning: "Reasoning",
      toolCall: "{count} tool call",
      toolCalls: "{count} tool calls",
      searching: "Searching",
      readSources: "Read {count} sources",
    },
    tools: {
      fetchingLink: "Fetching link…",
      creatingFile: "Creating {filename}…",
      fileFallback: "file",
      draftingEmail: "Drafting an email…",
      draft: "Draft",
      to: "To: {recipients}",
      checkingCalendar: "Checking the calendar…",
      meetingSuggestion: "Meeting suggestion",
      openWebsite: "Open website",
      openWebsiteReason: "Maya wants to read the page",
      declinedOpen: "You declined to open {domain}.",
      reading: "Reading {domain}…",
    },
    approval: {
      deny: "Deny",
      alwaysAllow: "Always allow",
      allowOnce: "Allow once",
      running: "Approved, running",
      denied: "Denied",
      finished: "Finished with exit 0",
    },
  },
};

export type Dictionary = typeof en;
export type Locale = "en" | "no";

export const no: Dictionary = {
  meta: {
    description: "KI som føles som en ekte kollega.",
  },
  locale: {
    label: "Språk",
    description: "Menyer og sider følger dette språket.",
    names: {
      en: "English",
      no: "Norsk",
    },
  },
  common: {
    save: "Lagre",
    saving: "Lagrer…",
  },
  auth: {
    metaTitle: "Logg inn",
    title: "Logg inn i Humanframe",
    description: "Vi sender deg en innloggingslenke på e-post. Ingen passord.",
    emailLabel: "E-post",
    emailPlaceholder: "deg@selskap.no",
    submit: "Send innloggingslenke",
    submitting: "Sender…",
    sent: "Sjekk innboksen. Lenken er gyldig i én time.",
    genericError: "Klarte ikke å sende innloggingslenken. Prøv igjen.",
    invalidEmail: "Skriv inn en gyldig e-postadresse.",
    expiredLink: "Innloggingslenken er utløpt. Be om en ny.",
    signOut: "Logg ut",
    continueWithGoogle: "Fortsett med Google",
    dividerOr: "eller",
    googleError: "Klarte ikke å starte Google-innlogging. Prøv igjen.",
    brandTagline: "En kollega som husker.",
  },
  nav: {
    platform: "Plattform",
    overview: "Oversikt",
    assistants: "Assistenter",
    maya: "Maya",
    routineTasks: "Rutineoppgaver",
    calendar: "Kalender",
    billing: "Fakturering",
    account: "Konto",
    notifications: "Varsler",
    upgrade: "Oppgrader til Pro",
    plans: {
      free: "Free",
      pro: "Pro",
    },
  },
  pages: {
    overview: {
      metaTitle: "Oversikt",
      title: "Oversikt",
      description: "Aktivitet på tvers av assistenter og oppgaver.",
      recentActivity: "Siste aktivitet",
    },
    routineTasks: {
      metaTitle: "Rutineoppgaver",
      title: "Rutineoppgaver",
      description: "Oppgaver som kjører etter en fast plan.",
    },
    calendar: {
      metaTitle: "Kalender",
      title: "Kalender",
      description: "Møter og avtaler.",
    },
    assistants: {
      metaTitle: "Assistenter",
      title: "Assistenter",
      description: "Assistentene som er satt opp for arbeidsområdet ditt.",
      mayaAvailable: "AI-assistent · tilgjengelig",
    },
  },
  settings: {
    title: "Innstillinger",
    description: "Administrer kontoen og arbeidsområdet ditt.",
    upgrade: {
      description: "Lås opp høyere grenser og flere assistenter.",
      current: "Nåværende plan",
      included: "Pro inkluderer",
      onPro: "Dette arbeidsområdet er allerede på Pro.",
      features: {
        assistants: "Flere assistenter i arbeidsområdet",
        history: "Lengre minne og historikk",
        priority: "Prioritert støtte",
      },
    },
    account: {
      description: "Profilen din og innloggingsdetaljer.",
      name: "Navn",
      email: "E-post",
    },
    billing: {
      description: "Abonnement, kvitteringer og betalingsmåte.",
      plan: "Plan",
      invoices: "Kvitteringer",
    },
    notifications: {
      description: "Maya sender e-post bare hvis du slår det på.",
      form: {
        emailTitle: "E-postvarsling",
        emailDescription: "Sendes til adressen du er logget inn med.",
        emailDescriptionNamed:
          "Sendes til {email}. Vi bruker adressen du er logget inn med.",
        remindersTitle: "Påminnelser",
        remindersDescription:
          "Når Maya kommer tilbake til noe hun lovte å følge opp.",
        backgroundTitle: "Ferdig bakgrunnsarbeid",
        backgroundDescription: "Når noe hun jobbet med i bakgrunnen er ferdig.",
        approvalTitle: "Trenger godkjenning",
        approvalDescription:
          "Når hun har stoppet og venter på at du godkjenner et steg.",
        quietHoursTitle: "Stille timer",
        quietHoursDescription:
          "Varsler venter til stille-perioden er over. Ingenting blir borte.",
        from: "Fra",
        to: "til",
        timezone: "Tidssone",
        saved: "Lagret.",
        invalid: "Disse innstillingene var ikke gyldige.",
        saveFailed: "Klarte ikke å lagre. Prøv igjen.",
        signInRequired: "Logg inn for å endre disse innstillingene.",
      },
    },
  },
  maya: {
    greeting: "Hei, jeg er Maya",
    tagline:
      "Spør om hva som helst – jeg kan søke, skrive og lage filer for deg.",
    composerPlaceholder: "Skriv til Maya",
    send: "Send",
    startFailed: "Klarte ikke å starte samtalen. Prøv igjen.",
    role: "AI-assistent · tilgjengelig",
    voiceCall: "Start taleanrop",
    videoCall: "Start videoanrop",
    call: {
      title: "Samtale med Maya",
      ready: "Klar",
      requestingMic: "Ber om tilgang til mikrofonen…",
      connecting: "Kobler til…",
      connected: "Samtale pågår",
      muted: "Mikrofonen er av",
      ending: "Avslutter…",
      failed: "Samtalen ble avbrutt",
      mute: "Slå av mikrofonen",
      unmute: "Slå på mikrofonen",
      hangUp: "Avslutt samtalen",
      retry: "Prøv igjen",
      micDenied:
        "Maya trenger tilgang til mikrofonen. Gi tilgang i nettleseren og prøv igjen.",
      micMissing: "Fant ingen mikrofon å bruke.",
      connectionLost: "Forbindelsen ble brutt.",
      startFailed: "Fikk ikke startet samtalen.",
      threadTitle: "Samtale med Maya",
    },
    helpToday: "Hva kan jeg hjelpe deg med i dag?",
    starters: {
      news: "Oppsummer de siste AI-nyhetene fra Norge",
      email: "Skriv et e-postutkast til en ny kunde",
      agenda: "Lag en agenda til morgendagens standup",
    },
    thread: {
      loadingConversation: "Laster samtale",
      scrollToBottom: "Bla til bunnen",
      composerAria: "Meldingsfelt",
      dictate: "Taleinput",
      stopDictate: "Stopp diktering",
      stopGeneration: "Stopp generering",
      working: "Maya jobber",
      copy: "Kopier",
      retry: "Prøv på nytt",
      more: "Mer",
      exportMarkdown: "Eksporter som Markdown",
      edit: "Rediger",
      cancel: "Avbryt",
      update: "Oppdater",
      previous: "Forrige",
      next: "Neste",
      reasoning: "Resonnering",
      toolCall: "{count} verktøykall",
      toolCalls: "{count} verktøykall",
      searching: "Søker",
      readSources: "Leste {count} kilder",
    },
    tools: {
      fetchingLink: "Henter lenke …",
      creatingFile: "Lager {filename} …",
      fileFallback: "fil",
      draftingEmail: "Skriver e-postutkast …",
      draft: "Utkast",
      to: "Til: {recipients}",
      checkingCalendar: "Sjekker kalenderen …",
      meetingSuggestion: "Forslag til møte",
      openWebsite: "Åpne nettside",
      openWebsiteReason: "Maya vil lese innholdet på siden",
      declinedOpen: "Du avslo å åpne {domain}.",
      reading: "Leser {domain} …",
    },
    approval: {
      deny: "Avslå",
      alwaysAllow: "Alltid tillat",
      allowOnce: "Tillat én gang",
      running: "Godkjent, kjører",
      denied: "Avslått",
      finished: "Ferdig med exit 0",
    },
  },
};

export const dictionaries = { en, no };

export const locales = ["en", "no"] as const satisfies readonly Locale[];

export const defaultLocale: Locale = "en";

export const LOCALE_COOKIE = "hf_locale";

/** BCP 47 tags used by `Intl` (dates, numbers) for each UI locale. */
export const intlLocales = {
  en: "en-GB",
  no: "nb-NO",
} as const satisfies Record<Locale, string>;

export function isLocale(value: string | undefined): value is Locale {
  return value === "en" || value === "no";
}

export function formatMessage(
  template: string,
  values: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}
