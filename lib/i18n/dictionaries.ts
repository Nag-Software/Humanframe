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
};

export const dictionaries = { en, no };
