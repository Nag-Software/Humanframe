/**
 * All user-visible strings live here. English is the source of truth for the
 * key shape; every other locale is type-checked against it.
 */
export const en = {
  auth: {
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
  maya: {
    greeting: "Hi, I'm Maya",
    tagline: "Ask me anything — I can search, write and build files for you.",
    composerPlaceholder: "Message Maya",
    send: "Send",
    startFailed: "Could not start the conversation. Try again.",
  },
  nav: {
    account: "Account",
    billing: "Billing",
    notifications: "Notifications",
    upgrade: "Upgrade to Pro",
    plans: {
      free: "Free",
      pro: "Pro",
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
      description: "Choose what we email you about.",
      product: {
        title: "Product updates",
        description: "New features and improvements.",
      },
      billingAlerts: {
        title: "Billing",
        description: "Receipts and plan changes.",
      },
      mentions: {
        title: "Mentions",
        description: "When someone needs your attention.",
      },
    },
  },
};

export type Dictionary = typeof en;

export const no: Dictionary = {
  auth: {
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
  maya: {
    greeting: "Hi, I'm Maya",
    tagline: "Ask me anything — I can search, write and build files for you.",
    composerPlaceholder: "Message Maya",
    send: "Send",
    startFailed: "Could not start the conversation. Try again.",
  },
  nav: {
    account: "Konto",
    billing: "Fakturering",
    notifications: "Varsler",
    upgrade: "Oppgrader til Pro",
    plans: {
      free: "Free",
      pro: "Pro",
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
      description: "Velg hva vi sender deg på e-post.",
      product: {
        title: "Produktoppdateringer",
        description: "Nye funksjoner og forbedringer.",
      },
      billingAlerts: {
        title: "Fakturering",
        description: "Kvitteringer og planendringer.",
      },
      mentions: {
        title: "Omtaler",
        description: "Når noen trenger oppmerksomheten din.",
      },
    },
  },
};

export const dictionaries = { en, no };
