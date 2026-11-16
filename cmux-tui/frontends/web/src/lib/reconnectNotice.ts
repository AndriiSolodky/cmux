export const RECONNECT_NOTICE_DELAY_MS = 10_000;

/** Keep automatic reconnects silent until the outage needs a person's help. */
export function reconnectNoticeVisible(reconnecting: boolean, elapsedMs: number): boolean {
  return reconnecting && elapsedMs >= RECONNECT_NOTICE_DELAY_MS;
}
