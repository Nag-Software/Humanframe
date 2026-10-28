import { intlLocales, type Locale } from "@/lib/i18n/dictionaries";

/** Times shown to the owner are the business's local time, not the server's. */
export function formatInZone(
  iso: string,
  timeZone: string,
  locale: Locale,
  style: "datetime" | "time" | "date" = "datetime"
): string {
  const options: Intl.DateTimeFormatOptions =
    style === "time"
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : style === "date"
        ? { weekday: "short", day: "numeric", month: "short" }
        : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Intl.DateTimeFormat(intlLocales[locale], { ...options, timeZone }).format(new Date(iso));
}

/** "+4791234567" → "912 34 567"; other countries are shown as given. */
export function formatPhone(e164: string | null): string {
  if (!e164) return "";
  const match = /^\+47(\d{3})(\d{2})(\d{3})$/.exec(e164);
  return match ? `${match[1]} ${match[2]} ${match[3]}` : e164;
}

/** Value for an <input type="datetime-local"> in the business's timezone. */
export function toLocalInput(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** The inverse: a datetime-local value in `timeZone` → ISO instant. */
export function fromLocalInput(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const shown = toLocalInput(new Date(instant).toISOString(), timeZone);
    const [d, t] = shown.split("T");
    const [y, m, dd] = d.split("-").map(Number);
    const [h, mi] = t.split(":").map(Number);
    return Date.UTC(y, m - 1, dd, h, mi) - Math.floor(instant / 60_000) * 60_000;
  };
  const first = naive - offsetAt(naive);
  return new Date(naive - offsetAt(first)).toISOString();
}
