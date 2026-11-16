import { useEffect, useState } from "react";
import { t } from "../i18n";

const RECONNECT_NOTICE_DELAY_MS = 10_000;

export function ReconnectNotice({ reconnecting, onRetry }: { reconnecting: boolean; onRetry(): void }) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!reconnecting) return;
    // One timer for the whole outage, independent of individual retry attempts.
    const timer = setTimeout(() => setExpired(true), RECONNECT_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [reconnecting]);
  if (!reconnecting || !expired) return null;
  return (
    <div className="reconnect-banner" role="status">
      <span>{t("reconnectFailed")}</span>
      <button type="button" onClick={onRetry}>
        {t("retryConnection")}
      </button>
    </div>
  );
}
