/**
 * 웹앱 ↔ 아두이노(브리지) 문 열림/닫힘 프로토콜.
 * 보드가 올리는 device_events.kind / payload.action 과 맞춰야 한다.
 *
 *  commands.action  : open | open_return
 *  events.kind      : servo | rfid | return_ok
 *  servo.action     : open | open_return | auto_close | auto_close_timeout
 *                     auto_close_return | auto_close_return_timeout
 */
export const EVENT_SINCE_SLACK_MS = 8000;

export function liveStationCode(stations) {
  const s = (stations || []).find((x) => x.live);
  return (s && s.code) || "A1";
}

export function commandAction(isReturn) {
  return isReturn ? "open_return" : "open";
}

export function servoActionOf(ev) {
  return String((ev && ev.payload && ev.payload.action) || "");
}

export function eventTimeOk(row, sinceMs) {
  const ts = Number(row && row.created_at);
  // 보드 시계가 없으면 0 — since 필터를 건너뛴다
  if (!ts || ts < 1e11) return true;
  return ts >= Number(sinceMs || 0) - EVENT_SINCE_SLACK_MS;
}

export function isRentDoorClosed(ev) {
  if (!ev || ev.kind !== "servo") return false;
  return /^(auto_close|auto_close_timeout)$/i.test(servoActionOf(ev));
}

export function isReturnDetected(ev) {
  return !!(ev && ev.kind === "return_ok");
}

export function isReturnDoorClosed(ev) {
  if (!ev || ev.kind !== "servo") return false;
  return /auto_close_return/i.test(servoActionOf(ev));
}

export function pickMatchingEvent(rows, { station, slot, since = 0, match } = {}) {
  for (const row of rows || []) {
    if (String(row.station) !== String(station)) continue;
    if (Number(row.slot) !== Number(slot)) continue;
    if (!eventTimeOk(row, since)) continue;
    if (typeof match === "function" && !match(row)) continue;
    return row;
  }
  return null;
}
