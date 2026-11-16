import { useEffect, useState } from "react";
import { t } from "../i18n";

const RECONNECT_NOTICE_DELAY_MS = 10_000;

export function ReconnectNotice({
  reconnecting,
  needsAction = false,
  onRetry,
}: {
  reconnecting: boolean;
  needsAction?: boolean;
  onRetry(): void;
}) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (needsAction || !reconnecting) {
      if (needsAction) setExpired(true);
      return;
    }
    // One timer for the whole outage, independent of individual retry attempts.
    const timer = setTimeout(() => setExpired(true), RECONNECT_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [needsAction, reconnecting]);
  if ((!reconnecting && !needsAction) || !expired) return null;
  return (
    <div className="reconnect-banner" role="status">
      <span>{t("reconnectFailed")}</span>
      <button type="button" onClick={onRetry}>
        {t("retryConnection")}
      </button>
    </div>
  );
}
