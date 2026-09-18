# Cascade mobile app (Expo / React Native)

A minimal phone companion for the leak-detection rig: live branch flows, leak status, valve and pump controls, event log. It is a WebSocket *viewer* of the same server the web dashboard uses (`docs/PROTOCOL.md`). Product name and colours come from the server's `branding.json`; the copy bundled here is only the pre-connect default.

## Run it on your phone (no Android SDK or Xcode needed)

1. Install **Expo Go** from the Play Store / App Store on the phone.
2. Phone and laptop on the same Wi-Fi (the fair hotspot is fine).
3. On the laptop:
   ```
   cd mobile
   npm install
   npx expo start
   ```
4. Scan the QR code in the terminal with Expo Go (Android) or the Camera app (iOS).
5. The app looks for the rig server on the same laptop it was loaded from, so there is nothing to type. Only if the server runs on another machine, open **Settings** and enter its address, e.g. `192.168.0.3:3000`.

Nothing is installed permanently; Expo Go loads the JavaScript from the laptop each time. If the phone cannot reach the laptop, try `npx expo start --tunnel`.

## Test on the laptop

```
npx expo start --web        # opens http://localhost:8081 in the browser
npm run typecheck           # tsc --noEmit
npx expo-doctor
```
Run the server (`pnpm -C web dev`) and the simulator (`pnpm -C web fake`) first, then point Settings at `localhost:3000`.

## Build a standalone Android APK (later)

Option A, cloud build with a free Expo account:
```
npm install -g eas-cli
eas login
eas build -p android --profile preview
```
Option B, local build: install Android Studio + SDK command-line tools, then `npx expo run:android`.

Because the server is reached over plain `ws://` on the LAN, a standalone Android build must allow cleartext traffic. Expo Go already does. For EAS/local builds add the `expo-build-properties` plugin to `app.json`:
```json
["expo-build-properties", { "android": { "usesCleartextTraffic": true } }]
```

## Files

| File | Purpose |
|---|---|
| `app/_layout.tsx` | Tabs (Dashboard, Events, Settings), theme from branding, starts the socket |
| `app/index.tsx` | Dashboard: status line with All off, four stat tiles (water in, valve control mode, water lost, turbidity/TDS), Branches card with the automatic-mode switch, valve switches, pump and Clear leak buttons |
| `app/events.tsx` | Event log, newest first |
| `app/settings.tsx` | Server URL (persisted), connection state, rig id and IP |
| `lib/store.ts` | External store, `useRig(selector)`, `sendCmd()` (same shape as the web store) |
| `lib/socket.ts` | WebSocket client with reconnect/backoff, URL persistence |
| `lib/format.ts` | Number/time formatting, event and error descriptions |
| `lib/ui.tsx` | Card / Tile / Badge / Btn primitives following `docs/DESIGN.md` v2 (neutral dark, radius 10, tabular numerals) |
| `metro.config.js` | Lets the app import `../packages/protocol` and `../branding.json` |
