// Tests for the account chip's label — the one word in the launcher's chrome
// that could lie about who is signed in.
//
// Run: `npm test` (node --test with type-stripping; no extra deps).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_FALLBACK_LABEL,
  accountChipLabel,
  localPart,
  type AccountSession,
} from "./identity.ts";

test("localPart takes everything before the first @", () => {
  assert.equal(localPart("ggonzalez@aurapointcapital.com"), "ggonzalez");
  assert.equal(localPart("first.last+tag@example.co.uk"), "first.last+tag");
  // A quoted local part may itself contain an @; splitting on the FIRST one
  // keeps the whole local part rather than half of it.
  assert.equal(localPart('"odd@name"@example.com'), '"odd');
});

test("localPart is null whenever there is nothing to show", () => {
  for (const value of [null, undefined, "", "   ", "@example.com", " @x"]) {
    assert.equal(localPart(value), null, `"${String(value)}" should not label a chip`);
  }
});

test("localPart tolerates a bare handle with no domain", () => {
  assert.equal(localPart("ggonzalez"), "ggonzalez");
});

test("the chip names the door when it does not know who you are", () => {
  const nobody: AccountSession = { signed_in: false, email: null, tier: null };
  assert.equal(accountChipLabel(nobody), ACCOUNT_FALLBACK_LABEL);
  assert.equal(accountChipLabel(null), ACCOUNT_FALLBACK_LABEL);
  assert.equal(accountChipLabel(undefined), ACCOUNT_FALLBACK_LABEL);
});

test("the chip never renders empty — it is a control", () => {
  const cases: (AccountSession | null | undefined)[] = [
    null,
    undefined,
    { signed_in: false, email: null, tier: null },
    { signed_in: true, email: "", tier: "pro" },
    { signed_in: true, email: "@example.com", tier: "pro" },
    { signed_in: true, email: "ggonzalez@aurapointcapital.com", tier: "pro" },
  ];
  for (const session of cases) {
    assert.ok(accountChipLabel(session).trim() !== "", JSON.stringify(session));
  }
});

test("a session with an email is never reported as the fallback", () => {
  const signedIn: AccountSession = {
    signed_in: true,
    email: "ggonzalez@aurapointcapital.com",
    tier: "pro",
  };
  assert.equal(accountChipLabel(signedIn), "ggonzalez");
  assert.notEqual(accountChipLabel(signedIn), ACCOUNT_FALLBACK_LABEL);
});
