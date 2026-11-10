/**
 * 숭실대 캠퍼스 우산 보관함 지도 (카카오맵 JS SDK)
 * 키: window.UMBRELLA.kakaoMapAppKey (firebase-config.js)
 */
import { STATIONS, CAMPUS_CENTER, MAX_HW_SLOT, TOTAL_SLOTS } from "/js/backend.js?v=96";

let map = null;
let overlays = {};
let selectedCode = null;
let onSelect = null;
let sdkPromise = null;

function getAppKey() {
  const key = window.UMBRELLA && window.UMBRELLA.kakaoMapAppKey;
  if (!key || key === "YOUR_KAKAO_JAVASCRIPT_KEY") return "";
  return String(key).trim();
}

function pinHtml(active, live) {
  const color = !live ? "#9AA3AF" : active ? "#007AA3" : "#009BCB";
  return `
    <div class="map-pin ${active ? "on" : ""} ${live ? "" : "soon"}" style="--pin:${color}">
      <span class="map-pin-dot">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M12 3c-3.2 0-5.8 2.2-6.6 5.1C3.7 8.4 2.5 9.9 2.5 11.7c0 .4.3.8.8.8h17.4c.4 0 .8-.4.8-.8 0-1.8-1.2-3.3-2.9-3.6C17.8 5.2 15.2 3 12 3z" fill="#fff"/>
          <path d="M12 12.5v6.5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </span>
      <span class="map-pin-tail"></span>
    </div>`;
}

/** script 태그로만 로드 (fetch 프로브는 CORS로 localhost에서 실패함) */
function loadKakaoSdk(appKey) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const fail = (message) => {
      sdkPromise = null;
      reject(new Error(message));
    };
    const done = () => {
      if (!window.kakao || !window.kakao.maps) {
        fail("카카오맵 SDK를 불러오지 못했어요.");
        return;
      }
      window.kakao.maps.load(() => resolve());
    };
    if (window.kakao && window.kakao.maps) {
      done();
      return;
    }
    const existing = document.querySelector("script[data-kakao-maps]");
    if (existing) {
      existing.addEventListener("load", done);
      existing.addEventListener("error", () =>
        fail(domainHint("카카오맵 스크립트 로드 실패"))
      );
      return;
    }
    const script = document.createElement("script");
    script.dataset.kakaoMaps = "1";
    script.async = true;
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`;
    script.onload = done;
    script.onerror = () => fail(domainHint("카카오맵 스크립트 로드 실패"));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

function domainHint(prefix) {
  const host = location.origin;
  return (
    `${prefix}. 현재 주소는 ${host} 입니다. ` +
    "카카오 콘솔 JavaScript 키 SDK 도메인에 이 주소를 그대로 등록해 주세요. " +
    "(localhost 와 127.0.0.1 은 서로 다른 도메인입니다.)"
  );
}

function showMapError(container, message) {
  container.innerHTML = `
    <div class="map-error">
      <strong>지도를 열 수 없어요</strong>
      <p>${message}</p>
      <p class="map-error-hint">
        카카오 콘솔 → 앱 → <b>제품 설정 → 카카오맵 → 사용 ON</b><br>
        JavaScript 키 SDK 도메인 예시:<br>
        https://umbrella-c8cf0.web.app<br>
        http://localhost:3000<br>
        http://127.0.0.1:3000
      </p>
    </div>`;
}

function makeOverlay(station, active) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "map-pin-btn";
  el.setAttribute("aria-label", station.name);
  el.innerHTML = pinHtml(active, station.live !== false);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    selectStation(station.code, true);
    if (onSelect) onSelect(station);
  });
  return new kakao.maps.CustomOverlay({
    position: new kakao.maps.LatLng(station.lat, station.lng),
    content: el,
    xAnchor: 0.5,
    yAnchor: 1,
    zIndex: active ? 10 : 1,
  });
}

function fitCampusPins() {
  if (!map) return;
  const bounds = new kakao.maps.LatLngBounds();
  let n = 0;
  for (const s of STATIONS) {
    if (s.lat == null || s.lng == null) continue;
    bounds.extend(new kakao.maps.LatLng(s.lat, s.lng));
    n += 1;
  }
  if (!n) {
    map.setCenter(new kakao.maps.LatLng(CAMPUS_CENTER.lat, CAMPUS_CENTER.lng));
    map.setLevel(Math.min(5, Math.max(2, 21 - (CAMPUS_CENTER.zoom || 17))));
    return;
  }
  // top, right, bottom, left — 핀·건물명이 화면 가장자리에 안 잘리게
  map.setBounds(bounds, 72, 56, 120, 56);
}

export async function initCampusMap(container, { onStationSelect } = {}) {
  onSelect = onStationSelect || null;
  const appKey = getAppKey();
  if (!appKey) {
    showMapError(
      container,
      "카카오맵 JavaScript 키가 아직 없어요. firebase-config.js 에 kakaoMapAppKey 를 넣어 주세요."
    );
    return null;
  }

  try {
    await loadKakaoSdk(appKey);
  } catch (e) {
    showMapError(container, e.message || String(e));
    return null;
  }

  if (map) {
    setTimeout(() => {
      map.relayout();
      fitCampusPins();
    }, 80);
    return map;
  }

  container.innerHTML = "";
  const center = new kakao.maps.LatLng(CAMPUS_CENTER.lat, CAMPUS_CENTER.lng);
  map = new kakao.maps.Map(container, {
    center,
    level: Math.min(5, Math.max(2, 21 - (CAMPUS_CENTER.zoom || 17))),
  });

  for (const s of STATIONS) {
    if (s.lat == null || s.lng == null) continue;
    const overlay = makeOverlay(s, false);
    overlay.setMap(map);
    overlays[s.code] = overlay;
  }

  setTimeout(() => {
    map.relayout();
    fitCampusPins();
  }, 100);
  return map;
}

export function selectStation(code, pan = false) {
  selectedCode = code;
  for (const s of STATIONS) {
    if (!overlays[s.code]) continue;
    overlays[s.code].setMap(null);
    const next = makeOverlay(s, s.code === code);
    next.setMap(map);
    overlays[s.code] = next;
  }
  const s = STATIONS.find((x) => x.code === code);
  if (pan && s && map) {
    map.panTo(new kakao.maps.LatLng(s.lat, s.lng));
  }
}

export function clearStationSelection() {
  selectedCode = null;
  for (const s of STATIONS) {
    if (!overlays[s.code]) continue;
    overlays[s.code].setMap(null);
    const next = makeOverlay(s, false);
    next.setMap(map);
    overlays[s.code] = next;
  }
}

export function resizeCampusMap() {
  if (!map) return;
  setTimeout(() => {
    map.relayout();
    fitCampusPins();
  }, 60);
}

export function summarizeSlots(slots) {
  let rentable = 0;
  let returnable = 0;
  const detail = [];
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    if (i > MAX_HW_SLOT) {
      detail.push({ slot: i, status: "prep", label: "준비중" });
      continue;
    }
    const st = slots && slots[i];
    if (st === "in") {
      rentable += 1;
      detail.push({ slot: i, status: "in", label: "대여가능" });
    } else if (st === "out") {
      returnable += 1;
      detail.push({ slot: i, status: "out", label: "반납가능" });
    } else {
      detail.push({ slot: i, status: "prep", label: "준비중" });
    }
  }
  return { rentable, returnable, detail, maxHw: MAX_HW_SLOT, total: TOTAL_SLOTS };
}

/** 미운영 거점: 1~6칸 모두 준비중 */
export function plannedSlotDetail() {
  const detail = [];
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    detail.push({ slot: i, status: "prep", label: "준비중" });
  }
  return detail;
}

export function getSelectedCode() {
  return selectedCode;
}
