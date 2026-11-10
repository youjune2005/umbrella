/*
  Umbrella Locker — Arduino UNO R4 WiFi (슬롯 1·2)

  문은 "명령"으로만 열린다 (웹앱 대여/반납 → Firestore `commands`).
    open         대여. IR로 우산이 사라지면 잠시 후 자동 닫힘
    open_return  반납. RFID+IR(또는 IR만 5초)로 우산을 확인하면 잠시 후 자동 닫힘
  보드는 진행 상황을 `device_events` 로 올리고(open / rfid / return_ok / auto_close…)
  웹앱은 그 이벤트를 보고 문 닫힘 애니메이션·화면 전환을 맞춘다.

  통신 (유선이 우선)
    1) USB 브리지 : PC `npm run bridge:firebase` → 시리얼 PING / OPEN / OPEN_RETURN
    2) WiFi       : Firebase Auth + Firestore REST 직접 폴링 (PC 불필요)

  시리얼 프로토콜 (9600, 줄 단위)
    PC → MCU : PING | OPEN <slot> | OPEN_RETURN <slot>
    MCU → PC : PONG | ACK/DONE OPEN[_RETURN] <slot> | ERR …
               EVENT RFID <slot> <uid> | EVENT RETURN_OK <slot> | EVENT SERVO <slot> <action>

  핀: RFID1 SS D10 / RST D9, RFID2 SS D8 / RST D7, Servo D5 / D6, IR D2 / D3
  업로드 전 WIFI_* 와 STATION_CODE 를 현장 값으로 바꾸세요.
  FB_API_KEY 는 보드 전용 API 키 (웹 Browser key 와 다름, 리퍼러 제한 없음).
  DEVICE_PASS 는 Firebase Auth(device@…) 비밀번호와 같게.
*/

#include <SPI.h>
#include <MFRC522.h>
#include <Servo.h>
#include <WiFiS3.h>
#include <WiFiSSLClient.h>

// ========== 사용자 설정 ==========
const char* WIFI_SSID    = "ASCEE";
const char* WIFI_PASS    = "a028287138";
const char* FB_API_KEY   = "AIzaSyAEBkaVsNmojtkwePnQMISElzPNK4nY1ZE";
const char* FB_PROJECT   = "umbrella-c8cf0";
const char* DEVICE_EMAIL = "device@umbrella.local";
const char* DEVICE_PASS  = "device-change-me";
const char* STATION_CODE = "A1";   // 웹앱 STATIONS 중 live 거점 (형남공학관 2층 입구 · QR A7482)
const bool  ENABLE_SERVO = true;
const bool  ENABLE_WIFI  = true;   // false → USB 브리지만
// =================================

const uint8_t SS_PINS[2]    = { 10, 8 };
const uint8_t RST_PINS[2]   = { 9, 7 };
const uint8_t IR_PINS[2]    = { 2, 3 };
const uint8_t SERVO_PINS[2] = { 5, 6 };
const bool IR_ACTIVE_LOW = true;

const int DOOR_CLOSED_DEG = 0;
const int DOOR_OPEN_DEG   = 90;
const unsigned long RFID_COOLDOWN_MS     = 400;
const unsigned long IR_HOLD_MS           = 350;    // 반납: 태그 후 IR 연속 감지
const unsigned long IR_GONE_STABLE_MS    = 250;    // 대여: IR 연속 미감지
const unsigned long OPEN_PRESENT_WAIT_MS = 700;    // 대여: 처음부터 비어 있으면 꺼냄 감지로 전환
const unsigned long RETURN_IR_ONLY_MS    = 1800;   // 반납: 태그 없이 IR만 이 시간이면 인정
const unsigned long AUTO_CLOSE_DELAY_MS  = 300;    // 감지 후 닫기까지 대기
const unsigned long OPEN_MAX_MS          = 25000;  // 안전: 강제 닫힘
const unsigned long POLL_MS              = 350;    // 명령 폴링 (keep-alive 전제)
const unsigned long PRESENCE_MS          = 12000;  // 평소 하트비트. IR 변화는 따로
const unsigned long PRESENCE_BUSY_MS     = 8000;   // 문 감시 중 하트비트
const unsigned long IR_REPORT_MIN_MS     = 80;     // IR 엣지 디바운스
const unsigned long WIFI_RETRY_MS        = 10000;
const unsigned long WIRED_TIMEOUT_MS     = 5000;
const unsigned long TOKEN_REFRESH_MS     = 50UL * 60UL * 1000UL;
// 1시간 이내(시계 수 분 오차 포함)만 실행. 그보다 오래면 문 안 열고 done 만.
const unsigned long CMD_MAX_AGE_S        = 3600UL;
const int HTTP_BODY_MAX = 6000;

enum DoorState : uint8_t {
  DOOR_IDLE = 0,
  RENT_WAIT_PRESENT,  // 대여: 우산이 보이는지 확인
  RENT_WAIT_GONE,     // 대여: 우산이 사라질 때까지
  RENT_WAIT_DELAY,    // 대여: 사라진 뒤 닫기 전 대기
  RET_WAIT_DETECT,    // 반납: RFID + IR
  RET_WAIT_DELAY,     // 반납: 인식 후 닫기 전 대기
};

struct Slot {
  uint8_t id = 0;
  MFRC522 rfid;
  Servo servo;
  int angle = DOOR_CLOSED_DEG;
  unsigned long lastTagMs = 0;
  DoorState door = DOOR_IDLE;
  unsigned long stateAt = 0;   // 현재 상태 진입 시각
  unsigned long openedAt = 0;  // 문 연 시각 (OPEN_MAX)
  unsigned long irSince = 0;   // IR 연속 감지/미감지 시작
  bool rfidOk = false;
  unsigned long senseRfidUntil = 0; // device 테스트: 카드 대기 만료 시각
  String cmd;                  // 문을 연 명령 id (이벤트에 첨부)
};

Slot slots[2];
WiFiSSLClient ssl;

bool wiredMode = false;
unsigned long lastPingMs = 0;
unsigned long lastPollMs = 0;
unsigned long lastPresenceMs = 0;
unsigned long lastIrReportMs = 0;
unsigned long lastWifiTryMs = 0;
unsigned long tokenAtMs = 0;
String idToken;
int lastHttpStatus = 0;
String serialBuf;
String lastCmdId;            // 같은 명령 재실행 방지 (done PATCH 실패 시 재시도만)
bool netReadyOnce = false;
bool lastIr1 = false;
bool lastIr2 = false;
bool irEdgeInit = false;
bool presenceDirty = false;  // IR 변화 → 다음 여유 때 presence PATCH (명령보다 후순위)

// HTTP Date / NTP 로 맞춘 UTC 시계 (이벤트 created_at)
unsigned long clockEpochSec = 0;
unsigned long clockAtMs = 0;

// ---------- 시계 ----------
void setClock(unsigned long epochSec) {
  clockEpochSec = epochSec;
  clockAtMs = millis();
}

unsigned long nowEpochSec() {
  if (clockEpochSec) return clockEpochSec + (millis() - clockAtMs) / 1000;
  unsigned long t = WiFi.getTime();
  if (t > 1700000000UL) { setClock(t); return t; }
  return 0;
}

String epochMsString() {
  unsigned long sec = nowEpochSec();
  if (!sec) {
    unsigned long t = WiFi.getTime();
    if (t > 1700000000UL) { setClock(t); sec = t; }
  }
  if (!sec) return "0";
  unsigned long d = millis() - clockAtMs;
  char tail[4];
  snprintf(tail, sizeof tail, "%03u", (unsigned)(d % 1000));
  return String(sec) + tail;
}

/** "Tue, 04 Nov 2026 03:12:45 GMT" → UTC epoch 초 (실패 0) */
unsigned long parseHttpDate(String v) {
  int comma = v.indexOf(',');
  if (comma >= 0) v = v.substring(comma + 1);
  v.trim();
  int d, y, hh, mm, ss;
  char mon[4] = { 0 };
  if (sscanf(v.c_str(), "%d %3s %d %d:%d:%d", &d, mon, &y, &hh, &mm, &ss) != 6) return 0;
  const char* names = "JanFebMarAprMayJunJulAugSepOctNovDec";
  const char* p = strstr(names, mon);
  if (!p) return 0;
  int m = (p - names) / 3 + 1;
  y -= m <= 2;                                    // days_from_civil (H. Hinnant)
  long era = (y >= 0 ? y : y - 399) / 400;
  unsigned yoe = (unsigned)(y - era * 400);
  unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long days = era * 146097 + (long)doe - 719468;
  return (unsigned long)days * 86400UL + (unsigned long)hh * 3600UL + mm * 60UL + ss;
}

// ---------- 하드웨어 ----------
bool irPresent(const Slot& s) {
  int v = digitalRead(IR_PINS[s.id - 1]);
  return IR_ACTIVE_LOW ? (v == LOW) : (v == HIGH);
}

Slot* slotByNo(int n) {
  return (n == 1 || n == 2) ? &slots[n - 1] : nullptr;
}

void recoverRfid() {
  for (Slot& s : slots) s.rfid.PCD_Init();
}

String uidToString(const MFRC522::Uid& uid) {
  String s;
  for (byte i = 0; i < uid.size; i++) {
    if (uid.uidByte[i] < 0x10) s += "0";
    s += String(uid.uidByte[i], HEX);
    if (i + 1 < uid.size) s += ":";
  }
  s.toUpperCase();
  return s;
}

void moveDoor(Slot& s, int target) {
  if (s.angle == target) return;
  Serial.print("[SERVO] slot "); Serial.print(s.id);
  Serial.print(" "); Serial.print(s.angle); Serial.print(" -> "); Serial.println(target);
  s.angle = target;
  if (ENABLE_SERVO) s.servo.write(target);
}

void openDoor(Slot& s) {
  moveDoor(s, DOOR_OPEN_DEG);
  recoverRfid();
}

void closeDoor(Slot& s) {
  moveDoor(s, DOOR_CLOSED_DEG);
  recoverRfid();
}

// ---------- 링크 ----------
bool isWired() {
  return wiredMode && (millis() - lastPingMs < WIRED_TIMEOUT_MS);
}

void updateLinkMode() {
  static bool prev = false;
  bool now = isWired();
  if (now == prev) return;
  prev = now;
  Serial.println(now ? "[LINK] WIRED (USB bridge)" : "[LINK] WIFI (Firestore)");
}

// ---------- 이벤트 ----------
void reportEventFirebase(const Slot& s, const char* kind, const String& extra);
void reportSenseIr(Slot& s);
void startSenseRfid(Slot& s);

void reportEvent(const Slot& s, const char* kind, const String& extra) {
  if (!isWired()) { reportEventFirebase(s, kind, extra); return; }
  if (strcmp(kind, "rfid") == 0) {
    Serial.print("EVENT RFID "); Serial.print(s.id); Serial.print(" "); Serial.println(extra);
  } else if (strcmp(kind, "return_ok") == 0) {
    Serial.print("EVENT RETURN_OK "); Serial.println(s.id);
  } else {
    Serial.print("EVENT SERVO "); Serial.print(s.id); Serial.print(" "); Serial.println(extra);
  }
}

// ---------- 문 감시 (자동 닫힘) ----------
void startWatch(Slot& s, bool isReturn) {
  s.door = isReturn ? RET_WAIT_DETECT : RENT_WAIT_PRESENT;
  s.stateAt = s.openedAt = millis();
  s.irSince = 0;
  s.rfidOk = false;
  Serial.print(isReturn ? "[DOOR] return-watch slot " : "[DOOR] rent-watch slot ");
  Serial.println(s.id);
}

void finishWatch(Slot& s, const char* action) {
  Serial.print("[DOOR] "); Serial.print(action); Serial.print(" slot "); Serial.println(s.id);
  closeDoor(s);
  reportEvent(s, "servo", action);
  s.door = DOOR_IDLE;
  s.cmd = "";
}

void updateWatch(Slot& s) {
  if (s.door == DOOR_IDLE) return;
  const unsigned long now = millis();
  const bool present = irPresent(s);
  const bool isReturn = s.door >= RET_WAIT_DETECT;

  if (now - s.openedAt >= OPEN_MAX_MS) {
    finishWatch(s, isReturn ? "auto_close_return_timeout" : "auto_close_timeout");
    return;
  }

  switch (s.door) {
    case RET_WAIT_DETECT: {
      if (!present) { s.irSince = 0; return; }
      if (!s.irSince) s.irSince = now;
      const unsigned long held = now - s.irSince;
      const bool byTag = s.rfidOk && held >= IR_HOLD_MS;
      const bool byIrOnly = held >= RETURN_IR_ONLY_MS;
      if (!byTag && !byIrOnly) return;
      Serial.print("[DOOR] return detected slot "); Serial.println(s.id);
      reportEvent(s, "return_ok", byTag ? "rfid_ir" : "ir");
      s.door = RET_WAIT_DELAY;
      s.stateAt = now;
      return;
    }
    case RET_WAIT_DELAY:
      if (now - s.stateAt >= AUTO_CLOSE_DELAY_MS) finishWatch(s, "auto_close_return");
      return;

    case RENT_WAIT_PRESENT:
      if (present) {
        Serial.print("[DOOR] umbrella present slot "); Serial.println(s.id);
        s.door = RENT_WAIT_GONE;
        s.irSince = 0;
      } else if (now - s.stateAt >= OPEN_PRESENT_WAIT_MS) {
        Serial.print("[DOOR] already empty slot "); Serial.println(s.id);
        s.door = RENT_WAIT_GONE;
        s.irSince = now;
      }
      return;
    case RENT_WAIT_GONE:
      if (present) { s.irSince = 0; return; }
      if (!s.irSince) s.irSince = now;
      if (now - s.irSince >= IR_GONE_STABLE_MS) {
        Serial.print("[DOOR] umbrella gone slot "); Serial.println(s.id);
        s.door = RENT_WAIT_DELAY;
        s.stateAt = now;
      }
      return;
    case RENT_WAIT_DELAY:
      if (present) {               // 다시 넣음 → 꺼냄 대기로 복귀
        s.door = RENT_WAIT_GONE;
        s.irSince = 0;
        return;
      }
      if (now - s.stateAt >= AUTO_CLOSE_DELAY_MS) finishWatch(s, "auto_close");
      return;
    default:
      return;
  }
}

/** RFID: 반납 감시 또는 device 테스트(sense_rfid) 대기 중일 때 이벤트 전송 */
void handleReader(Slot& s) {
  if (s.senseRfidUntil && millis() > s.senseRfidUntil) {
    Serial.print("[RFID] sense timeout slot "); Serial.println(s.id);
    s.senseRfidUntil = 0;
  }
  if (!s.rfid.PICC_IsNewCardPresent() || !s.rfid.PICC_ReadCardSerial()) return;
  String uid = uidToString(s.rfid.uid);
  s.rfid.PICC_HaltA();
  s.rfid.PCD_StopCrypto1();
  if (millis() - s.lastTagMs < RFID_COOLDOWN_MS) return;
  s.lastTagMs = millis();
  Serial.print("[RFID] slot "); Serial.print(s.id); Serial.print(" UID="); Serial.println(uid);
  if (s.door == RET_WAIT_DETECT && !s.rfidOk) {
    s.rfidOk = true;
    reportEvent(s, "rfid", uid);   // 반납 우산 태그 → umbrellas.tag_uid
  } else if (s.senseRfidUntil && millis() <= s.senseRfidUntil) {
    s.senseRfidUntil = 0;
    reportEvent(s, "rfid", uid);   // device 테스트
  }
}

/** 장치 테스트 전용. 대여/반납 감시는 시작하지 않는다. */
void testServo(Slot& s, bool opening, const String& cmdId) {
  s.door = DOOR_IDLE;
  s.cmd = cmdId;
  s.irSince = 0;
  s.rfidOk = false;
  if (opening) openDoor(s);
  else closeDoor(s);
  presenceDirty = true;
  reportEvent(s, "servo", opening ? "test_open" : "test_close");
}

void executeCommand(Slot& s, bool isReturn, const String& cmdId) {
  s.cmd = cmdId;
  // 서보 먼저 — HTTPS(이벤트/presence)는 문 연 뒤에만
  openDoor(s);
  startWatch(s, isReturn);
  presenceDirty = true;
  reportEvent(s, "servo", isReturn ? "open_return" : "open");
}

// ---------- 시리얼 (USB 브리지) ----------
void handleSerialLine(String line) {
  line.trim();
  if (!line.length()) return;
  if (line == "PING") {
    lastPingMs = millis();
    wiredMode = true;
    Serial.println("PONG");
    return;
  }
  if (line.startsWith("SENSE_IR ")) {
    const int slotNo = line.substring(9).toInt();
    Slot* s = slotByNo(slotNo);
    if (!s) { Serial.println("ERR SENSE_IR bad slot"); return; }
    lastPingMs = millis();
    wiredMode = true;
    reportSenseIr(*s);
    return;
  }
  if (line.startsWith("SENSE_RFID ")) {
    const int slotNo = line.substring(11).toInt();
    Slot* s = slotByNo(slotNo);
    if (!s) { Serial.println("ERR SENSE_RFID bad slot"); return; }
    lastPingMs = millis();
    wiredMode = true;
    startSenseRfid(*s);
    Serial.print("ACK SENSE_RFID "); Serial.println(slotNo);
    return;
  }
  if (line.startsWith("TEST_OPEN ") || line.startsWith("TEST_CLOSE ")) {
    const bool opening = line.startsWith("TEST_OPEN ");
    const int slotNo = line.substring(opening ? 10 : 11).toInt();
    Slot* s = slotByNo(slotNo);
    if (!s) { Serial.println(opening ? "ERR TEST_OPEN bad slot" : "ERR TEST_CLOSE bad slot"); return; }
    lastPingMs = millis();
    wiredMode = true;
    Serial.print("ACK "); Serial.println(opening ? "TEST_OPEN" : "TEST_CLOSE");
    testServo(*s, opening, "");
    Serial.print("DONE "); Serial.print(opening ? "TEST_OPEN " : "TEST_CLOSE ");
    Serial.println(slotNo);
    return;
  }
  const bool isReturn = line.startsWith("OPEN_RETURN ");
  if (!isReturn && !line.startsWith("OPEN ")) return;
  const char* verb = isReturn ? "OPEN_RETURN" : "OPEN";
  const int slotNo = line.substring(isReturn ? 12 : 5).toInt();
  Slot* s = slotByNo(slotNo);
  if (!s) { Serial.print("ERR "); Serial.print(verb); Serial.println(" bad slot"); return; }
  lastPingMs = millis();
  wiredMode = true;
  Serial.print("ACK "); Serial.print(verb); Serial.print(' '); Serial.println(slotNo);
  executeCommand(*s, isReturn, "");   // 유선: 명령 id는 브리지가 이벤트에 붙임
  Serial.print("DONE "); Serial.print(verb); Serial.print(' '); Serial.println(slotNo);
}

void pollSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBuf.length()) { handleSerialLine(serialBuf); serialBuf = ""; }
    } else {
      serialBuf += c;
      if (serialBuf.length() > 80) serialBuf = "";
    }
  }
}

// ---------- JSON 헬퍼 (Firestore REST) ----------
/** "key": "value" (탑레벨 문자열) */
String jsonString(const String& json, const char* key, int from = 0) {
  String k = String("\"") + key + "\"";
  int i = json.indexOf(k, from);
  if (i < 0) return "";
  i = json.indexOf(':', i + k.length());
  if (i < 0) return "";
  i = json.indexOf('"', i);
  if (i < 0) return "";
  int j = ++i;
  while (j < (int)json.length() && !(json[j] == '"' && json[j - 1] != '\\')) j++;
  if (j >= (int)json.length()) return "";   // 잘린 응답
  return json.substring(i, j);
}

/** "field": { "typeKey": "value" } — from~to 범위 안에서만 */
String fieldValue(const String& json, const char* field, const char* typeKey, int from, int to) {
  String needle = String("\"") + field + "\"";
  int i = json.indexOf(needle, from);
  if (i < 0 || (to > 0 && i > to)) return "";
  String tk = String("\"") + typeKey + "\":";
  int v = json.indexOf(tk, i);
  if (v < 0 || v - i > 80) return "";
  v += tk.length();
  while (v < (int)json.length() && (json[v] == ' ' || json[v] == '"')) v++;
  int e = v;
  while (e < (int)json.length() && json[e] != '"' && json[e] != ',' && json[e] != '}' && json[e] != '\n') e++;
  String out = json.substring(v, e);
  out.trim();
  return out;
}

/** ms 문자열("1762225965123") → 초 */
unsigned long msStringToSec(const String& ms) {
  if (ms.length() <= 3) return 0;
  return (unsigned long)ms.substring(0, ms.length() - 3).toInt();
}

// ---------- 네트워크 ----------
bool wifiConfigured() {
  return strlen(WIFI_SSID) > 0 && strcmp(WIFI_SSID, "YOUR_SSID") != 0;
}

/** DNS/NTP 준비 — 시각이 1970이면 TLS 검증이 실패하는 펌웨어가 있어 한 번 대기 */
bool waitForNetworkReady() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (WiFi.localIP() == IPAddress(0, 0, 0, 0)) {
    Serial.println("[NET] IP 0.0.0.0 — DHCP/2.4GHz 확인");
    return false;
  }
  if (netReadyOnce) return true;

  IPAddress dnsIp;
  unsigned long start = millis();
  while (WiFi.hostByName("identitytoolkit.googleapis.com", dnsIp) != 1) {
    if (millis() - start > 20000) {
      Serial.println("[NET] DNS fail — 인터넷/방화벽 확인");
      return false;
    }
    delay(500);
  }
  Serial.print("[NET] DNS OK "); Serial.println(dnsIp);

  start = millis();
  while (millis() - start < 8000) {
    if (nowEpochSec()) { Serial.println("[NET] NTP OK"); break; }
    delay(500);
  }
  if (!clockEpochSec) Serial.println("[NET] NTP 미동기(경고) — HTTP Date 로 시계 보정");
  netReadyOnce = true;
  return true;
}

void ensureWifi() {
  if (!ENABLE_WIFI || WiFi.status() == WL_CONNECTED) return;
  if (!wifiConfigured()) {
    static bool warned = false;
    if (!warned) { warned = true; Serial.println("[WIFI] SSID 미설정 — 유선(bridge)만 사용 가능"); }
    return;
  }
  if (millis() - lastWifiTryMs < WIFI_RETRY_MS) return;
  lastWifiTryMs = millis();

  Serial.print("[WIFI] connect "); Serial.println(WIFI_SSID);
  netReadyOnce = false;
  WiFi.disconnect();
  delay(100);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] fail — 2.4GHz / SSID·비번 확인");
    return;
  }
  Serial.print("[WIFI] OK "); Serial.print(WiFi.localIP());
  Serial.print(" fw="); Serial.println(WiFi.firmwareVersion());
  waitForNetworkReady();
}

char sslHost[40] = "";
bool sslAlive = false;

void sslDrop() {
  if (ssl.connected()) ssl.stop();
  sslAlive = false;
  sslHost[0] = 0;
}

/** 같은 호스트면 TLS 핸드셰이크를 다시 하지 않는다. 명령 지연의 대부분이 여기였다. */
bool sslEnsure(const char* host) {
  if (sslAlive && ssl.connected() && strcmp(sslHost, host) == 0) return true;
  sslDrop();
  for (int i = 0; i < 2; i++) {
    if (ssl.connect(host, 443)) {
      strncpy(sslHost, host, sizeof(sslHost) - 1);
      sslHost[sizeof(sslHost) - 1] = 0;
      sslAlive = true;
      return true;
    }
    delay(40);
  }
  Serial.print("[HTTPS] connect fail "); Serial.println(host);
  return false;
}

void readBodyBytes(String& out, long remain, unsigned long deadline) {
  char tmp[161];
  while (remain > 0 && millis() < deadline && (int)out.length() < HTTP_BODY_MAX) {
    if (!ssl.available()) {
      if (!ssl.connected()) break;
      delay(1);
      continue;
    }
    int want = 160;
    if ((long)want > remain) want = (int)remain;
    int room = HTTP_BODY_MAX - (int)out.length();
    if (want > room) want = room;
    int n = ssl.read((uint8_t*)tmp, (size_t)want);
    if (n <= 0) { delay(1); continue; }
    tmp[n] = 0;
    out += tmp;
    remain -= n;
  }
}

/** HTTPS 요청 (gzip 금지, Content-Length / chunked / close 지원). Date 헤더로 시계 보정. */
bool httpsRequest(const char* host, const char* method, const String& path,
                  const String& body, const String& bearer, String& responseOut,
                  int timeoutMs = 20000) {
  responseOut = "";
  if (!waitForNetworkReady() || !sslEnsure(host)) return false;

  ssl.print(method); ssl.print(" "); ssl.print(path); ssl.println(" HTTP/1.1");
  ssl.print("Host: "); ssl.println(host);
  ssl.println("Connection: keep-alive");
  ssl.println("Accept: application/json");
  ssl.println("Accept-Encoding: identity");
  ssl.println("User-Agent: UmbrellaLocker/2.0");
  if (bearer.length()) { ssl.print("Authorization: Bearer "); ssl.println(bearer); }
  if (body.length()) {
    ssl.println("Content-Type: application/json");
    ssl.print("Content-Length: "); ssl.println(body.length());
    ssl.println();
    ssl.print(body);
  } else {
    ssl.println();
  }
  ssl.flush();

  const unsigned long deadline = millis() + (unsigned long)timeoutMs;
  while (!ssl.available() && millis() < deadline) delay(1);
  if (!ssl.available()) {
    Serial.println("[HTTPS] no response");
    sslDrop();
    return false;
  }

  String statusLine = ssl.readStringUntil('\n');
  statusLine.trim();
  lastHttpStatus = 0;
  const int sp = statusLine.indexOf(' ');
  if (sp >= 0) lastHttpStatus = statusLine.substring(sp + 1).toInt();
  const bool ok = lastHttpStatus == 200 || lastHttpStatus == 201;

  bool chunked = false;
  bool respClose = false;
  long contentLength = -1;
  while (millis() < deadline) {
    if (!ssl.available()) {
      if (!ssl.connected()) break;
      delay(2);
      continue;
    }
    String line = ssl.readStringUntil('\n');
    line.trim();
    if (!line.length()) break;
    String low = line;
    low.toLowerCase();
    if (low.startsWith("transfer-encoding:") && low.indexOf("chunked") >= 0) chunked = true;
    else if (low.startsWith("content-length:")) contentLength = low.substring(15).toInt();
    else if (low.startsWith("connection:") && low.indexOf("close") >= 0) respClose = true;
    else if (low.startsWith("date:")) {
      unsigned long t = parseHttpDate(line.substring(5));
      if (t > 1700000000UL) setClock(t);
    }
  }

  if (chunked) {
    while (millis() < deadline && (int)responseOut.length() < HTTP_BODY_MAX) {
      String sizeLine = ssl.readStringUntil('\n');
      sizeLine.trim();
      if (!sizeLine.length()) continue;
      long n = strtol(sizeLine.c_str(), nullptr, 16);
      if (n <= 0) break;
      readBodyBytes(responseOut, n, deadline);
      ssl.readStringUntil('\n');
    }
  } else if (contentLength > 0) {
    readBodyBytes(responseOut, contentLength, deadline);
  } else {
    while (millis() < deadline) {
      while (ssl.available()) {
        int b = ssl.read();
        if (b < 0) break;
        if ((int)responseOut.length() < HTTP_BODY_MAX) responseOut += (char)b;
      }
      if (!ssl.connected() && !ssl.available()) break;
      delay(5);
    }
  }
  // 길이를 모르면 소켓을 비워 둔 채 재사용하면 다음 응답이 어긋난다
  if (respClose || !ok || (!chunked && contentLength < 0)) sslDrop();

  if (!ok) {
    Serial.print("[HTTPS] "); Serial.println(statusLine);
    Serial.print("[HTTPS] body="); Serial.println(responseOut.substring(0, 220));
  }
  return ok;
}

// ---------- Firebase ----------
String firestorePath(const String& tail) {
  return String("/v1/projects/") + FB_PROJECT + "/databases/(default)/documents" + tail;
}

bool firebaseLogin(bool force = false) {
  if (!force && idToken.length() && millis() - tokenAtMs < TOKEN_REFRESH_MS) return true;
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) return false;

  String body = String("{\"email\":\"") + DEVICE_EMAIL + "\",\"password\":\"" + DEVICE_PASS +
                "\",\"returnSecureToken\":true}";
  String resp;
  Serial.println("[AUTH] login…");
  if (!httpsRequest("identitytoolkit.googleapis.com", "POST",
                    String("/v1/accounts:signInWithPassword?key=") + FB_API_KEY, body, "", resp, 25000)) {
    Serial.println("[AUTH] fail");
    idToken = "";
    return false;
  }
  idToken = jsonString(resp, "idToken");
  if (!idToken.length()) {
    Serial.print("[AUTH] no idToken body="); Serial.println(resp.substring(0, 240));
    if (resp.indexOf("EMAIL_NOT_FOUND") >= 0 || resp.indexOf("INVALID_PASSWORD") >= 0 ||
        resp.indexOf("INVALID_LOGIN_CREDENTIALS") >= 0) {
      Serial.println("[AUTH] device 이메일/비밀번호 확인 (firebase-config.js 와 동일해야 함)");
    }
    return false;
  }
  tokenAtMs = millis();
  Serial.println("[AUTH] OK");
  return true;
}

bool firestoreWrite(const char* method, const String& path, const String& body) {
  if (!firebaseLogin()) return false;
  String resp;
  if (httpsRequest("firestore.googleapis.com", method, path, body, idToken, resp)) return true;
  // 400은 JSON 오류 — 재로그인해도 같은 본문이 또 거절되고 루프만 멈춘다
  if (lastHttpStatus != 401 && lastHttpStatus != 403) return false;
  if (!firebaseLogin(true)) return false;
  return httpsRequest("firestore.googleapis.com", method, path, body, idToken, resp);
}

bool markCommandDone(const String& docId) {
  String body = String("{\"fields\":{\"done\":{\"integerValue\":\"1\"},") +
                "\"done_at\":{\"integerValue\":\"" + epochMsString() + "\"}}}";
  bool ok = firestoreWrite("PATCH",
      firestorePath("/commands/" + docId + "?updateMask.fieldPaths=done&updateMask.fieldPaths=done_at"), body);
  Serial.println(ok ? "[CMD] done" : "[CMD] done 실패 — 다음 폴링에서 재시도");
  return ok;
}

void reportEventFirebase(const Slot& s, const char* kind, const String& extra) {
  // 각 값은 반드시 닫는다. "present":{"booleanValue":true,"source":{...}} 처럼
  // 다음 키를 값 안에 넣으면 Firestore 400 (Unknown name "source") 이 난다.
  String payload;
  if (strcmp(kind, "rfid") == 0) {
    payload = String("\"uid\":{\"stringValue\":\"") + extra + "\"}";
  } else if (strcmp(kind, "return_ok") == 0) {
    payload = String("\"via\":{\"stringValue\":\"") + extra + "\"}";
  } else {
    payload = String("\"action\":{\"stringValue\":\"") + extra + "\"},\"deg\":{\"integerValue\":\"" + String(DOOR_OPEN_DEG) + "\"}";
  }

  const String created = epochMsString();
  String body = String("{\"fields\":{") +
                "\"station\":{\"stringValue\":\"" + STATION_CODE + "\"}," +
                "\"slot\":{\"integerValue\":\"" + String(s.id) + "\"}," +
                "\"kind\":{\"stringValue\":\"" + kind + "\"}," +
                "\"payload\":{\"mapValue\":{\"fields\":{" + payload + "}}}," +
                (s.cmd.length() ? "\"cmd\":{\"stringValue\":\"" + s.cmd + "\"}," : String("")) +
                "\"created_at\":{\"integerValue\":\"" + created + "\"}}}";
  firestoreWrite("POST", firestorePath("/device_events"), body);

  if (strcmp(kind, "rfid") == 0 && extra.length()) {
    String uid = extra;
    uid.replace(":", "");
    String ubody = String("{\"fields\":{\"tag_uid\":{\"stringValue\":\"") + uid + "\"}," +
                   "\"updated_at\":{\"integerValue\":\"" + created + "\"}}}";
    firestoreWrite("PATCH", firestorePath(String("/umbrellas/") + STATION_CODE + "-" + String(s.id) +
                   "?updateMask.fieldPaths=tag_uid&updateMask.fieldPaths=updated_at"), ubody);
  }
}

/** stations/{code} 하트비트 — 장치 화면 / 앱의 "보드 온라인" 판단 (+ IR 스냅샷) */
bool reportPresence() {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (!firebaseLogin()) return false;
  IPAddress ip = WiFi.localIP();
  const bool ir1 = irPresent(slots[0]);
  const bool ir2 = irPresent(slots[1]);
  lastIr1 = ir1;
  lastIr2 = ir2;
  irEdgeInit = true;
  String body = String("{\"fields\":{") +
                "\"code\":{\"stringValue\":\"" + STATION_CODE + "\"}," +
                "\"last_seen\":{\"integerValue\":\"" + epochMsString() + "\"}," +
                "\"link\":{\"stringValue\":\"wifi\"}," +
                "\"wifi_rssi\":{\"integerValue\":\"" + String((long)WiFi.RSSI()) + "\"}," +
                "\"wifi_ip\":{\"stringValue\":\"" + String(ip[0]) + "." + ip[1] + "." + ip[2] + "." + ip[3] + "\"}," +
                "\"ir1\":{\"booleanValue\":" + String(ir1 ? "true" : "false") + "}," +
                "\"ir2\":{\"booleanValue\":" + String(ir2 ? "true" : "false") + "}," +
                "\"mcu_ok\":{\"booleanValue\":true}}}";
  bool ok = firestoreWrite("PATCH", firestorePath(String("/stations/") + STATION_CODE +
                 "?updateMask.fieldPaths=code&updateMask.fieldPaths=last_seen&updateMask.fieldPaths=link" +
                 "&updateMask.fieldPaths=wifi_rssi&updateMask.fieldPaths=wifi_ip" +
                 "&updateMask.fieldPaths=ir1&updateMask.fieldPaths=ir2&updateMask.fieldPaths=mcu_ok"), body);
  if (ok) lastPresenceMs = millis();
  return ok;
}

/** IR 엣지: HTTPS 하지 않고 플래그만 — 명령 폴링을 막지 않음 */
void pollIrEdges() {
  const bool ir1 = irPresent(slots[0]);
  const bool ir2 = irPresent(slots[1]);
  if (!irEdgeInit) {
    lastIr1 = ir1;
    lastIr2 = ir2;
    irEdgeInit = true;
    return;
  }
  if (ir1 == lastIr1 && ir2 == lastIr2) return;
  if (millis() - lastIrReportMs < IR_REPORT_MIN_MS) return;
  lastIrReportMs = millis();

  if (ir1 != lastIr1) {
    Serial.print("[IR] edge slot1 ");
    Serial.println(ir1 ? "present" : "empty");
    if (isWired()) { Serial.print("EVENT IR 1 "); Serial.println(ir1 ? "1" : "0"); }
  }
  if (ir2 != lastIr2) {
    Serial.print("[IR] edge slot2 ");
    Serial.println(ir2 ? "present" : "empty");
    if (isWired()) { Serial.print("EVENT IR 2 "); Serial.println(ir2 ? "1" : "0"); }
  }
  lastIr1 = ir1;
  lastIr2 = ir2;
  presenceDirty = true;  // stations.ir1/ir2 만 빠르게 PATCH
}

void reportSenseIr(Slot& s) {
  const bool present = irPresent(s);
  Serial.print("[IR] slot "); Serial.print(s.id);
  Serial.println(present ? " present" : " empty");
  if (isWired()) {
    Serial.print("EVENT IR "); Serial.print(s.id); Serial.print(" ");
    Serial.println(present ? "1" : "0");
    return;
  }
  // 즉시 PATCH 하지 않고 dirty — 명령 폴링과 경합하지 않음
  presenceDirty = true;
}

void startSenseRfid(Slot& s) {
  s.senseRfidUntil = millis() + 15000UL;
  Serial.print("[RFID] sense window 15s slot "); Serial.println(s.id);
}

/** 대기 명령 1건 처리. true = 서보를 열어 문 감시 시작 → 추가 HTTPS 중단 */
bool handleOneCommand(const String& resp, int docPos, int docEnd) {
  String fullName = jsonString(resp, "name", docPos);
  const String docId = fullName.substring(fullName.lastIndexOf('/') + 1);
  if (!docId.length()) return false;
  const int slotNo = fieldValue(resp, "slot", "integerValue", docPos, docEnd).toInt();
  const String action = fieldValue(resp, "action", "stringValue", docPos, docEnd);
  const bool isReturn = action == "open_return";
  const bool senseIr = action == "sense_ir";
  const bool senseRfid = action == "sense_rfid";
  const unsigned long createdSec = msStringToSec(fieldValue(resp, "created_at", "integerValue", docPos, docEnd));
  const unsigned long nowSec = nowEpochSec();

  Serial.print("[CMD] id="); Serial.print(docId);
  Serial.print(" slot="); Serial.print(slotNo);
  Serial.print(" "); Serial.println(action);

  Slot* s = slotByNo(slotNo);
  if (!s) {
    Serial.println("[CMD] invalid slot → done");
    markCommandDone(docId);
    return false;
  }
  if (nowSec && createdSec) {
    long ageS = (long)nowSec - (long)createdSec;
    Serial.print("[CMD] now="); Serial.print(nowSec);
    Serial.print(" created="); Serial.print(createdSec);
    Serial.print(" age_s="); Serial.println(ageS);
    if (ageS > (long)CMD_MAX_AGE_S) {
      Serial.println("[CMD] stale (>1h) → done without opening");
      markCommandDone(docId);
      return false;
    }
  }
  if (docId == lastCmdId) {       // 이전 done PATCH 실패 → 문 다시 열지 않고 done만 재시도
    markCommandDone(docId);
    return false;
  }
  lastCmdId = docId;
  if (senseIr) {
    // presence만 갱신 (별도 device_events HTTPS 생략) — 명령 큐를 막지 않음
    presenceDirty = true;
    markCommandDone(docId);
    return false;
  }
  if (senseRfid) {
    startSenseRfid(*s);
    markCommandDone(docId);
    return false;
  }
  if (action == "test_open" || action == "test_close") {
    Serial.println(action == "test_open" ? "[CMD] test open" : "[CMD] test close");
    testServo(*s, action == "test_open", docId);
    markCommandDone(docId);
    return false;
  }
  if (action != "open" && action != "open_return") {
    Serial.println("[CMD] unknown action → done");
    markCommandDone(docId);
    return false;
  }
  Serial.println("[CMD] execute open now");
  executeCommand(*s, isReturn, docId);
  markCommandDone(docId);
  presenceDirty = true;
  return true;  // 문 감시 시작 → 추가 명령은 다음 폴링
}

/** station==STATION_CODE && done==0 — presence HTTPS 없이 명령만 (서보 지연 제거) */
void pollCommands() {
  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) { Serial.println("[POLL] WiFi 끊김"); return; }
  if (!firebaseLogin()) { Serial.println("[POLL] Auth 실패"); return; }

  String body = String("{\"structuredQuery\":{\"from\":[{\"collectionId\":\"commands\"}],") +
                "\"where\":{\"compositeFilter\":{\"op\":\"AND\",\"filters\":[" +
                "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"station\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"" + STATION_CODE + "\"}}}," +
                "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"done\"},\"op\":\"EQUAL\",\"value\":{\"integerValue\":\"0\"}}}]}}," +
                "\"orderBy\":[{\"field\":{\"fieldPath\":\"created_at\"},\"direction\":\"ASCENDING\"}],\"limit\":2}}";
  String resp;
  const String path = firestorePath(":runQuery");
  if (!httpsRequest("firestore.googleapis.com", "POST", path, body, idToken, resp, 8000)) {
    if (lastHttpStatus != 401 && lastHttpStatus != 403) return;
    if (!firebaseLogin(true)) return;
    if (!httpsRequest("firestore.googleapis.com", "POST", path, body, idToken, resp, 8000)) return;
  }

  // 오래된 sense/stale 이 앞에 있어도 같은 응답에서 연속 처리 → open이 막히지 않음
  int searchFrom = 0;
  for (int n = 0; n < 5; n++) {
    const int docPos = resp.indexOf("\"document\"", searchFrom);
    if (docPos < 0) break;
    const int nextDoc = resp.indexOf("\"document\"", docPos + 10);
    const int docEnd = nextDoc < 0 ? (int)resp.length() : nextDoc;
    searchFrom = docPos + 10;
    if (handleOneCommand(resp, docPos, docEnd)) break;
  }
}

// ---------- 메인 ----------
void setup() {
  Serial.begin(9600);
  while (!Serial && millis() < 3000) {}
  delay(200);
  Serial.println("[BOOT] UmbrellaLocker v4 — fast poll, keep-alive, instant servo");

  for (int i = 0; i < 2; i++) {
    pinMode(SS_PINS[i], OUTPUT);
    digitalWrite(SS_PINS[i], HIGH);
    pinMode(IR_PINS[i], INPUT);
  }
  SPI.begin();
  for (int i = 0; i < 2; i++) {
    Slot& s = slots[i];
    s.id = i + 1;
    s.rfid.PCD_Init(SS_PINS[i], RST_PINS[i]);
    Serial.print("[BOOT] RFID"); Serial.print(s.id); Serial.print(" ver=0x");
    Serial.println(s.rfid.PCD_ReadRegister(MFRC522::VersionReg), HEX);
    if (ENABLE_SERVO) {
      s.servo.attach(SERVO_PINS[i]);
      s.servo.write(DOOR_CLOSED_DEG);
      delay(150);
    }
  }

  if (ENABLE_WIFI && wifiConfigured()) {
    ensureWifi();
    if (WiFi.status() == WL_CONNECTED) firebaseLogin(true);
  } else {
    Serial.println("[BOOT] WiFi 미설정 — USB bridge 로만 동작");
  }
  Serial.print("[BOOT] ready station="); Serial.println(STATION_CODE);
}

void loop() {
  pollSerial();
  updateLinkMode();
  for (Slot& s : slots) {
    updateWatch(s);
    handleReader(s);
  }
  if (isWired()) return;   // 브리지가 PING 중이면 WiFi 폴링 안 함

  pollIrEdges();  // 로컬만 (HTTPS 없음)

  const bool doorBusy = (slots[0].door != DOOR_IDLE || slots[1].door != DOOR_IDLE);

  // 문이 닫혀 있으면 명령 폴링이 먼저 — 웹에서 열기까지 기다리는 시간
  if (!doorBusy && millis() - lastPollMs >= POLL_MS) {
    lastPollMs = millis();
    pollCommands();
    return;
  }

  // 문 감시 중이거나 폴링 간격 사이에는 IR·하트비트
  const unsigned long presenceEvery = doorBusy ? PRESENCE_BUSY_MS : PRESENCE_MS;
  if (presenceDirty || millis() - lastPresenceMs >= presenceEvery) {
    presenceDirty = false;
    reportPresence();
  }
}
