# UmbrellaLocker (UNO R4 WiFi)

슬롯 1·2 서보 / RFID / IR + Firebase 문열기.

## 통신

1. **WiFi (기본)** — 보드가 Firestore `commands`를 직접 폴링  
2. **USB 브리지 (백업)** — PC에서 `npm run bridge:firebase`

## 업로드 전 설정

[`UmbrellaLocker/UmbrellaLocker.ino`](UmbrellaLocker/UmbrellaLocker.ino) 상단:

```cpp
const char* WIFI_SSID = "공유기이름";
const char* WIFI_PASS = "비밀번호";
```

`FB_API_KEY` / `DEVICE_EMAIL` / `DEVICE_PASS` / `STATION_CODE`는  
웹 [`public/firebase-config.js`](../public/firebase-config.js)와 같아야 합니다.

## 유선으로 바로 테스트

1. 시리얼 모니터를 **닫고** (포트 점유 주의)
2. 프로젝트 루트: `npm run bridge:firebase`  (거점 기본값 A1/형남. 다른 거점이면 `STATION=C3 npm run bridge:firebase`)
3. https://umbrella-c8cf0.web.app/device.html 에서 문열기

웹 반납은 Firestore `commands.action = open_return` 을 넣고, 보드는 IR(+RFID) 확인 후 `return_ok` → `auto_close_return` 이벤트를 올립니다. 앱은 그 이벤트를 보고 문을 닫습니다.

보드 시리얼 9600: `[BOOT] ready`, 유선이면 `[LINK] WIRED`, WiFi면 `[AUTH] OK` / `[CMD/WIFI]`.
