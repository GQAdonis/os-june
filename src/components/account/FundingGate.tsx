import { useEffect, useState } from "react";
import { hasLiveSubscription, isOnMaxPlan } from "../../lib/account-gate";
import {
  MAX_UPGRADE_BUSY_LABEL,
  MAX_UPGRADE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_LABEL,
  MAX_UPGRADE_CONFIRM_TITLE,
  MAX_UPGRADE_READY_STATUS,
  MAX_UPGRADE_WAITING_STATUS,
} from "../../lib/max-upgrade";
import { osAccountsOpenPortal, osAccountsUpgrade } from "../../lib/tauri";
import type { AccountStatus, SubscriptionPlan } from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Spinner } from "../ui/Spinner";
import { JuneMark } from "./AccountGate";

type Props = {
  account: AccountStatus;
  onRefresh: () => Promise<AccountStatus | undefined>;
  onSignOut: () => void;
};

const POLL_INTERVAL_MS = 10_000;

type GateCopy = {
  title: string;
  subtitle: string;
  cta: string;
  /** Copy for the waiting-on-the-browser panel. */
  waiting?: string;
  reopen?: string;
};

export function FundingGate({ account, onRefresh, onSignOut }: Props) {
  const [openedBillingPage, setOpenedBillingPage] = useState(false);
  const [checking, setChecking] = useState(false);
  // Max checkout only opens from an explicit confirm dialog.
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);
  const [confirmError, setConfirmError] = useState<string>();
  // Opening checkout is not proof of an upgrade. Stay neutral until a
  // refreshed OS Accounts snapshot reports Max.
  const [awaitingMaxConfirmation, setAwaitingMaxConfirmation] = useState(false);
  const [billingStatus, setBillingStatus] = useState<string>();
  // Remembered so "Reopen checkout" lands on the same plan the user picked.
  const [chosenPlan, setChosenPlan] = useState<SubscriptionPlan>("pro");
  const handle = account.user?.handle;
  const status = account.subscription?.status;
  const subscribed = account.subscription?.subscribed === true;
  const credits = account.balance?.credits;
  const negativeBalance = typeof credits === "number" && credits < 0;
  const billingRecovery =
    subscribed && typeof status === "string" && status.length > 0 && !hasLiveSubscription(account);
  const topUpRequired = subscribed && !billingRecovery && negativeBalance;
  // Only Max may buy credits. A depleted Pro subscriber's one path is hosted
  // Max checkout; a depleted Max subscriber tops up through the portal.
  const proUpgradeRequired = topUpRequired && !isOnMaxPlan(account);
  const maxTopUpRequired = topUpRequired && isOnMaxPlan(account);

  const copy: GateCopy = billingRecovery
    ? {
        title: "Update billing",
        subtitle: "Your payment needs attention. Update billing to keep using June.",
        cta: "Manage billing",
        waiting: "Waiting for your billing update",
        reopen: "Reopen billing",
      }
    : proUpgradeRequired
      ? {
          title: "Upgrade to Max",
          subtitle:
            "You have used your Pro credits for this cycle. Upgrade to Max for 5x the monthly usage.",
          cta: "Upgrade to Max",
        }
      : maxTopUpRequired
        ? {
            title: "Top up credits",
            subtitle: "Your credit balance is below zero. Top up credits to keep using June.",
            cta: "Top up credits",
            waiting: "Waiting for your top-up",
            reopen: "Reopen account portal",
          }
        : {
            title: "Upgrade to continue",
            subtitle:
              "Your starter credits are used up. Upgrade to a paid plan to keep using June.",
            cta: "Upgrade to Pro",
            waiting: "Waiting for your upgrade",
            reopen: "Reopen checkout",
          };
  // The Max upsell link only belongs on the Free/subscribe path; a depleted Pro
  // user already has exactly one path (upgrade to Max), and depleted Max users
  // top up. Neither shows a second affordance.
  const offerMaxPlan = !billingRecovery && !topUpRequired;

  useEffect(() => {
    const interval = window.setInterval(() => {
      void onRefresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [onRefresh]);

  useEffect(() => {
    if (!awaitingMaxConfirmation || !isOnMaxPlan(account)) return;
    // Match App's checkout confirmation mechanism: only the refreshed account
    // snapshot may turn neutral waiting copy into success copy.
    setAwaitingMaxConfirmation(false);
    setBillingStatus(MAX_UPGRADE_READY_STATUS);
  }, [account, awaitingMaxConfirmation]);

  async function handleOpenBillingPage(plan: SubscriptionPlan = chosenPlan) {
    setBillingStatus(undefined);
    try {
      if (billingRecovery || maxTopUpRequired) {
        await osAccountsOpenPortal();
      } else {
        setChosenPlan(plan);
        await osAccountsUpgrade(plan);
      }
      setOpenedBillingPage(true);
    } catch (error) {
      setBillingStatus(messageFromError(error));
    }
  }

  // Hosted Pro -> Max checkout, run from the confirm dialog only. Opening the
  // browser enters a neutral waiting state; refreshed OS Accounts status is
  // the only authority for announcing Max. Real failures rethrow so the
  // dialog stays open showing the error next to its retry affordance.
  async function handleUpgradeToMax() {
    try {
      await osAccountsUpgrade("max");
    } catch (error) {
      setConfirmError(messageFromError(error));
      throw error;
    }
    setChosenPlan("max");
    setAwaitingMaxConfirmation(true);
  }

  async function handleCheckNow() {
    setChecking(true);
    try {
      await onRefresh();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="welcome-screen">
      <div className="welcome-card wide-card">
        <span className="welcome-mark" aria-hidden>
          <JuneMark />
        </span>
        <h1 className="welcome-title">{copy.title}</h1>
        <p className="welcome-subtitle">{copy.subtitle}</p>

        <div className="welcome-providers">
          {awaitingMaxConfirmation ? (
            <>
              <div className="welcome-auth-progress" role="status" aria-live="polite">
                <span className="welcome-progress-label">
                  <Spinner className="welcome-spinner" aria-hidden />
                  <span>{MAX_UPGRADE_WAITING_STATUS}</span>
                </span>
                <button
                  type="button"
                  className="welcome-cancel-btn"
                  disabled={checking}
                  onClick={() => void handleCheckNow()}
                >
                  {checking ? "Checking..." : "Check again"}
                </button>
              </div>
              <p className="funding-hint">
                Nothing happening?{" "}
                <button
                  type="button"
                  className="funding-gate-link"
                  onClick={() => void handleOpenBillingPage("max")}
                >
                  Reopen checkout
                </button>
              </p>
            </>
          ) : proUpgradeRequired ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                setConfirmError(undefined);
                setConfirmingUpgrade(true);
              }}
            >
              {copy.cta}
            </button>
          ) : openedBillingPage ? (
            <>
              <div className="welcome-auth-progress" role="status" aria-live="polite">
                <span className="welcome-progress-label">
                  <Spinner className="welcome-spinner" aria-hidden />
                  <span>{copy.waiting}</span>
                </span>
                <button
                  type="button"
                  className="welcome-cancel-btn"
                  disabled={checking}
                  onClick={() => void handleCheckNow()}
                >
                  {checking ? "Checking..." : "Check again"}
                </button>
              </div>
              <p className="funding-hint">
                Nothing happening?{" "}
                <button
                  type="button"
                  className="funding-gate-link"
                  onClick={() => void handleOpenBillingPage()}
                >
                  {copy.reopen}
                </button>
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                className="primary-action"
                onClick={() => void handleOpenBillingPage(offerMaxPlan ? "pro" : chosenPlan)}
              >
                {copy.cta}
              </button>
              {offerMaxPlan ? (
                <p className="funding-hint">
                  Want to go beyond Pro?{" "}
                  <button
                    type="button"
                    className="funding-gate-link"
                    onClick={() => void handleOpenBillingPage("max")}
                  >
                    Upgrade to Max
                  </button>
                </p>
              ) : null}
            </>
          )}
        </div>

        {billingStatus ? <p className="welcome-status">{billingStatus}</p> : null}

        <p className="welcome-terms">
          {handle ? <>Signed in as @{handle}. </> : null}
          <button type="button" className="funding-gate-link" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      </div>
      <ConfirmDialog
        open={confirmingUpgrade}
        onClose={() => setConfirmingUpgrade(false)}
        onConfirm={handleUpgradeToMax}
        title={MAX_UPGRADE_CONFIRM_TITLE}
        description={confirmError ?? MAX_UPGRADE_CONFIRM_BODY}
        confirmLabel={MAX_UPGRADE_CONFIRM_LABEL}
        confirmBusyLabel={MAX_UPGRADE_BUSY_LABEL}
      />
    </div>
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
