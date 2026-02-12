# Speak Oculus

<p align="center">
  <img src="https://github.com/user-attachments/assets/d6062586-84b2-427b-a16a-1af01fb104bd" width="300">
</p>

A real-time Voice AI language tutor that combines live conversation, computer vision, and spaced vocabulary tracking into a FaceTime-like mobile experience.

Point your camera at an object, and the AI sees it and weaves it into the conversation in your target language.

---

## How It Works

You pick a tutor persona (e.g. "Marie — French"), tap call, and start talking. The AI speaks back in your target language, corrects you naturally by recasting (not lecturing), and remembers vocabulary you struggle with across sessions. Hold your phone steady over an object and the AI will see it and bring it into the conversation.

---

## Architecture

Speak Oculus follows a three-tier WebSocket architecture:

```
React Native App  ←— WebSocket —→  Node.js Relay (EC2)  ←— WebSocket —→  OpenAI Realtime API
```

**Mobile Client** — React Native (Expo SDK 50+). Handles audio recording/playback, camera capture, accelerometer-based stability detection, and all UI animations. Runs on both iOS and Android.

**Relay Server** — A lightweight Node.js WebSocket proxy on AWS EC2 (us-east-1). Exists for two reasons: (1) the OpenAI API key never touches the client, and (2) deploying right beside OpenAI's servers saves ~200ms of round-trip latency. Beyond forwarding bytes, the relay handles image injection into OpenAI's multimodal format and the vocabulary tracking tool loop.

**OpenAI Realtime API** — `gpt-realtime-mini`. Handles all the heavy lifting: voice activity detection (VAD), Whisper transcription, response generation, audio synthesis, tool calling, and vision. The relay is intentionally thin so OpenAI does the work.

---

## Latency Breakdown

End-to-end latency from "user stops speaking" to "AI audio hits the speaker" breaks down roughly as:

| Segment | Estimated Latency | Notes |
|---------|-------------------|-------|
| Client → Relay | ~30–80ms | Depends on user's network. Audio sent as 40ms PCM16 chunks over WebSocket. |
| Relay → OpenAI | ~5–15ms | Both in us-east-1. Near-zero network hop. |
| OpenAI processing | ~300–800ms | VAD tail silence + model inference + first audio chunk generation. This dominates. |
| OpenAI → Relay | ~5–15ms | Same region return path. |
| Relay → Client | ~30–80ms | Return path to device. |
| Audio scheduling | ~0–20ms | Gapless playback algorithm buffers the first chunk before starting. |
| **Total (typical)** | **~500** | **Perceived as near-conversational.** |

### Why the relay saves ~200ms

Without the relay, the client would connect directly to OpenAI from wherever the user is. A phone on a typical consumer network adds 100–200ms of round-trip latency to a US-East data center. By placing the relay on EC2 in the same region as OpenAI, the client-to-relay hop is the only variable segment the relay-to-OpenAI hop is negligible (~10ms). This effectively removes one full network traversal from the critical path.

### Barge-in latency (interrupting the AI)

The app has two interrupt paths:

- **Client-side optimistic interrupt: ~120ms.** Hardware echo cancellation (Android `audioSource: 7`) produces an echo-free mic signal. When 3 consecutive 40ms audio frames exceed the speech threshold, playback stops instantly — no round-trip needed.
- **Server-side VAD (fallback): ~300–600ms.** OpenAI's VAD detects speech and sends `speech_started` back through the relay. This is the backup path; the client has usually already interrupted 200–500ms earlier.

### Vision latency

When the user holds the camera steady for 1.2 seconds, the app captures a frame, crops and compresses it to a 384×384 JPEG (~25KB), and sends it through the relay to OpenAI. The image is small enough to transmit in ~200ms on 4G. OpenAI then processes the image and responds with audio — total time from capture to AI speech is roughly 1–3 seconds depending on network and model load.

---

## Key Features

- **Real-time voice conversation** — Full-duplex audio over WebSocket. 24kHz PCM16, 40ms chunks. Gapless playback scheduling eliminates audio gaps from network jitter.
- **Computer vision** — Accelerometer-based stability detection triggers automatic photo capture. The AI sees what you see and discusses it in your target language.
- **Vocabulary tracking** — When you drop an English word mid-sentence, the AI logs it as a "gap word," recasts it naturally, and remembers it for future sessions. Based on SLA research: recast > lecture, one correction per turn, three-turn cooldown.
- **Optimistic barge-in** — Interrupt the AI mid-sentence with near-zero perceived delay using client-side speech detection on the AEC-cleaned mic signal.
- **Hardware echo cancellation** — `VOICE_COMMUNICATION` audio source routes mic input through the device's AEC pipeline, reducing echo RMS to 0.0000 during AI playback.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Mobile | React Native, Expo SDK 50+, Reanimated, expo-camera, expo-sensors |
| Audio | react-native-audio-record, react-native-audio-api, InCallManager |
| Server | Node.js, ws, PM2, AWS EC2 (us-east-1) |
| AI | OpenAI Realtime API (gpt-realtime-mini), Whisper, server-side VAD |
| Storage | AsyncStorage (client-side persistence for call history, agents, gap words) |

---

## Project Structure

```
SpeakOculusExpo/
├── app/
│   └── App.tsx                  # Main screen: audio pipeline, WebSocket, state machine, vision
├── components/
│   ├── ActiveOrb.tsx            # Animated viewfinder crosshair (UI-thread animations)
│   ├── Viewfinder.tsx           # Camera view with permissions
│   ├── CallHistoryScreen.tsx    # Home screen, agent management
│   ├── GapWordsScreen.tsx       # Per-agent vocabulary review
│   ├── ControlSheet.tsx         # In-call controls
│   └── StatusPill.tsx           # Connection status indicator
├── hooks/
│   └── useCameraStability.ts    # Accelerometer stability detection (SharedValues)
├── storage/
│   └── index.ts                 # AsyncStorage CRUD
└── server/
    └── server.ts                # Relay server: WebSocket proxy, vision injection, Friend Loop
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Expo CLI
- An OpenAI API key with Realtime API access

### Run the relay server

```bash
cd server
echo "OPENAI_API_KEY=sk-proj-..." > .env   # Add your key
npm install
npm run build
cp .env dist/.env
node dist/server.js
```

### Run the mobile app

```bash
npm install
npx expo start
```

Set the relay URL via `EXPO_PUBLIC_RELAY_URL` in `app/.env` (see `app/.env.example`), or it falls back to `localhost:8082`.

---

## Design Document

For a deep-dive into PCM16 pipeline, barge-in detection, animation system, backpressure strategy, memory budgets see [DESIGN.md](./DESIGN.md).
