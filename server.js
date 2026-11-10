/**
 * Umbrella 로컬 서버 (Express + node:sqlite)
 * - 프론트/브리지가 쓰는 /api 와 동일 인터페이스를 Firebase 어댑터와 맞춘다.
 */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DEVICE_KEY = process.env.DEVICE_KEY || "umbrella-device";
const MAX_HW_SLOT = 2;
const RENT_LIMIT_MS = 48 * 3600 * 1000;
const STATIONS = [
  ["A1", "형남공학관 2층 입구"],
  ["B2", "중앙도서관 출입구"],
  ["C3", "학생회관 정문"],
];

// ---------- DB ----------
const db = new DatabaseSync(path.join(__dirname, "umbrella.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    student_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    pw_hash    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stations (code TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS umbrellas (
    station   TEXT NOT NULL,
    slot      INTEGER NOT NULL,
    tag_uid   TEXT,
    status    TEXT DEFAULT 'in',
    rented_by TEXT,
    rented_at INTEGER,
    PRIMARY KEY (station, slot)
  );
  CREATE TABLE IF NOT EXISTS rentals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT NOT NULL,
    station     TEXT,
    slot        INTEGER,
    tag_uid     TEXT,
    rented_at   INTEGER NOT NULL,
    due_at      INTEGER NOT NULL,
    returned_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS commands (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    station    TEXT, slot INTEGER, action TEXT, student_id TEXT,
    done       INTEGER DEFAULT 0, created_at INTEGER, done_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS device_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    station    TEXT, slot INTEGER, kind TEXT, payload TEXT, created_at INTEGER
  );
`);
// 기존 DB 호환용 컬럼 추가 (이미 있으면 무시)
for (const sql of [
  "ALTER TABLE commands ADD COLUMN student_id TEXT",
  "ALTER TABLE commands ADD COLUMN created_at INTEGER",
  "ALTER TABLE commands ADD COLUMN done_at INTEGER",
  "ALTER TABLE umbrellas ADD COLUMN rented_by TEXT",
  "ALTER TABLE umbrellas ADD COLUMN rented_at INTEGER",
  "ALTER TABLE rentals ADD COLUMN station TEXT",
  "ALTER TABLE rentals ADD COLUMN slot INTEGER",
]) {
  try { db.exec(sql); } catch (_) {}
}

// 구버전 umbrellas(tag_uid PK) → (station, slot) PK 로 마이그레이션 (슬롯당 1행)
(function migrateUmbrellas() {
  const cols = db.prepare("PRAGMA table_info(umbrellas)").all();
  const pk = cols.filter((c) => c.pk > 0).map((c) => c.name).sort().join(",");
  if (pk === "slot,station") return;
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE umbrellas_v2 (
        station TEXT NOT NULL, slot INTEGER NOT NULL, tag_uid TEXT,
        status TEXT DEFAULT 'in', rented_by TEXT, rented_at INTEGER,
        PRIMARY KEY (station, slot)
      );
      INSERT OR IGNORE INTO umbrellas_v2(station, slot, tag_uid, status, rented_by, rented_at)
        SELECT station, slot, tag_uid, status, rented_by, rented_at FROM umbrellas
        WHERE station IS NOT NULL AND slot IS NOT NULL
        ORDER BY (status = 'out') DESC, rowid DESC;
      DROP TABLE umbrellas;
      ALTER TABLE umbrellas_v2 RENAME TO umbrellas;
    `);
    db.exec("COMMIT");
    console.log("[db] umbrellas 테이블을 (station, slot) 기준으로 정리했어요.");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
})();

const q = {
  insertStation: db.prepare("INSERT OR IGNORE INTO stations(code, name) VALUES (?, ?)"),
  insertUmbrella: db.prepare(
    "INSERT OR IGNORE INTO umbrellas(station, slot, tag_uid, status) VALUES (?, ?, NULL, 'in')"
  ),
  studentExists: db.prepare("SELECT 1 AS x FROM students WHERE student_id = ?"),
  insertStudent: db.prepare(
    "INSERT INTO students(student_id, name, pw_hash, created_at) VALUES (?,?,?,?)"
  ),
  getStudent: db.prepare("SELECT * FROM students WHERE student_id = ?"),
  listStudents: db.prepare("SELECT student_id, name, created_at FROM students ORDER BY created_at DESC"),
  activeRental: db.prepare(
    "SELECT * FROM rentals WHERE student_id = ? AND returned_at IS NULL ORDER BY id DESC LIMIT 1"
  ),
  listActiveRentals: db.prepare(
    "SELECT * FROM rentals WHERE returned_at IS NULL ORDER BY rented_at DESC LIMIT 50"
  ),
  stationUmbrellas: db.prepare(
    "SELECT tag_uid, station, slot, status, rented_by, rented_at FROM umbrellas WHERE station = ? ORDER BY slot"
  ),
  allUmbrellas: db.prepare("SELECT * FROM umbrellas ORDER BY station, slot"),
  umbrellaAt: db.prepare("SELECT * FROM umbrellas WHERE station = ? AND slot = ?"),
  setUmbrella: db.prepare(
    "UPDATE umbrellas SET status = ?, rented_by = ?, rented_at = ? WHERE station = ? AND slot = ?"
  ),
  setTagUid: db.prepare("UPDATE umbrellas SET tag_uid = ? WHERE station = ? AND slot = ?"),
  clearTagElsewhere: db.prepare(
    "UPDATE umbrellas SET tag_uid = NULL WHERE tag_uid = ? AND NOT (station = ? AND slot = ?)"
  ),
  insertRental: db.prepare(
    "INSERT INTO rentals(student_id, station, slot, rented_at, due_at) VALUES (?,?,?,?,?)"
  ),
  closeRental: db.prepare("UPDATE rentals SET returned_at = ? WHERE id = ?"),
  insertCommand: db.prepare(
    "INSERT INTO commands (station, slot, action, student_id, done, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ),
  pendingCommands: db.prepare(
    `SELECT id, station, slot, action, student_id, created_at FROM commands
     WHERE station = ? AND done = 0 AND slot <= ? ORDER BY id ASC LIMIT ?`
  ),
  doneCommand: db.prepare("UPDATE commands SET done = 1, done_at = ? WHERE id = ? AND done = 0"),
  insertEvent: db.prepare(
    "INSERT INTO device_events(station, slot, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)"
  ),
  recentCommands: db.prepare("SELECT * FROM commands ORDER BY id DESC LIMIT 20"),
  recentEvents: db.prepare("SELECT * FROM device_events ORDER BY id DESC LIMIT 20"),
  recentEventsAt: db.prepare(
    `SELECT * FROM device_events
     WHERE station = ? AND slot = ? AND created_at >= ?
     ORDER BY id DESC LIMIT 40`
  ),
};

for (const [code, name] of STATIONS) {
  q.insertStation.run(code, name);
  for (let slot = 1; slot <= MAX_HW_SLOT; slot++) q.insertUmbrella.run(code, slot);
}

// ---------- 헬퍼 ----------
const hashPw = (pw) => {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
};
const checkPw = (pw, stored) => {
  const [s, h] = String(stored || "").split(":");
  if (!s || !h) return false;
  const t = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64);
  const hb = Buffer.from(h, "hex");
  return t.length === hb.length && crypto.timingSafeEqual(t, hb);
};
const getLanIPs = () => {
  try {
    return Object.values(os.networkInterfaces() || {})
      .flat()
      .filter((n) => n && n.family === "IPv4" && !n.internal)
      .map((n) => n.address);
  } catch (_) {
    return [];
  }
};

const toStation = (v) => String(v || "").toUpperCase();
const toSlot = (v) => Number(v);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const assertSlot = (res, slot) => {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_HW_SLOT) {
    bad(res, `지금은 슬롯 1~${MAX_HW_SLOT}만 사용할 수 있어요.`);
    return false;
  }
  return true;
};
const rentalView = (r) =>
  r && { rentalId: r.id, station: r.station, slot: r.slot, rented_at: r.rented_at, due_at: r.due_at };

function requireDeviceKey(req, res, next) {
  const key = req.headers["x-device-key"] || req.query.key;
  if (key !== DEVICE_KEY) return bad(res, "device key가 올바르지 않아요.", 401);
  next();
}

// ---------- 앱 ----------
const sessions = new Map();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/signup", (req, res) => {
  const { studentId, name, password } = req.body || {};
  if (!/^\d{6,10}$/.test(studentId || "")) return bad(res, "학번은 숫자 6~10자리로 입력해 주세요.");
  if (!name || !name.trim() || name.length > 20) return bad(res, "이름을 입력해 주세요.");
  if (!password || password.length < 6 || password.length > 16) {
    return bad(res, "비밀번호는 6~16자리로 입력해 주세요.");
  }
  if (q.studentExists.get(studentId)) return bad(res, "이미 가입된 학번이에요.", 409);
  q.insertStudent.run(studentId, name.trim(), hashPw(password), Date.now());
  res.status(201).json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { studentId, password } = req.body || {};
  const u = q.getStudent.get(studentId || "");
  if (!u || !checkPw(password || "", u.pw_hash)) return bad(res, "학번 또는 비밀번호가 맞지 않아요.", 401);
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { id: u.student_id, exp: Date.now() + 24 * 3600 * 1000 });
  res.json({ token, name: u.name, activeRental: rentalView(q.activeRental.get(u.student_id)) || null });
});

app.get("/api/me", (req, res) => {
  const t = (req.headers.authorization || "").replace("Bearer ", "");
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) return bad(res, "로그인이 필요해요.", 401);
  const u = q.getStudent.get(s.id);
  if (!u) return bad(res, "사용자를 찾을 수 없어요.", 404);
  res.json({ studentId: u.student_id, name: u.name });
});

app.get("/api/students/:id/rental", (req, res) => {
  res.json({ activeRental: rentalView(q.activeRental.get(req.params.id)) || null });
});

app.get("/api/station/:code", (req, res) => {
  const code = toStation(req.params.code);
  res.json({ station: code, maxHwSlot: MAX_HW_SLOT, slots: q.stationUmbrellas.all(code) });
});

// 대여: 우산 out + rentals + 문 열기 명령 (한 트랜잭션)
app.post("/api/rent", (req, res) => {
  const station = toStation(req.body && req.body.station);
  const slot = toSlot(req.body && req.body.slot);
  const studentId = String((req.body && req.body.studentId) || "");
  if (!station || !studentId) return bad(res, "station/studentId가 필요해요.");
  if (!assertSlot(res, slot)) return;

  const u = q.umbrellaAt.get(station, slot);
  if (!u || u.status === "out") return bad(res, "그 칸은 이미 대여 중이에요.", 409);
  if (q.activeRental.get(studentId)) return bad(res, "이미 대여 중인 우산이 있어요. 먼저 반납해 주세요.", 409);

  const now = Date.now();
  const due_at = now + RENT_LIMIT_MS;
  db.exec("BEGIN");
  try {
    q.setUmbrella.run("out", studentId, now, station, slot);
    const r = q.insertRental.run(studentId, station, slot, now, due_at);
    const c = q.insertCommand.run(station, slot, "open", studentId, now);
    db.exec("COMMIT");
    res.json({
      ok: true, id: Number(c.lastInsertRowid), rentalId: Number(r.lastInsertRowid),
      station, slot, rented_at: now, due_at,
    });
  } catch (e) {
    db.exec("ROLLBACK");
    bad(res, "대여 처리 중 오류가 발생했어요.", 500);
  }
});

// 반납: 활성 대여가 있으면 비어 있는 칸(out) 어디에나 반납
app.post("/api/return", (req, res) => {
  const station = toStation(req.body && req.body.station);
  const slot = toSlot(req.body && req.body.slot);
  const studentId = String((req.body && req.body.studentId) || "");
  if (!assertSlot(res, slot)) return;

  const active = q.activeRental.get(studentId);
  if (!active) return bad(res, "반납할 대여 정보가 없어요.", 409);
  const u = q.umbrellaAt.get(station, slot);
  if (!u || u.status !== "out") {
    return bad(res, "그 칸에는 이미 우산이 있어요. 비어 있는 칸에만 반납할 수 있어요.", 409);
  }
  const now = Date.now();
  db.exec("BEGIN");
  try {
    q.setUmbrella.run("in", null, null, station, slot);
    q.closeRental.run(now, active.id);
    const c = q.insertCommand.run(station, slot, "open_return", studentId, now);
    db.exec("COMMIT");
    res.json({ ok: true, id: Number(c.lastInsertRowid), station, slot });
  } catch (e) {
    db.exec("ROLLBACK");
    bad(res, "반납 처리 중 오류가 발생했어요.", 500);
  }
});

// 문만 열기 (상태 변경 없음)
app.post("/api/open", (req, res) => {
  const station = toStation(req.body && req.body.station);
  const slot = toSlot(req.body && req.body.slot);
  const action = (req.body && req.body.action) || "open";
  if (!station) return bad(res, "station이 필요해요.");
  if (!assertSlot(res, slot)) return;
  const info = q.insertCommand.run(station, slot, action, (req.body && req.body.studentId) || null, Date.now());
  res.json({ ok: true, id: Number(info.lastInsertRowid), station, slot, action });
});

// ---------- 관리 ----------
app.get("/api/admin/students", (_req, res) => {
  const students = q.listStudents.all().map((s) => ({
    studentId: s.student_id, name: s.name, created_at: s.created_at,
    activeRental: rentalView(q.activeRental.get(s.student_id)) || null,
  }));
  res.json({ students });
});
app.get("/api/admin/umbrellas", (_req, res) => {
  res.json({ umbrellas: q.allUmbrellas.all().map((u) => ({ id: `${u.station}-${u.slot}`, ...u })) });
});
app.get("/api/admin/rentals", (_req, res) => {
  res.json({ rentals: q.listActiveRentals.all().map((r) => ({ ...r, studentId: r.student_id })) });
});
app.post("/api/admin/umbrella-status", (req, res) => {
  const station = toStation(req.body && req.body.station);
  const slot = toSlot(req.body && req.body.slot);
  const status = req.body && req.body.status;
  if (!["in", "out"].includes(status)) return bad(res, "status는 in/out 만 가능해요.");
  if (!assertSlot(res, slot)) return;
  q.setUmbrella.run(status, null, null, station, slot);
  res.json({ ok: true });
});

// ---------- 장치 ----------
app.get("/api/device/commands", requireDeviceKey, (req, res) => {
  const station = toStation(req.query.station || "A1");
  res.json({ station, commands: q.pendingCommands.all(station, MAX_HW_SLOT, 5) });
});
app.get("/api/device/next", requireDeviceKey, (req, res) => {
  const station = toStation(req.query.station || "A1");
  const row = q.pendingCommands.get(station, MAX_HW_SLOT, 1);
  res.json(row ? { ok: true, has: true, ...row } : { ok: true, has: false, station });
});
app.post("/api/device/commands/:id/done", requireDeviceKey, (req, res) => {
  const id = Number(req.params.id);
  const info = q.doneCommand.run(Date.now(), id);
  if (info.changes === 0) return bad(res, "명령을 찾을 수 없어요.", 404);
  res.json({ ok: true, id });
});
app.post("/api/device/event", requireDeviceKey, (req, res) => {
  const station = toStation((req.body && req.body.station) || "A1");
  const slot = toSlot(req.body && req.body.slot);
  const kind = String((req.body && req.body.kind) || "");
  const payload = (req.body && req.body.payload) || {};
  if (!["rfid", "ir", "servo", "return_ok"].includes(kind)) {
    return bad(res, "kind는 rfid/ir/servo/return_ok 중 하나여야 해요.");
  }
  if (!assertSlot(res, slot)) return;
  const info = q.insertEvent.run(station, slot, kind, JSON.stringify(payload), Date.now());
  if (kind === "rfid" && payload.uid) {
    // 태그는 우산을 따라 이동하므로 다른 칸에 남아 있던 같은 UID는 지운다
    const uid = String(payload.uid).toUpperCase().replace(/\s+/g, "");
    q.clearTagElsewhere.run(uid, station, slot);
    q.setTagUid.run(uid, station, slot);
  }
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

/** 아두이노/브리지 하트비트 (메모리) */
const devicePresence = Object.create(null);
app.post("/api/device/presence", requireDeviceKey, (req, res) => {
  const station = toStation((req.body && req.body.station) || "A1");
  const now = Date.now();
  devicePresence[station] = {
    code: station,
    last_seen: now,
    link: String((req.body && req.body.link) || "wired"),
    mcu_ok: !!(req.body && req.body.mcu_ok),
    wifi_rssi: req.body && req.body.wifi_rssi != null ? Number(req.body.wifi_rssi) : null,
    wifi_ip: (req.body && req.body.wifi_ip) || null,
  };
  res.json({ ok: true, station });
});
app.get("/api/device/presence", (req, res) => {
  const station = toStation(req.query.station || "A1");
  const row = devicePresence[station] || null;
  const ONLINE_MS = 60000;
  res.json({
    station,
    online: !!(row && row.last_seen && nowFresh(row.last_seen, ONLINE_MS)),
    age_ms: row && row.last_seen ? Date.now() - row.last_seen : null,
    ...row,
  });
});
function nowFresh(ts, ms) {
  return Date.now() - Number(ts) <= ms;
}

/** 웹앱이 문 닫힘(auto_close / return_ok)을 기다리며 폴링 */
app.get("/api/device/events", (req, res) => {
  const station = toStation(req.query.station);
  const slot = toSlot(req.query.slot);
  if (!station || !assertSlot(res, slot)) return;
  const rows = q.recentEventsAt.all(station, slot, 0);
  res.json({
    events: rows.map((e) => {
      let payload = {};
      try { payload = JSON.parse(e.payload || "{}"); } catch (_) {}
      return { id: e.id, station: e.station, slot: e.slot, kind: e.kind, payload, created_at: e.created_at };
    }),
  });
});

app.get("/api/debug/recent", (_req, res) => {
  res.json({
    maxHwSlot: MAX_HW_SLOT, backend: "local",
    umbrellas: q.allUmbrellas.all(),
    commands: q.recentCommands.all(),
    events: q.recentEvents.all(),
  });
});
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, backend: "local", maxHwSlot: MAX_HW_SLOT, lanIPs: getLanIPs(), port: PORT });
});

// 항상 JSON 으로 에러 응답 (HTML 스택트레이스 노출 방지)
app.use((err, _req, res, _next) => {
  console.error("[api]", err);
  const status = err.type === "entity.parse.failed" ? 400 : 500;
  res.status(status).json({ error: status === 400 ? "요청 형식이 올바르지 않아요." : "서버 오류가 발생했어요." });
});

app.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log(" Umbrella local server");
  console.log(`  app     : http://localhost:${PORT}/`);
  console.log(`  admin   : http://localhost:${PORT}/admin.html`);
  console.log(`  device  : http://localhost:${PORT}/device.html`);
  for (const ip of getLanIPs()) console.log(`  LAN     : http://${ip}:${PORT}/   (Arduino SERVER_HOST="${ip}")`);
  console.log(`  DEVICE_KEY = ${DEVICE_KEY}  HW slots = 1..${MAX_HW_SLOT}`);
  console.log("========================================");
});
