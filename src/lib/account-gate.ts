import type { AccountStatus } from "./tauri";

// Single source of truth for whether an action that depends on OS Accounts
// should be blocked behind the sign-in prompt. Keep this pure — it's called
// from App.tsx and from tests, and it's the file to edit when the policy
// needs to tighten (e.g. require a non-zero balance, require an
// upstream provider model to be configured, etc.).
export function shouldBlockOnSignIn(account: AccountStatus): boolean {
  return !account.signedIn;
}

// Signed in but unfunded: signup alone must not make the app usable — the
// free trial (a card-on-file subscription with trial credits) is the entry
// point. The gate mirrors what /authorize would decide anyway:
// - trialing/active subscribers pass (an active subscriber at zero balance
//   still has the credit-line floor, so authorize admits them);
// - anyone else passes only with a positive balance (e.g. permanent top-up
//   credits), which is spendable regardless of subscription state.
export function shouldBlockOnTrial(account: AccountStatus): boolean {
  if (!account.signedIn) return false;
  const status = account.subscription?.status;
  if (status === "trialing" || status === "active") return false;
  // Fail open when the balance shape is unknown — locking someone out over a
  // missing field would strand them; /authorize is the real enforcement.
  const credits = account.balance?.credits;
  return credits !== undefined && credits <= 0;
}
