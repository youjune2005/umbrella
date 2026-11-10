/**
 * 웹 ↔ 아두이노 이벤트/명령 매칭 시뮬레이션 (보드 없이 프로토콜 검증)
 */
import {
  commandAction,
  isRentDoorClosed,
  isReturnDetected,
  isReturnDoorClosed,
  liveStationCode,
  pickMatchingEvent,
  eventTimeOk,
} from "../public/js/device-protocol.js";

const stations = [
  { code: "A1", live: true },
  { code: "C3", live: false },
];

let failed = 0;
function assert(name, cond) {
  if (cond) console.log("  ok ", name);
  else {
    failed += 1;
    console.error("  FAIL", name);
  }
}

console.log("[sim] device protocol");
assert("live station is A1", liveStationCode(stations) === "A1");
assert("rent command is open", commandAction(false) === "open");
assert("return command is open_return", commandAction(true) === "open_return");

assert("rent close auto_close", isRentDoorClosed({ kind: "servo", payload: { action: "auto_close" } }));
assert("rent close timeout", isRentDoorClosed({ kind: "servo", payload: { action: "auto_close_timeout" } }));
assert("rent close does not match return", !isRentDoorClosed({ kind: "servo", payload: { action: "auto_close_return" } }));
assert("return detect", isReturnDetected({ kind: "return_ok" }));
assert("return close", isReturnDoorClosed({ kind: "servo", payload: { action: "auto_close_return" } }));
assert("return close timeout", isReturnDoorClosed({ kind: "servo", payload: { action: "auto_close_return_timeout" } }));

const now = Date.now();
const rows = [
  { station: "A1", slot: 1, kind: "servo", payload: { action: "open" }, created_at: now - 2000 },
  { station: "A1", slot: 1, kind: "return_ok", payload: { source: "ir" }, created_at: now - 1000 },
  { station: "A1", slot: 1, kind: "servo", payload: { action: "auto_close_return" }, created_at: now },
  { station: "A1", slot: 2, kind: "servo", payload: { action: "auto_close" }, created_at: now },
];
assert(
  "pick return close for slot 1",
  pickMatchingEvent(rows, { station: "A1", slot: 1, since: now - 5000, match: isReturnDoorClosed })
    ?.payload.action === "auto_close_return"
);
assert(
  "pick rent close for slot 2",
  pickMatchingEvent(rows, { station: "A1", slot: 2, since: now - 5000, match: isRentDoorClosed })
    ?.payload.action === "auto_close"
);
assert("zero created_at still matches", eventTimeOk({ created_at: 0 }, now));
assert("old event filtered", !eventTimeOk({ created_at: now - 60000 }, now));

if (failed) {
  console.error(`[sim] ${failed} failed`);
  process.exit(1);
}
console.log("[sim] all passed");
