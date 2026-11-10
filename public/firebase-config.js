// Umbrella (umbrella-c8cf0) — Hosting + Auth + Firestore only (Functions 없음)
window.UMBRELLA = {
  backend: "firebase",
  cost: {
    bridgePollMs: 400,
    uiRefreshMs: 2000,
    maxHwSlot: 2
  },
  firebase: {
    apiKey: "AIzaSyDoS0nXsS8lGBULN-U-WcLs51aqWC4lZfk",
    authDomain: "umbrella-c8cf0.firebaseapp.com",
    projectId: "umbrella-c8cf0",
    storageBucket: "umbrella-c8cf0.firebasestorage.app",
    messagingSenderId: "551092351154",
    appId: "1:551092351154:web:a84c844e64173aee0bd9ab",
    measurementId: "G-RE1CZ03B5P"
  },
  // 카카오 개발자 콘솔 > 앱 > JavaScript 키
  // SDK 도메인에 아래를 각각 등록 (localhost ≠ 127.0.0.1):
  //   https://umbrella-c8cf0.web.app
  //   http://localhost:3000
  //   http://127.0.0.1:3000
  kakaoMapAppKey: "849e1b3b73f4033abff2609124090bda",
  // device 비밀번호는 공개 설정에 두지 않음.
  // - 브리지: device-secrets.local.js 또는 DEVICE_PASSWORD
  // - admin/device.html: 로그인 시 입력
  deviceEmail: "device@umbrella.local"
};
