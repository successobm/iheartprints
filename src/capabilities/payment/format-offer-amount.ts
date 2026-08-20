/**
 * Sprint A5.5: minor units → a display string, SERVER-SIDE.
 *
 * Formatted here and sent as a finished string so that exactly one thing in
 * the system knows what a price looks like. A client that received
 * `amountMinor` and a currency code would have to format it, and a second
 * formatter is a second source of truth about what something costs — the
 * category of divergence A5.3 already refused for the price itself.
 *
 * `Intl.NumberFormat` supplies the exponent, which is the part that is easy
 * to get wrong by hand: most currencies have two minor digits, JPY and KRW
 * have none, and a few (BHD, KWD, TND) have three. Hard-coding "divide by
 * 100" would silently misprice a yen amount by a factor of a hundred.
 * `resolvedOptions().maximumFractionDigits` asks the runtime rather than
 * assuming.
 *
 * Pure: no configuration read, no I/O. The caller supplies the
 * server-authoritative amount and currency.
 */

/**
 * The locale prices are formatted in.
 *
 * Fixed rather than negotiated from the request's `Accept-Language`, and that
 * is deliberate for now: the amount and currency are server-authoritative and
 * single-valued, so a per-request locale would vary only the punctuation of a
 * price nobody can change — while making the displayed string depend on a
 * header, which is the sort of input that later grows a bug. When the product
 * genuinely sells in more than one currency this becomes a real decision.
 */
const OFFER_LOCALE = "en-US";

export function formatOfferAmount(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();

  const formatter = new Intl.NumberFormat(OFFER_LOCALE, {
    style: "currency",
    currency: code,
  });

  // How many minor digits THIS currency has, per the runtime's own CLDR data.
  const exponent = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const major = amountMinor / 10 ** exponent;

  return formatter.format(major);
}
