/** 브리지 폴링이 겹치는지, 타임아웃을 성공으로 볼지 판별. 시리얼 없이 테스트한다. */

function createPollGate() {
  let busy = false;
  return {
    tryEnter() {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave() {
      busy = false;
    },
    get busy() {
      return busy;
    },
  };
}

/** mcu ACK 와 응답 없음(unknown)을 구분. unknown 도 재전송은 막지만 성공이 아니다. */
function dispatchOutcome(reason) {
  if (reason === "mcu" || reason === "sense_ir" || reason === "test_open" || reason === "test_close") {
    return "ack";
  }
  if (reason === "timeout") return "unknown";
  return "failed";
}

module.exports = { createPollGate, dispatchOutcome };
