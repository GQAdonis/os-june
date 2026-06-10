import { useEffect, useState } from "react";
import type { AccountStatus } from "../../lib/tauri";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onSignOut: () => void;
};

// The account hook already refreshes on window focus, which covers the
// common "came back from the portal" path; this poll is the fallback for
// the portal-in-another-window case where focus never returns here.
const POLL_INTERVAL_MS = 10_000;

/** Signed in but unfunded: the app stays unusable until the user starts the
 * free trial (or otherwise funds the account). The trial flow — Stripe
 * Checkout with card capture — lives in the accounts portal, so this gate
 * hands off to the browser and watches for the account to become funded. */
export function TrialGate({ account, onRefresh, onSignOut }: Props) {
  const [checking, setChecking] = useState(false);
  const portalUrl = account.portalUrl ?? "https://accounts.opensoftware.co";
  const handle = account.user?.handle;
  const pastDue = account.subscription?.status === "past_due";

  useEffect(() => {
    const interval = window.setInterval(() => {
      void onRefresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [onRefresh]);

  async function handleRefresh() {
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-card">
        <h1 className="welcome-title">
          {pastDue ? "Payment needed" : "Start your free trial"}
        </h1>
        <p className="welcome-subtitle">
          {pastDue
            ? "Your subscription payment didn't go through. Update your billing details to keep using June."
            : "June runs on your OpenSoftware account. Start the free trial in your account portal — no charge until the trial ends."}
        </p>

        <div className="welcome-providers">
          <a
            className="primary-action"
            href={portalUrl}
            target="_blank"
            rel="noreferrer"
          >
            {pastDue ? "Manage billing" : "Start free trial"}
          </a>
          <button
            type="button"
            className="btn btn-secondary trial-gate-refresh"
            disabled={checking}
            onClick={() => void handleRefresh()}
          >
            {checking ? "Checking…" : "I've done it — check again"}
          </button>
        </div>

        <p className="welcome-terms">
          {handle ? <>Signed in as @{handle}. </> : null}
          <button
            type="button"
            className="trial-gate-signout"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </p>
      </div>
    </div>
  );
}
