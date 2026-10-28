/** "12 500 kr" — whole kroner, Norwegian grouping, no decimals unless needed. */
export function formatNok(value: number, options: { decimals?: boolean } = {}): string {
  const formatted = new Intl.NumberFormat("nb-NO", {
    minimumFractionDigits: options.decimals ? 2 : 0,
    maximumFractionDigits: options.decimals ? 2 : 0,
  }).format(value);
  return `${formatted} kr`;
}
