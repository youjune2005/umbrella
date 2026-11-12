/**
 * Umbrella 백엔드 어댑터
 *  - firebase : Auth + Firestore (Hosting 배포용, Functions 없음)
 *  - local    : Express /api (npm start)
 * 두 어댑터는 동일한 인터페이스를 구현한다.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  updateDoc,
  runTransaction,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { pickMatchingEvent } from "/js/device-protocol.js?v=97";

// ---------- 공통 상수 / 유틸 ----------
const cfg = window.UMBRELLA || {};
const fb = cfg.firebase || {};
export const MAX_HW_SLOT = (cfg.cost && cfg.cost.maxHwSlot) || 2;
export const TOTAL_SLOTS = 6;
export const RENT_LIMIT_MS = 48 * 3600 * 1000;
/** 48시간 초과 후: 5분마다 1,000원 */
export const OVERDUE_FEE_WON = 1000;
export const OVERDUE_FEE_UNIT_MS = 5 * 60 * 1000;

export function overdueFeeWon(overdueMs) {
  if (!(overdueMs > 0)) return 0;
  return Math.ceil(overdueMs / OVERDUE_FEE_UNIT_MS) * OVERDUE_FEE_WON;
}
/** 새로고침 후 로그인 유지 (약 20분) */
export const SESSION_MS = 20 * 60 * 1000;
const DEVICE_KEY = "umbrella-device";
const LOCAL_SESSION_KEY = "umbrella_local_session";
const FB_SESSION_KEY = "umbrella_fb_session";

/**
 * code=내부키, qr=인쇄번호, lat/lng=현장 측정 좌표
 * live=true 만 대여·반납 가능 (나머지는 추후 지원 예정)
 */
export const STATIONS = [
  { code: "A1", qr: "A7482", name: "형남공학관 2층 입구", lat: 37.49580, lng: 126.95648, live: true },
  { code: "B2", qr: "B3916", name: "중앙도서관 출입구", lat: 37.49623, lng: 126.95845, live: false },
  { code: "C3", qr: "C8605", name: "학생회관 정문", lat: 37.49678, lng: 126.95683, live: false },
];

/** 세 핀 중심 — 실제 화면은 setBounds 로 맞춤 */
export const CAMPUS_CENTER = { lat: 37.49627, lng: 126.95725, zoom: 17 };

/** 인쇄용 고유번호 (없으면 내부 code) */
export function stationQr(code) {
  const s = STATIONS.find((x) => x.code === code);
  return (s && (s.qr || s.code)) || code || "—";
}

/** UI 표시: A7482 · 형남공학관 2층 입구 */
export function stationLabel(code) {
  const s = STATIONS.find((x) => x.code === code);
  if (!s) return code || "—";
  return `${s.qr || s.code} · ${s.name}`;
}

const isConfigured =
  fb.projectId && fb.projectId !== "YOUR_PROJECT_ID" &&
  fb.apiKey && fb.apiKey !== "YOUR_API_KEY";

// 우선순위: URL ?backend=local|firebase (개발용) → firebase-config.js → 자동 감지
const urlBackend = new URLSearchParams(location.search).get("backend");
const pick = (v) => (v === "firebase" || v === "local" ? v : null);
export const mode = pick(urlBackend) || pick(cfg.backend) || (isConfigured ? "firebase" : "local");

export const getMode = () => mode;

const umbrellaId = (station, slot) => `${station}-${slot}`;
const studentEmail = (studentId) => `${studentId}@students.umbrella.app`;

function assertSlot(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_HW_SLOT) {
    throw new Error(`지금은 슬롯 1~${MAX_HW_SLOT}만 사용할 수 있어요.`);
  }
}

/** 비밀번호 6~16자 */
export function validatePassword(password) {
  const pw = String(password || "");
  if (pw.length < 6 || pw.length > 16) {
    throw new Error("비밀번호는 6~16자리로 입력해 주세요.");
  }
  return pw;
}

/** 슬롯 상태 맵 기본값: HW 슬롯은 in, 나머지는 prep */
function emptySlots() {
  const slots = {};
  for (let i = 1; i <= TOTAL_SLOTS; i++) slots[i] = i <= MAX_HW_SLOT ? "in" : "prep";
  return slots;
}

function applyRows(slots, rows) {
  for (const u of rows || []) {
    if (u.slot >= 1 && u.slot <= MAX_HW_SLOT) slots[u.slot] = u.status === "out" ? "out" : "in";
  }
  return slots;
}

// ---------- 로컬(Express) 어댑터 ----------
function createLocalBackend() {
  async function api(method, path, body, headers = {}) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  }
  const dev = { "X-Device-Key": DEVICE_KEY };

  return {
    mode: "local",
    async signup(p) {
      validatePassword(p.password);
      return api("POST", "/api/signup", p);
    },
    async login({ studentId, password }) {
      const r = await api("POST", "/api/login", { studentId, password });
      const user = {
        studentId, name: r.name, uid: studentId,
        activeRental: r.activeRental || null,
      };
      localStorage.setItem(LOCAL_SESSION_KEY, JSON.stringify({
        token: r.token, ...user, exp: Date.now() + SESSION_MS,
      }));
      return user;
    },
    async restoreSession() {
      try {
        const raw = localStorage.getItem(LOCAL_SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s.token || !s.exp || s.exp < Date.now()) {
          localStorage.removeItem(LOCAL_SESSION_KEY);
          return null;
        }
        await api("GET", "/api/me", null, { Authorization: `Bearer ${s.token}` });
        let activeRental = null;
        try {
          activeRental = (await api("GET", `/api/students/${s.studentId}/rental`)).activeRental || null;
        } catch (_) {}
        return {
          studentId: s.studentId, name: s.name, uid: s.uid || s.studentId, activeRental,
        };
      } catch (_) {
        localStorage.removeItem(LOCAL_SESSION_KEY);
        return null;
      }
    },
    async loginDevice() { return { ok: true }; },
    async logout() { localStorage.removeItem(LOCAL_SESSION_KEY); },
    async getStationInventory(station) {
      const r = await api("GET", `/api/station/${station}`);
      return { station, slots: applyRows(emptySlots(), r.slots), rows: r.slots || [] };
    },
    async getMyActiveRental(studentId) {
      const r = await api("GET", `/api/students/${studentId}/rental`);
      return r.activeRental || null;
    },
    async rent({ station, slot, studentId }) {
      assertSlot(slot);
      return api("POST", "/api/rent", { station, slot, studentId });
    },
    async return({ station, slot, studentId }) {
      assertSlot(slot);
      return api("POST", "/api/return", { station, slot, studentId });
    },
    async openDoor({ station, slot, studentId, action = "open" }) {
      assertSlot(slot);
      return api("POST", "/api/open", { station, slot, studentId, action });
    },
    async listStudents() { return (await api("GET", "/api/admin/students")).students; },
    async listAllUmbrellas() { return (await api("GET", "/api/admin/umbrellas")).umbrellas; },
    async listActiveRentals() { return (await api("GET", "/api/admin/rentals")).rentals; },
    async setUmbrellaStatus(p) { return api("POST", "/api/admin/umbrella-status", p); },
    async seedInventory() {},
    async fetchNextCommand(station = "A1") {
      return api("GET", `/api/device/next?station=${station}&key=${DEVICE_KEY}`);
    },
    async markCommandDone(id) { return api("POST", `/api/device/commands/${id}/done`, null, dev); },
    async postDeviceEvent(p) { return api("POST", "/api/device/event", p, dev); },
    async getDevicePresence(station = "A1") {
      return api("GET", `/api/device/presence?station=${station}`);
    },
    watchDevicePresence(station, onChange) {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try { onChange(await this.getDevicePresence(station)); } catch (_) { /* ignore */ }
        if (!stopped) setTimeout(tick, 1500);
      };
      tick();
      return () => { stopped = true; };
    },
    async getRecentDeviceEvent({ station, slot, since = 0, match } = {}) {
      const r = await api("GET", `/api/device/events?station=${encodeURIComponent(station)}&slot=${slot}&since=${Number(since) || 0}`);
      return pickMatchingEvent(r.events || [], { station, slot, since, match });
    },
    watchDeviceEvents(station, onChange) {
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const rows = [];
          for (let slot = 1; slot <= MAX_HW_SLOT; slot++) {
            const r = await api("GET", `/api/device/events?station=${encodeURIComponent(station)}&slot=${slot}&since=0`);
            rows.push(...(r.events || []));
          }
          onChange(rows);
        } catch (_) { /* ignore */ }
        if (!stopped) setTimeout(tick, 300);
      };
      tick();
      return () => { stopped = true; };
    },
    async debugRecent() { return api("GET", "/api/debug/recent"); },
    async health() { return api("GET", "/api/health"); },
  };
}

// ---------- Firebase 어댑터 ----------
function createFirebaseBackend() {
  const app = initializeApp(fb);
  const auth = getAuth(app);
  const db = getFirestore(app);
  // 브라우저에 로그인 유지 (새로고침해도 Auth 세션 유지)
  setPersistence(auth, browserLocalPersistence).catch(() => {});

  const requireUser = () => {
    if (!auth.currentUser) throw new Error("로그인이 필요해요.");
    return auth.currentUser;
  };
  const docData = (d) => ({ id: d.id, ...d.data() });
  const deviceEmail = (cfg.deviceEmail || "device@umbrella.local").toLowerCase();

  async function userFromAuth(user) {
    if (!user) return null;
    if ((user.email || "").toLowerCase() === deviceEmail) return null; // device 계정은 앱 로그인으로 취급 안 함
    const snap = await getDoc(doc(db, "students", user.uid));
    const data = snap.exists() ? snap.data() : {};
    return {
      studentId: data.studentId || String(user.email || "").split("@")[0],
      name: data.name || user.displayName || "학생",
      uid: user.uid,
      activeRental: data.activeRental || null,
    };
  }

  async function pendingCommands(station) {
    const q = query(
      collection(db, "commands"),
      where("station", "==", station),
      where("done", "==", 0),
      orderBy("created_at", "asc"),
      limit(10)
    );
    return (await getDocs(q)).docs.map(docData);
  }

  function newCommand(tx, { station, slot, studentId, action, now }) {
    const ref = doc(collection(db, "commands"));
    tx.set(ref, {
      station, slot, action,
      student_id: studentId || null,
      done: 0, created_at: now, done_at: null,
    });
    return ref.id;
  }

  return {
    mode: "firebase",

    async signup({ studentId, name, password }) {
      validatePassword(password);
      const cred = await createUserWithEmailAndPassword(auth, studentEmail(studentId), password);
      await updateProfile(cred.user, { displayName: name });
      await setDoc(doc(db, "students", cred.user.uid), {
        studentId, name, created_at: Date.now(), activeRental: null,
      });
      await signOut(auth); // 가입 직후 자동 로그인 상태 해제 → 로그인 화면과 일치
      return { ok: true };
    },

    async login({ studentId, password }) {
      const cred = await signInWithEmailAndPassword(auth, studentEmail(studentId), password);
      localStorage.setItem(FB_SESSION_KEY, JSON.stringify({ exp: Date.now() + SESSION_MS }));
      return userFromAuth(cred.user);
    },

    /** 새로고침 후 Firebase Auth 세션 복구 (SESSION_MS 이내만) */
    async restoreSession() {
      return new Promise((resolve) => {
        const unsub = onAuthStateChanged(auth, async (user) => {
          unsub();
          try {
            if (!user) {
              localStorage.removeItem(FB_SESSION_KEY);
              resolve(null);
              return;
            }
            let exp = 0;
            try {
              const raw = localStorage.getItem(FB_SESSION_KEY);
              exp = raw ? JSON.parse(raw).exp || 0 : 0;
            } catch (_) {
              exp = 0;
            }
            if (!exp || exp < Date.now()) {
              localStorage.removeItem(FB_SESSION_KEY);
              await signOut(auth).catch(() => {});
              resolve(null);
              return;
            }
            resolve(await userFromAuth(user));
          } catch (_) {
            resolve(null);
          }
        });
      });
    },

    async loginDevice(password) {
      const email = cfg.deviceEmail || "device@umbrella.local";
      const STORAGE_KEY = "umbrella_device_pw";
      let pw = typeof password === "string" ? password : "";
      if (!pw && typeof sessionStorage !== "undefined") {
        try { pw = sessionStorage.getItem(STORAGE_KEY) || ""; } catch (_) { /* ignore */ }
      }
      if (!pw && typeof window !== "undefined" && typeof window.prompt === "function") {
        pw = window.prompt("device 계정 비밀번호를 입력하세요") || "";
        if (pw) {
          try { sessionStorage.setItem(STORAGE_KEY, pw); } catch (_) { /* ignore */ }
        }
      }
      if (!pw) throw new Error("device 비밀번호가 필요해요. (공개 설정에서 제거됨)");
      await signInWithEmailAndPassword(auth, email, pw);
      await this.seedInventory();
      return { ok: true, email };
    },

    async logout() {
      localStorage.removeItem(FB_SESSION_KEY);
      await signOut(auth);
    },

    async getStationInventory(station) {
      const snap = await getDocs(query(collection(db, "umbrellas"), where("station", "==", station)));
      const rows = snap.docs.map(docData);
      return { station, slots: applyRows(emptySlots(), rows), rows };
    },

    async getMyActiveRental(uid) {
      const snap = await getDoc(doc(db, "students", uid || requireUser().uid));
      return snap.exists() ? snap.data().activeRental || null : null;
    },

    /** 대여: 트랜잭션으로 슬롯 상태·대여기록·사용자·명령을 원자적으로 기록 */
    async rent({ station, slot, studentId }) {
      assertSlot(slot);
      const user = requireUser();
      const now = Date.now();
      const due_at = now + RENT_LIMIT_MS;
      const uRef = doc(db, "umbrellas", umbrellaId(station, slot));
      const sRef = doc(db, "students", user.uid);
      const rRef = doc(collection(db, "rentals"));

      const cmdId = await runTransaction(db, async (tx) => {
        const [uSnap, sSnap] = await Promise.all([tx.get(uRef), tx.get(sRef)]);
        const u = uSnap.exists() ? uSnap.data() : { status: "in" };
        if (u.status === "out") throw new Error("그 칸은 이미 대여 중이에요.");
        if (sSnap.exists() && sSnap.data().activeRental) {
          throw new Error("이미 대여 중인 우산이 있어요. 먼저 반납해 주세요.");
        }
        tx.set(uRef, {
          station, slot, status: "out",
          rented_by: studentId, rented_at: now, updated_at: now,
        }, { merge: true });
        tx.set(rRef, {
          studentId, studentUid: user.uid, station, slot,
          rented_at: now, due_at, returned_at: null, status: "active",
        });
        tx.set(sRef, {
          activeRental: { rentalId: rRef.id, station, slot, rented_at: now, due_at },
          updated_at: now,
        }, { merge: true });
        return newCommand(tx, { station, slot, studentId, action: "open", now });
      });

      return { ok: true, id: cmdId, rentalId: rRef.id, station, slot, rented_at: now, due_at };
    },

    /** 반납: 활성 대여가 있으면 비어 있는 칸(out) 어디에나 반납 */
    async return({ station, slot, studentId }) {
      assertSlot(slot);
      const user = requireUser();
      const now = Date.now();
      const sRef = doc(db, "students", user.uid);
      const uRef = doc(db, "umbrellas", umbrellaId(station, slot));

      const cmdId = await runTransaction(db, async (tx) => {
        const [sSnap, uSnap] = await Promise.all([tx.get(sRef), tx.get(uRef)]);
        const active = sSnap.exists() ? sSnap.data().activeRental : null;
        if (!active) throw new Error("반납할 대여 정보가 없어요.");
        const u = uSnap.exists() ? uSnap.data() : {};
        if (u.status !== "out") {
          throw new Error("그 칸에는 이미 우산이 있어요. 비어 있는 칸에만 반납할 수 있어요.");
        }
        tx.set(uRef, {
          station, slot, status: "in",
          rented_by: null, rented_at: null, updated_at: now,
        }, { merge: true });
        if (active.rentalId) {
          tx.update(doc(db, "rentals", active.rentalId), {
            returned_at: now, status: "returned", return_station: station, return_slot: slot,
          });
        }
        tx.set(sRef, { activeRental: null, updated_at: now }, { merge: true });
        // 반납 전용: 보드가 RFID+IR 인식 후 자동 닫힘
        return newCommand(tx, { station, slot, studentId, action: "open_return", now });
      });

      return { ok: true, id: cmdId, station, slot };
    },

    async openDoor({ station, slot, studentId, action = "open" }) {
      assertSlot(slot);
      requireUser();
      const ref = await addDoc(collection(db, "commands"), {
        station, slot, action, student_id: studentId || null,
        done: 0, created_at: Date.now(), done_at: null,
      });
      return { ok: true, id: ref.id, station, slot, action };
    },

    async listStudents() {
      requireUser();
      if ((auth.currentUser.email || "").toLowerCase() !== deviceEmail) {
        throw new Error("device 계정만 사용자 목록을 볼 수 있어요.");
      }
      return (await getDocs(collection(db, "students"))).docs.map((d) => ({ uid: d.id, ...d.data() }));
    },

    async listAllUmbrellas() {
      requireUser();
      const rows = (await getDocs(collection(db, "umbrellas"))).docs.map(docData);
      return rows.sort((a, b) =>
        a.station === b.station ? a.slot - b.slot : a.station.localeCompare(b.station)
      );
    },

    async listActiveRentals() {
      requireUser();
      if ((auth.currentUser.email || "").toLowerCase() !== deviceEmail) {
        throw new Error("device 계정만 전체 대여 목록을 볼 수 있어요.");
      }
      const q = query(
        collection(db, "rentals"),
        where("status", "==", "active"),
        orderBy("rented_at", "desc"),
        limit(50)
      );
      return (await getDocs(q)).docs.map(docData);
    },

    async setUmbrellaStatus({ station, slot, status }) {
      if (!["in", "out"].includes(status)) throw new Error("status는 in/out 만 가능해요.");
      requireUser();
      if ((auth.currentUser.email || "").toLowerCase() !== deviceEmail) {
        throw new Error("device 계정만 슬롯 상태를 바꿀 수 있어요.");
      }
      await setDoc(doc(db, "umbrellas", umbrellaId(station, slot)), {
        station, slot, status, updated_at: Date.now(),
        ...(status === "in" ? { rented_by: null, rented_at: null } : {}),
      }, { merge: true });
      return { ok: true };
    },

    /** 없는 문서만 생성 (device 로그인·관리 화면에서만 호출 → 비용 최소) */
    async seedInventory() {
      if (!auth.currentUser) return;
      if ((auth.currentUser.email || "").toLowerCase() !== deviceEmail) return;
      for (const s of STATIONS) {
        await setDoc(doc(db, "stations", s.code), s, { merge: true });
        for (let slot = 1; slot <= MAX_HW_SLOT; slot++) {
          const ref = doc(db, "umbrellas", umbrellaId(s.code, slot));
          if (!(await getDoc(ref)).exists()) {
            await setDoc(ref, {
              tag_uid: `${s.code}-SLOT${slot}`, station: s.code, slot,
              status: "in", rented_by: null, rented_at: null, updated_at: Date.now(),
            });
          }
        }
      }
    },

    async fetchNextCommand(station = "A1") {
      const row = (await pendingCommands(station)).find((c) => c.slot >= 1 && c.slot <= MAX_HW_SLOT);
      return row ? { ok: true, has: true, ...row } : { ok: true, has: false, station };
    },

    async markCommandDone(id) {
      await updateDoc(doc(db, "commands", id), { done: 1, done_at: Date.now() });
      return { ok: true, id };
    },

    async postDeviceEvent({ station, slot, kind, payload }) {
      const ref = await addDoc(collection(db, "device_events"), {
        station, slot, kind, payload: payload || {}, created_at: Date.now(),
      });
      if (kind === "rfid" && payload && payload.uid) {
        await setDoc(doc(db, "umbrellas", umbrellaId(station, slot)), {
          tag_uid: String(payload.uid).toUpperCase(), updated_at: Date.now(),
        }, { merge: true });
      }
      return { ok: true, id: ref.id };
    },

    _presenceFromSnap(station, snap) {
      const ONLINE_MS = 60000;
      if (!snap || !snap.exists()) {
        return { station, online: false, age_ms: null, last_seen: null, link: null, mcu_ok: false };
      }
      const data = snap.data() || {};
      const last = Number(data.last_seen) || 0;
      const age = last ? Date.now() - last : null;
      // 보드 시계가 몇 초 빠르면 age가 음수다. 그 경우도 방금 신호로 본다.
      const online = !!(last && age != null && age <= ONLINE_MS && age >= -20000);
      return {
        station,
        online,
        age_ms: age,
        last_seen: last || null,
        link: data.link || null,
        mcu_ok: data.mcu_ok !== false,
        wifi_rssi: data.wifi_rssi ?? null,
        wifi_ip: data.wifi_ip || null,
        name: data.name || null,
        ir1: data.ir1 === true,
        ir2: data.ir2 === true,
        rfid1: data.rfid1 || "",
        rfid2: data.rfid2 || "",
      };
    },

    async getDevicePresence(station = "A1") {
      const snap = await getDoc(doc(db, "stations", station));
      return this._presenceFromSnap(station, snap);
    },

    /** stations/{code} 실시간 구독 — IR/온라인을 폴링보다 빠르게 반영 */
    watchDevicePresence(station, onChange) {
      const code = station || "A1";
      return onSnapshot(
        doc(db, "stations", code),
        (snap) => {
          try { onChange(this._presenceFromSnap(code, snap)); } catch (_) { /* ignore */ }
        },
        (err) => {
          try { onChange({ station: code, online: false, error: String(err && err.message || err) }); } catch (_) { /* ignore */ }
        }
      );
    },

    /**
     * since 이후 station/slot 이벤트.
     * match(row) 가 있으면 통과한 첫 이벤트만 반환.
     */
    async getRecentDeviceEvent({ station, slot, since = 0, match } = {}) {
      if (!station) throw new Error("station 이 필요해요.");
      const snap = await getDocs(
        query(
          collection(db, "device_events"),
          where("station", "==", station),
          orderBy("created_at", "desc"),
          limit(20)
        )
      );
      return pickMatchingEvent(snap.docs.map(docData), { station, slot, since, match });
    },

    /** 문 닫힘 이벤트를 폴링 대신 수신. 반환값은 구독 해제 함수 */
    watchDeviceEvents(station, onChange) {
      const qy = query(
        collection(db, "device_events"),
        where("station", "==", station),
        orderBy("created_at", "desc"),
        limit(20)
      );
      return onSnapshot(
        qy,
        (snap) => {
          try { onChange(snap.docs.map(docData)); } catch (_) { /* ignore */ }
        },
        () => { /* 다음 스냅샷이나 타임아웃에 맡긴다 */ }
      );
    },

    async debugRecent() {
      requireUser();
      if ((auth.currentUser.email || "").toLowerCase() !== deviceEmail) {
        throw new Error("device 계정만 디버그 로그를 볼 수 있어요.");
      }
      const [cmds, evs, umbs] = await Promise.all([
        getDocs(query(collection(db, "commands"), orderBy("created_at", "desc"), limit(10))),
        getDocs(query(collection(db, "device_events"), orderBy("created_at", "desc"), limit(10))),
        getDocs(collection(db, "umbrellas")),
      ]);
      return {
        maxHwSlot: MAX_HW_SLOT, backend: "firebase",
        umbrellas: umbs.docs.map(docData),
        commands: cmds.docs.map(docData),
        events: evs.docs.map(docData),
      };
    },

    async health() {
      return { ok: true, backend: "firebase", maxHwSlot: MAX_HW_SLOT, projectId: fb.projectId };
    },
  };
}

// ---------- 선택된 어댑터 공개 ----------
export const backend = mode === "firebase" ? createFirebaseBackend() : createLocalBackend();

export const signup = (p) => backend.signup(p);
export const login = (p) => backend.login(p);
export const restoreSession = () => backend.restoreSession();
export const loginDevice = (password) => backend.loginDevice(password);
export const logoutUser = () => backend.logout();
export const getStationInventory = (s) => backend.getStationInventory(s);
export const getMyActiveRental = (uid) => backend.getMyActiveRental(uid);
export const rentUmbrella = (p) => backend.rent(p);
export const returnUmbrella = (p) => backend.return(p);
export const openDoor = (p) => backend.openDoor(p);
export const listStudents = () => backend.listStudents();
export const listAllUmbrellas = () => backend.listAllUmbrellas();
export const listActiveRentals = () => backend.listActiveRentals();
export const setUmbrellaStatus = (p) => backend.setUmbrellaStatus(p);
export const seedInventory = () => backend.seedInventory();
export const fetchNextCommand = (s) => backend.fetchNextCommand(s);
export const markCommandDone = (id) => backend.markCommandDone(id);
export const postDeviceEvent = (p) => backend.postDeviceEvent(p);
export const getRecentDeviceEvent = (p) => backend.getRecentDeviceEvent(p);
export const watchDeviceEvents = (station, cb) => backend.watchDeviceEvents(station, cb);
export const getDevicePresence = (s) => backend.getDevicePresence(s);
export const watchDevicePresence = (s, cb) => backend.watchDevicePresence(s, cb);
export const debugRecent = () => backend.debugRecent();
export const health = () => backend.health();

/** Firebase/서버 에러를 사용자용 문구로 변환 */
export function friendlyError(e) {
  const msg = String((e && e.message) || e || "");
  if (/invalid-credential|user-not-found|wrong-password/i.test(msg)) return "학번 또는 비밀번호가 맞지 않아요.";
  if (/email-already-in-use/i.test(msg)) return "이미 가입된 학번이에요.";
  if (/weak-password/i.test(msg)) return "비밀번호는 6~16자리로 입력해 주세요.";
  if (/invalid-email/i.test(msg)) return "학번 형식을 확인해 주세요.";
  if (/invalid-api-key|YOUR_API_KEY/i.test(msg)) return "firebase-config.js 설정을 확인해 주세요.";
  if (/permission-denied|Missing or insufficient permissions/i.test(msg)) return "권한이 없어요. 로그인 상태를 확인해 주세요.";
  if (/network|Failed to fetch/i.test(msg)) return "서버에 연결하지 못했어요.";
  return msg || "알 수 없는 오류가 발생했어요.";
}
