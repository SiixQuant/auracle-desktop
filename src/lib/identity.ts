// identity.ts — what the nav pill's account chip is allowed to say.
//
// Pure, and small on purpose: the chip is one word in the launcher's entire
// chrome, and the only interesting thing about it is what it does when it does
// not know who you are.
//
// THE LAW. The chip shows the local part of the signed-in email because that is
// the shortest form of a fact we actually hold. When the engine's shared
// session has no email on it — not signed in, a session that predates the field,
// a probe that failed — the chip falls back to naming its DOOR ("account"),
// never to a guess, an initial, or a blank control. A door labelled "account"
// is true in every state; "ggonzalez" when nobody is signed in would not be.

/** The engine's shared hosted-sign-in session, as `cmd.clerkSession` reports
 *  it. Declared structurally so this module stays free of the Tauri bridge. */
export interface AccountSession {
  signed_in: boolean;
  email: string | null;
  tier: string | null;
}

/** What the chip reads when there is no email to read. It names the door. */
export const ACCOUNT_FALLBACK_LABEL = "account";

/** The local part of an email address, or null when there isn't one.
 *
 *  Splits on the FIRST `@`, which is the one that separates local part from
 *  domain in any address a provider will actually issue. Anything that leaves
 *  nothing behind — no `@`, a leading `@`, whitespace — is null rather than an
 *  empty chip. */
export function localPart(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  const local = (at === -1 ? email : email.slice(0, at)).trim();
  return local === "" ? null : local;
}

/** The account chip's label: who you are, or the name of the door. */
export function accountChipLabel(
  session: AccountSession | null | undefined,
): string {
  return localPart(session?.email) ?? ACCOUNT_FALLBACK_LABEL;
}
