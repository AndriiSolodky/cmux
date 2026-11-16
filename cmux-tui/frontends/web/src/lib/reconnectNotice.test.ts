import { describe, expect, it } from "vitest";
import { reconnectNoticeVisible } from "./reconnectNotice";

describe("reconnect notice", () => {
  it("keeps a short reconnect quiet", () => {
    expect(reconnectNoticeVisible(true, 9_999)).toBe(false);
  });

  it("shows the actionable notice only after the bounded outage", () => {
    expect(reconnectNoticeVisible(true, 10_000)).toBe(true);
    expect(reconnectNoticeVisible(false, 60_000)).toBe(false);
  });
});
