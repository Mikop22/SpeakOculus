# Speak Oculus
Practice language in any environment by FaceTiming an AI Agent (wow we've really hit dystopia...)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [The Relay Server](#3-the-relay-server)
4. [The Mobile Client](#4-the-mobile-client)
5. [The Audio Pipeline](#5-the-audio-pipeline)
6. [The Vision System](#6-the-vision-system)
7. [The Friend Loop (EdTech Engine)](#7-the-friend-loop-edtech-engine)
8. [The Animation System](#8-the-animation-system)
9. [The Stability Detection System](#9-the-stability-detection-system)
10. [State Management & Data Flow](#10-state-management--data-flow)
11. [Performance Architecture](#11-performance-architecture)
12. [Security Model](#12-security-model)
13. [File Map & Module Responsibilities](#13-file-map--module-responsibilities)

---

## 1. Executive Summary

**Speak Oculus is a real-time Voice AI language tutor that combines:

- **Real-time voice conversation** with an AI that speaks the target language
- **Computer vision** that lets the AI see and discuss objects the user points their camera at
- **Spaced vocabulary tracking** that remembers words the user struggles with across sessions

The system architecture follows a **three-tier model**:

```
Mobile App  <--WebSocket-->  Node.js Relay  <--WebSocket-->  OpenAI Realtime API
(React Native)               (AWS EC2)                       (gpt-realtime-mini)
```

The relay server exists for 2 reasons: **the OpenAI API key never touches the client** and **Deploying the server right beside OpenAI saves like 200ms**. Everything else, like audio encoding, VAD, turn-taking, response generation -- is handled by OpenAI's Realtime API. The relay is a stateful passthrough with two responsibilities beyond forwarding bytes: (1) image injection and (2) the vocabulary tracker.

---

## 2. System Architecture

### 2.1 The Three Tiers

```
+-------------------------------+
|       MOBILE CLIENT           |
|  React Native (Expo SDK 50+)  |
|                               |
|  Audio In:  react-native-     |
|             audio-record      |
|  Audio Out: react-native-     |
|             audio-api          |
|  Camera:    expo-camera       |
|  Sensors:   expo-sensors      |
|  Animation: react-native-     |
|             reanimated         |
+-------------------------------+
           |  WebSocket (ws://)
           |  PCM16 Base64 + JSON events
           v
+-------------------------------+
|       RELAY SERVER            |
|  Node.js + ws library         |
|  AWS EC2 (us-east-1)          |
|  Port 8082, managed by PM2    |
|                               |
|  - 1:1 Session Proxy          |
|  - Image Injection            |
|  - Gap Words Tool             |
|  - Zombie Socket Detection    |
+-------------------------------+
           |  WebSocket (wss://)
           |  OpenAI Realtime Protocol
           v
+-------------------------------+
|    OPENAI REALTIME API        |
|  gpt-realtime-mini-2025-12-15 |
|                               |
|  - Server-side VAD            |
|  - Whisper transcription      |
|  - Audio generation (Alloy)   |
|  - Tool calling               |
|  - Vision (multimodal input)  |
+-------------------------------+
```

### 2.2 Why a Relay?

The relay exists because:

1. **Security**: The OpenAI API key (`sk-proj-...`) must never be on the client device. The relay injects the `Authorization` header server-side.
2. **Vision Injection**: The Realtime API expects multimodal content in a specific `conversation.item.create` format. The relay translates the client's simple `{ type: 'vision.direct_injection', image: <base64> }` into the correct API payload.
3. **Friend Loop**: Tool call responses (`log_gap_word`) are intercepted by the relay, stored in session memory, and injected back into the system prompt via `session.update`. The client never sees the raw tool call mechanics.

### 2.3 The Protocol

All communication uses **WebSocket JSON messages**. Audio is embedded as Base64-encoded PCM16 within JSON payloads. There is no binary framing -- everything is text.

**Client -> Relay messages:**

| Type | Purpose |
|------|---------|
| `input_audio_buffer.append` | 40ms audio chunk (PCM16 Base64) |
| `vision.direct_injection` | Camera frame (JPEG Base64, 384x384) | (kept it small to drop latency)
| `agent.config` | Set persona (name + language) |
| `conversation.item.truncate` | Barge-in truncation metadata |

**Relay -> Client messages (passthrough from OpenAI + custom):**

| Type | Purpose |
|------|---------|
| `session.created` | Connection established |
| `response.audio.delta` | AI audio chunk |
| `input_audio_buffer.speech_started` | VAD: user started speaking |
| `input_audio_buffer.speech_stopped` | VAD: user stopped speaking |
| `response.audio_transcript.delta` | AI transcript chunk (streaming) |
| `response.created` | New response starting |
| `response.function_call_arguments.done` | Tool call completed |
| `gap_word.logged` | Custom: vocabulary gap recorded |

---

## 3. The Relay Server

**File:** `server/server.ts` (739 lines)

### 3.1 Session Lifecycle

Each WebSocket connection from a mobile client triggers a 1:1 OpenAI session:

```
Client connects
    |
    v
Relay opens WebSocket to OpenAI Realtime API
    |
    v
OpenAI handshake complete -> Send session.update (config + tools)
    |
    v
If pendingAgentConfig exists -> Apply Friend Mode prompt
    |
    v
Start ping/pong heartbeat (30s interval)
    |
    v
[... bidirectional message forwarding ...]
    |
    v
Either side disconnects -> cleanup() called
    |
    v
Both sockets closed, listeners removed, state nulled
```

### 3.2 Session State

Each connection maintains these session-scoped variables:

```typescript
let gapWords: Array<{ native: string; target: string }> = [];  // Max 50, FIFO eviction
let baseInstructions = DEFAULT_INSTRUCTIONS;                     // Set by agent.config
let pendingAgentConfig: { name: string; language: string } | null = null;
let contextUpdateTimer: NodeJS.Timeout | null = null;           // 2s debounce
let isCleanedUp = false;                                         // Prevent double-cleanup
let clientIsAlive = true;                                        // Zombie detection
let openAiIsAlive = true;                                        // Zombie detection
```

### 3.3 The Cleanup Function

`cleanup()` is the most critical function in the server. It prevents **zombie sessions** (OpenAI sessions that stay open after the client disconnects and consume API credits, I only put in $5 so this was a must).

```
cleanup(reason) triggers when:
  - Client socket closes (normal disconnect)
  - Client socket errors
  - OpenAI socket closes
  - OpenAI socket errors
  - Zombie detection (missed pong)
```

Cleanup performs:
1. Clear the debounce timer (prevents stale `session.update`)
2. Clear the ping interval
3. Close both sockets
4. Remove all event listeners (breaks closure references for GC)
5. Null out session state (`gapWords = []`, `baseInstructions = ''`)

### 3.4 Bounded Growth Guarantees

The server enforces strict bounds to prevent memory leaks during long sessions:

| Resource | Bound | Mechanism |
|----------|-------|-----------|
| Gap words | 50 max | FIFO eviction via `shift()` |
| Instructions | 8,000 chars | Hard truncation |
| Context window | Last 3 gap words | Sliding window in rebuild |
| Image payload | ~6.67M chars | Rejection + client notification |
| Client message | 10MB | `ws` `maxPayload` option |
| Audio buffer | 64KB | Backpressure drop |
| Vision buffer | 128KB | Backpressure drop |

### 3.5 Backpressure Strategy

The `ws` library buffers outgoing data in memory. If the network is slow, `bufferedAmount` grows unbounded. The relay handles this:

```typescript
// Audio: Drop frames above 64KB buffer
if (messageType === 'input_audio_buffer.append' && openAiWs.bufferedAmount > 64 * 1024) {
    return; // Drop this frame, next one will arrive in 40ms
}

// Vision: Drop frames above 128KB buffer
if (openAiWs.bufferedAmount > 128 * 1024) {
    return; // Log warning, skip this capture
}

// Monitoring: Log warnings above 32KB during heartbeat
if (openAiWs.bufferedAmount > 32 * 1024) {
    console.warn(`Buffer warning: ${openAiWs.bufferedAmount}B`);
}
```

Audio frame drops are invisible to the user because they happen at 25fps (40ms intervals). A single dropped frame means 40ms of silence, which is below human perception threshold (~100ms).

### 3.6 Zombie Socket Detection

The relay uses WebSocket ping/pong to detect dead connections:

```
Every 30 seconds:
  1. Check clientIsAlive flag
     - false? -> ws.terminate() (hard kill, triggers 'close' event)
  2. Set clientIsAlive = false
  3. Send ping to client

Client responds with pong:
  -> clientIsAlive = true

(Same pattern for OpenAI socket)
```

This catches scenarios where the mobile app crashes without sending a close frame (e.g., user force-quits the app, phone dies, network drops).

---

## 4. The Mobile Client

**File:** `app/App.tsx` (1,327 lines)

### 4.1 Component Architecture

```
App (root)
  |
  +-- SafeAreaProvider
       |
       +-- MainScreen
            |
            +-- Viewfinder (Layer 1: camera background)
            |
            +-- UI Layer (Layer 2: call UI)
            |    |
            |    +-- StatusPill (top: connection status)
            |    +-- ActiveOrb (center: viewfinder crosshair)
            |    +-- AI Transcript (subtitle bubble, between orb and controls)
            |    +-- ControlSheet (bottom: controls)
            |
            +-- CallHistoryScreen (Layer 3: home screen)
            |
            +-- GapWordsScreen (Layer 4: vocabulary review)
```

### 4.2 State Machine

The app has a clear state machine driven by `interactionMode: OrbMode`:

```
                    session.created
    [OFFLINE] ----------------------> [LISTENING]
                                          |
                                          | speech_stopped (VAD)
                                          v
                                     [PROCESSING]
                                          |
                                          | response.audio.delta
                                          v
                                      [SPEAKING]
                                          |
                    +-----------+---------+--------------+
                    |           |                        |
                    | playback  | speech_started         | Client-side RMS
                    | ends      | (server barge-in)      | barge-in (optimistic
                    v           v                        | interrupt)
                 [IDLE]    [LISTENING]              [LISTENING]
```

> **Two Barge-In Paths:** The `SPEAKING -> LISTENING` transition can happen via (1) the server-side `speech_started` event from OpenAI's VAD, or (2) the **client-side optimistic interrupt** when RMS on the AEC-cleaned mic signal exceeds the ambient floor. The optimistic path is faster (~0ms vs 200-500ms round trip). Both paths call `stopAudioPlayback()` and set mode to `listening`.

Each state maps to visual changes in the ActiveOrb:

| State | Orb Appearance | Audio Behavior |
|-------|---------------|----------------|
| `idle` | Grey border, breathing animation | Mic on, no AI audio |
| `listening` | Green border, volume-reactive scale | Mic sending to relay |
| `processing` | White border, fast pulse | Waiting for AI response |
| `speaking` | Green border, ripple effect | AI audio playing, mic AEC-cleaned |

### 4.3 The Connection Flow

```typescript
// User taps agent in CallHistoryScreen -> onConnect(agentConfig)
connect(config) {
  1. Set UI state (agent name, "Connecting...")
  2. Open WebSocket to relay
  3. ws.onopen -> Start InCallManager (hardware AEC)
                -> InCallManager.setSpeakerphoneOn(true)  // Route to speaker, not earpiece
                -> Send agent.config { name, language }
  4. Wait for "session.created" from relay
  5. On session.created -> Start AudioRecord -> Set mode to "listening"
}

disconnect() {
  1. Save session to call history (duration, agent config)
  2. Stop recording + playback
  3. Stop InCallManager
  4. Close WebSocket
  5. Reset UI state
  6. Reset barge-in tracking (consecutiveAbove = 0)
}
```
> **Transcript reset:** On each new `connect()`, the AI transcript state and subtitle queue are cleared so no stale text from a previous call lingers on screen.

> **Android Speaker Routing:**
> **Android Speaker Routing:** `InCallManager.start({ media: 'audio' })` routes audio to the **earpiece** by default on Android. Without `setSpeakerphoneOn(true)`, the user hears nothing from the speaker. This is a critical one-liner that's easy to miss.

### 4.4 The Ref Pattern (Avoiding Stale Closures)

Audio callbacks (`AudioRecord.on('data', ...)`) are registered once and persist for the entire session. React state changes don't update the closure. The app uses refs to bridge this gap:

```typescript
// State for UI rendering
const [isMuted, setIsMuted] = useState(false);
const [interactionMode, setInteractionMode] = useState<OrbMode>('idle');

// Refs for audio/WebSocket callbacks
const isMutedRef = useRef(false);
const interactionModeRef = useRef<OrbMode>('idle');

// Sync state -> ref on every change
useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
useEffect(() => { interactionModeRef.current = interactionMode; }, [interactionMode]);

// In audio callback (registered once):
AudioRecord.on('data', (base64Data) => {
  if (isMutedRef.current) return;  // Always reads current value
  // ...
});
```

---

## 5. The Audio Pipeline

### 5.1 Recording (Client -> Relay)

```
Microphone (hardware)
    |
    | PCM16, 24kHz, mono
    v
react-native-audio-record
    |
    | Base64 string, every 40ms (1,920 bytes = 960 samples)
    v
AudioRecord.on('data', callback)
    |
    +-- Calculate RMS for visualization
    |     Uses DataView.getInt16() for zero-allocation reads
    |
    +-- Check mute state (via ref)
    +-- Check vision pause flag
    +-- Barge-in detection (if AI is speaking, on AEC-cleaned signal)
    |
    v
WebSocket.send({ type: 'input_audio_buffer.append', audio: base64 })
    |
    | JSON over WebSocket
    v
Relay (passthrough) -> OpenAI Realtime API
```

### 5.2 Playback (OpenAI -> Client)

```
OpenAI Realtime API
    |
    | response.audio.delta { delta: <base64> }
    v
Relay (passthrough) -> Client WebSocket
    |
    v
handleMessage() switch case
    |
    v
scheduleAudioChunk(base64Delta)
    |
    +-- Decode Base64 -> Buffer -> Int16Array
    +-- Convert Int16Array -> Float32Array (Web Audio requirement)
    +-- Create AudioBuffer (1 channel, 24kHz)
    +-- Create BufferSourceNode
    +-- Schedule gapless: startTime = max(currentTime, nextStartTime)
    +-- Advance nextStartTime += buffer.duration
    |
    v
AudioContext.destination (speaker)
```

### 5.3 The Gapless Playback Algorithm

The most subtle part of the audio pipeline is gapless scheduling. AI audio arrives as a stream of small chunks (typically 20-100ms each). If we play each chunk immediately when it arrives, network jitter causes audible gaps. Instead:

```typescript
// nextStartTimeRef tracks when the LAST scheduled chunk ends
const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
source.start(startTime);
nextStartTimeRef.current = startTime + audioBuffer.duration;
```

- If `nextStartTime > currentTime`: We're ahead of the playback cursor. Schedule this chunk right after the previous one. No gap.
- If `nextStartTime < currentTime`: We've underrun (network was slow). Schedule immediately. This creates a tiny gap, but recovers instantly.

### 5.4 Barge-In (Interrupting the AI)

Barge-in has two independent detection paths. Both stop AI playback immediately.

#### Path A: Server-Side VAD (Fallback)

```
1. [Server-side VAD] OpenAI detects speech energy in incoming audio
2. [Server sends] input_audio_buffer.speech_started
3. [Relay forwards] to client immediately
4. [Client receives] in handleMessage()
5. [Client calculates] how much AI audio actually played:
     audioEndMs = (ctx.currentTime - responseStartTime) * 1000
6. [Client sends] conversation.item.truncate { item_id, audio_end_ms }
7. [Client calls] stopAudioPlayback()
8. [Client sets] interactionMode = 'listening'
```

#### Path B: Client-Side Optimistic Interrupt (Primary)

With hardware AEC active (via `audioSource: 7` / VOICE_COMMUNICATION), the mic signal is echo-free during AI playback (echo RMS ≈ 0.0000). The client detects barge-in by checking for speech on this cleaned signal:

```
1. [Audio callback] RMS calculated for every 40ms audio chunk
2. [AEC] Hardware echo cancellation has already removed speaker echo
     from the mic signal — cleaned RMS reflects only real ambient/speech
3. [Threshold] threshold = max(ambientFloor * 3, 0.02)
4. [Frame test] If RMS > threshold -> increment consecutive counter
5. [Confirmation] If 3 consecutive frames (120ms) exceed threshold:
     -> BARGE-IN CONFIRMED
6. [Optimistic interrupt] Client IMMEDIATELY:
     a. Sends conversation.item.truncate with audio_end_ms
     b. Calls stopAudioPlayback() (stops AI audio output)
     c. Sets interactionMode = 'listening' (visual feedback)
     d. Resets consecutiveAbove counter
7. [Audio always flows] All mic audio (including during playback) is
     forwarded to OpenAI, enabling server-side VAD as backup
8. [Server catches up] OpenAI's VAD eventually sends speech_started,
     but client has already stopped playback 200-500ms earlier
```

**Why optimistic?** The client doesn't wait for the server to confirm barge-in. It stops playback the moment it's confident the user is speaking. This eliminates the 200-500ms round-trip latency to OpenAI, making interruptions feel instant.

The truncation event is critical for conversation coherence. Without it, OpenAI thinks the user heard the full response, leading to confused context.

### 5.5 Echo Prevention Strategy

The app uses a **two-layer approach** to prevent the AI from hearing its own speaker output and triggering false barge-ins.

**Layer 1: Hardware AEC** (primary — eliminates echo entirely)

The critical configuration is using `audioSource: 7` (VOICE_COMMUNICATION) for the AudioRecord. This routes mic input through Android's built-in echo cancellation pipeline (AcousticEchoCanceler), which removes speaker output from the mic signal before our code ever sees it.

```typescript
// AudioRecord configuration
const AUDIO_RECORD_OPTIONS = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 7,    // VOICE_COMMUNICATION — enables hardware AEC pipeline
  bufferSize: 1920,  // 40ms chunks at 24kHz
};

// Audio routing setup (on connect)
InCallManager.start({ media: 'audio' });
InCallManager.setSpeakerphoneOn(true);  // Required on Android for speaker output
```

**Why `audioSource: 7` matters:** The previous value (`audioSource: 6` / VOICE_RECOGNITION) bypassed the device's echo cancellation entirely. Echo RMS during AI playback measured 0.04–0.83 — completely overlapping with user speech (0.015–0.11), making RMS-based barge-in detection impossible. After switching to VOICE_COMMUNICATION, echo RMS dropped to **0.0000**, meaning the cleaned mic signal contains only ambient noise and user speech.

**Layer 2: Consecutive Frame Requirement** (spike filtering)

With hardware AEC, the cleaned signal is near-silent during AI playback. The barge-in threshold is simply a multiple of the ambient noise floor. To filter transient spikes (door closing, phone shifting), 3 consecutive frames (~120ms) must exceed the threshold:

```typescript
const BARGE_IN_CONSECUTIVE_FRAMES = 3;

// During AI playback:
const threshold = Math.max(ambientFloorRef.current * 3, 0.02);
if (rms > threshold) {
  consecutiveAbove++;
  if (consecutiveAbove >= BARGE_IN_CONSECUTIVE_FRAMES) {
    stopAudioPlayback();           // Optimistic interrupt
    setInteractionMode('listening');
  }
} else {
  consecutiveAbove = 0;
}
```

**Ambient calibration:** Before the AI speaks for the first time, 25 frames (~1s) of mic data are collected to establish the ambient noise floor. This floor is used as the baseline for barge-in detection throughout the session.

**Audio passthrough:** Unlike the previous "audio gate" approach (which blocked ALL mic audio during playback), the AEC-cleaned signal is always forwarded to OpenAI. This enables both barge-in paths to work simultaneously — the client detects speech locally for instant interruption, while OpenAI's server VAD provides backup detection.

**Typical RMS values (with hardware AEC + speakerphone):**
- Ambient: 0.0000–0.005
- Echo during AI playback: 0.0000 (fully cancelled by hardware AEC)
- Human speech at arm's length: 0.015–0.11
- Barge-in threshold (at 0.003 ambient): max(0.003 * 3, 0.02) = 0.02

### 5.6 Live AI Transcript (Timed Subtitles)

The app displays a subtitle overlay of what the AI is currently saying, synced to sentence timing.

**Data flow:**

```
OpenAI -> response.audio_transcript.delta { delta: "Bonjour" }
    |
    v
aiTranscript state (full accumulated text)
    |
    v
useEffect: scan for sentence boundaries ([.!?] + whitespace)
    |
    +-- Completed sentence found -> push to subtitle queue with timed duration
    +-- No boundary yet -> live-stream the in-progress text as a "tail"
    |
    v
displaySubtitle state (what the user sees)
```

**Timed queue system:** Each completed sentence gets a display duration of `min(4000, max(1200, charCount * 60))` ms. A `setTimeout` chain cycles through the queue so each sentence stays on screen proportional to its length. Between timed sentences, the in-progress (unfinished) text streams live.

**Clearing:**
- `response.created` — Clears transcript + queue + timer at the very start of a new response (before any audio or transcript deltas arrive, preventing the race condition where transcript deltas arrive before the first `response.audio.delta`)
- `input_audio_buffer.speech_started` — Clears immediately on barge-in
- `connect()` — Clears on new call to prevent stale text from a previous session

**UI:** Semi-transparent bubble below the orb, max 3 lines, white text on rgba(0,0,0,0.6) background. Positioned in normal layout flow (not absolute) to avoid overlapping the orb or controls.

### 5.7 RMS Calculation (Optimized)

```typescript
const calculateRMS = (base64Data: string): number => {
  const buffer = Buffer.from(base64Data, 'base64');
  const len = buffer.length;
  const samples = len >> 1;  // Bit shift: divide by 2 (16-bit = 2 bytes/sample)

  // DataView reads directly from the ArrayBuffer -- no intermediate allocation
  const view = new DataView(buffer.buffer, buffer.byteOffset, len);

  let sum = 0;
  for (let i = 0; i < len - 1; i += 2) {
    const sample = view.getInt16(i, true);  // true = little-endian
    sum += sample * sample;
  }

  // Normalize: sqrt(mean(squares)) / 16000
  // 16000 is ~half of Int16 max (32768), chosen for nice 0-1 output range
  return Math.min(Math.sqrt(sum / samples) / 16000, 1);
};
```

This runs at 25Hz (every 40ms audio chunk). The optimization over the naive approach (`buffer.readInt16LE(i)`) is that `DataView.getInt16()` operates directly on the underlying `ArrayBuffer` without creating new Buffer objects.

---

## 6. The Vision System

### 6.1 Capture Pipeline

```
Accelerometer (60Hz)
    |
    v
useCameraStabilityWithReset (sliding window variance)
    |
    | isStableSV.value = true (after 1.2s below threshold)
    v
useAnimatedReaction (UI thread, zero re-renders)
    |
    | runOnJS(captureAndSendFrame)()
    v
captureAndSendFrame()
    |
    +-- Guard checks (cooldown, concurrent capture, AI speaking, refs)
    +-- Set mode to 'processing'
    +-- takePictureAsync (0.7 quality for crop headroom)
    +-- Calculate crop region (center of screen, matching crosshair box)
    +-- Crop + resize to 384x384 JPEG, quality 0.5 (~25KB)
    +-- Set visionSendInProgressRef = true (pauses audio forwarding)
    +-- WebSocket.send({ type: 'vision.direct_injection', image: base64 })
    +-- Set visionSendInProgressRef = false
    +-- Update cooldown timer (8 seconds)
    +-- Reset stability tracking
```

### 6.2 Image Compression Rationale

| Setting | Value | Reason |
|---------|-------|--------|
| Capture quality | 0.7 | Need decent source for cropping |
| Final resolution | 384x384 | Halves the data vs 512x512 |
| JPEG quality | 0.5 | ~25KB payload (was ~60KB at 0.7) |
| Cooldown | 8 seconds | Prevents vision spam, saves API cost |

The 384x384 Q0.5 setting was chosen after analyzing head-of-line blocking on mobile networks. At 512x512 Q0.7 (~60KB), a single vision frame takes ~480ms to transmit on a 4G connection with 1Mbps upload. This blocks audio frames (which must arrive within 40ms to avoid stuttering). At 384x384 Q0.5 (~25KB), transmission takes ~200ms, and the audio pause mechanism covers this gap.

### 6.3 Vision Injection (Server-Side)

When the relay receives `vision.direct_injection`:

```typescript
// 1. Validate: non-empty, string type, < 5MB
// 2. Check backpressure (< 128KB buffered)
// 3. Construct multimodal conversation item:
const visionPayload = {
  type: 'conversation.item.create',
  item: {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'I am showing you something. Describe it briefly and ask me a question about it.' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${base64Image}` },
    ],
  },
};

// 4. Send to OpenAI
// 5. Immediately send response.create (force the AI to acknowledge NOW)
```

The `response.create` after vision injection is essential. Without it, the AI might wait for the user to speak before acknowledging the image, creating an awkward pause.

### 6.4 The Audio Pause Mechanism

During vision frame transmission, audio forwarding is briefly paused:

```typescript
// In captureAndSendFrame():
visionSendInProgressRef.current = true;
const visionTimeout = setTimeout(() => { visionSendInProgressRef.current = false; }, 200);
wsRef.current.send(JSON.stringify(payload));
visionSendInProgressRef.current = false;
clearTimeout(visionTimeout);

// In AudioRecord.on('data'):
if (visionSendInProgressRef.current) {
  volumeLevel.value = withTiming(rms * 0.3, { duration: 40 });
  return; // Don't send audio during vision upload
}
```

The 200ms timeout is a safety net. If `send()` returns synchronously (which it does in most implementations), the flag is cleared immediately. The timeout only fires if something unexpected blocks the send.

This pause is invisible to the user because OpenAI's VAD has a 500ms silence threshold. A 50-200ms audio gap doesn't trigger a false "user stopped speaking" event.

---

## 7. The Friend Loop (EdTech Engine)

### 7.1 Design Philosophy

The Friend Loop implements SLA research on correction behavior:

> **Core Principle:** A learner who keeps talking with errors learns faster than a learner who stops talking because they're afraid of errors.

This translates to three rules:
1. **Recast, don't lecture** -- Model the correct form naturally instead of explaining the error
2. **One bite at a time** -- Maximum 1 correction per AI turn, ignore the rest
3. **Let it breathe** -- 3-turn cooldown after any correction

### 7.2 The Tool: `log_gap_word`

The AI has access to one tool:

```json
{
  "name": "log_gap_word",
  "description": "Call this when the user says a meaningful English word instead of the target language equivalent...",
  "parameters": {
    "native_word": "string (the English word the user said)",
    "target_word": "string (the correct translation)",
    "severity": "enum: critical | topic | common | recurring"
  }
}
```

**What triggers it:** The user says an English word when they should have used the target language.

**What does NOT trigger it:** Discourse markers ("okay", "um", "so", "like"), loanwords, filler words, minor grammar errors, pronunciation differences. (perhaps i'll play with these in the next version')

### 7.3 The Tool Call Flow

```
User says: "Hier, je suis alle au... um... store"
    |
    v
OpenAI detects "store" as a gap word
    |
    v
OpenAI calls log_gap_word({ native_word: "store", target_word: "magasin", severity: "topic" })
    |
    v
Relay receives response.function_call_arguments.done
    |
    +-- 1. Store in session memory (deduplicated, bounded at 50)
    +-- 2. Send tool output back to OpenAI:
    |      "Word logged. Continue naturally. Do NOT force this word."
    +-- 3. Send response.create (AI continues speaking)
    +-- 4. Notify client: gap_word.logged event (for UI feedback)
    +-- 5. Schedule debounced context update (2s window)
    |
    v
AI responds: "Au magasin! Qu'est-ce que tu as achete?"
(Naturally recasts "magasin" without lecturing)
```

### 7.4 Context Injection (The Rebuild Pattern)

Instead of appending to instructions (which grows unbounded), the relay rebuilds instructions from scratch each time:

```typescript
const buildInstructionsWithContext = (): string => {
  if (gapWords.length === 0) return baseInstructions;

  // Only include the 3 most recent gap words
  const recentGapWords = gapWords.slice(-3);
  const gapWordSummary = recentGapWords
    .map(gw => `"${gw.target}" (user said "${gw.native}")`)
    .join(', ');

  const contextSection = `
== SESSION MEMORY ==
Words the user has struggled with recently: ${gapWordSummary}.
Do NOT quiz them. When natural, weave ONE word into your response organically.`;

  return baseInstructions + contextSection;
  // Hard cap at 8,000 chars
};
```

The context update is **debounced by 2 seconds**. If the AI fires multiple `log_gap_word` calls in quick succession (rare but possible), they coalesce into a single `session.update`. This prevents racing with `response.create`.

### 7.5 Client-Side Gap Word Persistence

The client also stores gap words locally via AsyncStorage:

```typescript
// On receiving response.function_call_arguments.done from the server:
if (toolName === 'log_gap_word' && currentAgentConfig) {
  addGapWord(currentAgentConfig.name, {
    native_word: toolArgs.native_word,
    target_word: toolArgs.target_word,
    timestamp: Date.now(),
  });
}
```

Storage is keyed by agent name, so each tutor persona has its own vocabulary gap history. Users can review their gap words in the `GapWordsScreen`.

### 7.6 The System Prompt

The full system prompt (generated in `applyAgentConfig`) is the longest piece of text in the system (~2,200 chars). Key sections:

| Section | Purpose |
|---------|---------|
| Language Rule | "Speak ONLY in {language}" |
| Personality | Curious, warm, short responses (1-2 sentences) |
| Correction Philosophy | Recast > lecture, 1 per turn, 3-turn cooldown |
| Correction Priority | Critical > Topic > Common > Recurring |
| IGNORE List | Discourse markers, loanwords, minor grammar, pronunciation |
| Tool Usage | When and how to call `log_gap_word` |
| Callback Behavior | How to reintroduce previously-forgotten words organically |
| Good/Bad Examples | Concrete examples of correct vs incorrect behavior |

---

## 8. The Animation System

**File:** `app/components/ActiveOrb.tsx` (337 lines)

### 8.1 The Viewfinder Crosshair

The ActiveOrb is a 280x280px square with 40px corner radius, styled to look like a camera viewfinder crosshair. It's the visual centerpiece of the app, overlaid on the live camera feed.

### 8.2 SharedValue Architecture

Every animation value is a Reanimated SharedValue, which means animations run on the **UI thread** (native code) with zero JavaScript thread involvement:

```
SharedValue writes (UI thread):
  - baseScale, opacity, rippleScale, rippleOpacity
  - volumeLevel (from audio callback via withTiming)
  - stabilityProgress, isStable (from accelerometer hook)

useAnimatedStyle worklets (UI thread):
  - boxStyle: scale, borderColor, opacity, borderWidth
  - rippleVisibilityStyle: scale, opacity, borderColor
  - fillStyle: backgroundColor, opacity (volume-reactive fill)
  - cornerAnimatedStyle: borderColor (stability indicator)
  - stabilityRingVisibilityStyle: opacity, borderColor, borderWidth, scale
```

### 8.3 Mode Transitions

When `mode` changes, the `useEffect` fires and configures animations:

| Mode | Scale Animation | Opacity | Ripple |
|------|----------------|---------|--------|
| `idle` | Breathing: 1.0 <-> 1.02 (3s cycle) | 0.4 | None |
| `listening` | Snap to 1.0 (spring, fast) | 1.0 | None |
| `processing` | Pulse: 0.96 <-> 1.0 (0.8s cycle) | 0.85 | None |
| `speaking` | Snap to 1.0 (spring, fast) | 1.0 | 1.0 -> 1.35, opacity 0.5 -> 0 (1s cycle) |

### 8.4 Volume Reactivity

During `listening` and `speaking`, the orb scales up with audio volume:

```typescript
// In boxStyle worklet:
const volumeBoost = (mode === 'listening' || mode === 'speaking')
  ? volumeLevel.value * 0.12  // Max +12% scale at full volume
  : 0;

return {
  transform: [{ scale: baseScale.value + volumeBoost }],
};
```

The volume animation uses `withTiming(duration: 40ms)` instead of `withSpring` to match the 40ms audio chunk cadence. Springs have variable settling time that causes micro-stutters when driven at high frequency.

### 8.5 Always-Mount Pattern

Conditional rendering (`{mode === 'speaking' && <Ripple />}`) causes layout thrashing in Reanimated. Instead, all layers are always mounted and visibility is controlled by animated opacity:

```tsx
{/* Always mounted, visibility controlled by animated style */}
<Animated.View style={[styles.stabilityRing, stabilityRingVisibilityStyle]} />
<Animated.View style={[styles.box, rippleVisibilityStyle]} />
<Animated.View style={[styles.box, boxStyle]}>
  <Animated.View style={[styles.fill, fillStyle]} />
  <Animated.View style={[styles.cornerTL, cornerAnimatedStyle]} />
  {/* ... */}
</Animated.View>
```

---

## 9. The Stability Detection System

**File:** `app/hooks/useCameraStability.ts` (357 lines)

### 9.1 Algorithm

```
Accelerometer data @ 60Hz (16ms intervals)
    |
    v
Sliding window (30 samples = ~500ms)
    |
    v
Calculate variance: sqrt(sum((sample - mean)^2) / (N * 3))
    across x, y, z axes
    |
    v
variance < 0.15 ?
    |
    +-- YES: increment stableStartTime
    |        progress = clamp(stableDuration / 1200ms, 0, 1)
    |        If progress >= 1.0 for first time -> fire onStabilized callback
    |
    +-- NO: reset stableStartTime, progress = 0
```

### 9.2 Why SharedValues?

The original implementation used `useState`:

```typescript
// BAD: 60 re-renders per second from accelerometer data
setState({ variance, stabilityProgress: progress, isStable });
```

The optimized version uses SharedValues:

```typescript
// GOOD: Zero re-renders, writes go directly to UI thread
stabilityProgress.value = progress;
isStableSV.value = isFullyStable;
varianceSV.value = variance;
```

This is consumed by the ActiveOrb via `useAnimatedStyle` worklets, which read the SharedValues on the UI thread without any bridge crossing.

### 9.3 The onStabilizedRef Pattern

The `onStabilized` callback changes on every render (because it's a new closure). If we included it in the accelerometer handler's `useCallback` dependencies, the handler would be recreated every render, causing the `useEffect` to re-subscribe to the accelerometer.

Instead, we use a ref:

```typescript
const onStabilizedRef = useRef(onStabilized);
useEffect(() => { onStabilizedRef.current = onStabilized; }, [onStabilized]);

// In accelerometer handler:
onStabilizedRef.current?.();  // Always calls the latest version
```

### 9.4 Stability -> Capture Bridge

The stability detection connects to vision capture via `useAnimatedReaction`:

```typescript
useAnimatedReaction(
  () => isStableSV.value,                           // Track this value
  (currentlyStable, previouslyStable) => {          // When it changes
    if (currentlyStable && !previouslyStable) {     // Rising edge only
      runOnJS(captureAndSendFrame)();               // Trigger capture on JS thread
    }
  }
);
```

This runs on the UI thread and only calls back to JS when stability transitions from false to true. No polling, no `useEffect` watching state.

---

## 10. State Management & Data Flow

### 10.1 State Categories

The app uses four categories of state, each with a specific purpose:

| Category | Mechanism | Thread | Re-renders? | Use Case |
|----------|-----------|--------|-------------|----------|
| UI State | `useState` | JS | Yes | `isConnected`, `interactionMode`, `isMuted` |
|| Animation State | `useSharedValue` | UI | No | `volumeLevel`, `stabilityProgress` |
| Callback State | `useRef` | JS | No | `isMutedRef`, `interactionModeRef`, `wsRef` |
| Persistent State | AsyncStorage | Disk | No (until loaded) | `callHistory`, `agents`, `gapWords` |

### 10.2 Data Flow Diagram

```
                    +-------------------+
                    | AsyncStorage      |
                    | (agents, history, |
                    |  gap words)       |
                    +-------------------+
                           |
                    loadOnMount / saveOnDisconnect
                           |
+------------------------------------------------------------------+
|                       App.tsx (MainScreen)                         |
|                                                                    |
|  useState:                  useRef:              useSharedValue:   |
|  - connectionStatus         - wsRef              - volumeLevel    |
|  - isConnected              - isMutedRef         - flashOpacity   |
|  - interactionMode          - interactionModeRef                  |
|  - isMuted                  - audioContextRef                     |
|  - currentAgentConfig       - pendingSourcesRef                   |
|  - callHistory              - lastCaptureTimeRef                  |
|                             - visionSendInProgressRef             |
+------------------------------------------------------------------+
     |              |              |                    |
     v              v              v                    v
 CallHistory   ControlSheet    ActiveOrb         useCameraStability
 Screen                       (SharedValues)     WithReset
                                                 (SharedValues)
```

### 10.3 Navigation Model

The app uses **animated layer switching** instead of a navigation library:

```
Layer 3 (z:20): CallHistoryScreen  -- slides DOWN when call starts
Layer 4 (z:25): GapWordsScreen     -- slides in from RIGHT
Layer 2 (z:10): Call UI            -- fades IN when connected
Layer 1 (z:0):  Viewfinder         -- always active
```

Transitions use `react-native-reanimated` with platform-optimized curves:
- **iOS**: `Easing.bezier(0.2, 0, 0, 1)` (Apple's native spring curve) + 450ms
- **Android**: `Easing.out(Easing.cubic)` + 300ms (faster, no ProMotion needed)

---

## 11. Performance Architecture

### 11.1 Thread Model

```
+-------------------+     +-------------------+     +-------------------+
|    JS THREAD      |     |    UI THREAD      |     |   NATIVE THREAD   |
|                   |     |  (Reanimated)     |     |                   |
| - Audio callback  |     | - All animations  |     | - AudioRecord     |
| - WebSocket I/O   |     | - SharedValue     |     | - AudioContext    |
| - State updates   |     |   reads/writes    |     | - Camera capture  |
| - Vision capture  |     | - Worklet code    |     | - Accelerometer   |
| - RMS calculation |     | - Style compute   |     |                   |
+-------------------+     +-------------------+     +-------------------+
        |                         ^                         |
        |   runOnUI(fn)()         |                         |
        +------------------------>|                         |
        |                         |                         |
        |   SharedValue.value =   |                         |
        +------------------------>|                         |
        |                         |                         |
        |   runOnJS(fn)()         |                         |
        |<------------------------+                         |
        |                                                   |
        |   Native module calls                             |
        +-------------------------------------------------->|
```

### 11.2 Critical Path Optimizations

| Optimization | Problem | Solution | Impact |
|-------------|---------|----------|--------|
| DataView for RMS | `Buffer.from()` every 40ms = GC pressure | `DataView.getInt16()` on existing ArrayBuffer | ~0 allocations/frame |
| SharedValue stability | `setState()` at 60Hz = 60 re-renders/sec | Write to SharedValues, read in worklets | 0 re-renders |
| withTiming for audio | `withSpring` has variable settle time | `withTiming(40ms)` matches chunk cadence | No micro-stutters |
| Always-mount layers | Conditional mount/unmount = layout thrash | Opacity-controlled visibility | Smooth transitions |
| Ref for callbacks | Stale closure reads old state | `isMutedRef.current` always current | Correct behavior |
| Vision audio pause | Large frame blocks WebSocket event loop | Suppress audio during send | No audio stutter |
| Image compression | 60KB frames on 4G = HoL blocking | 384x384 Q0.5 = ~25KB | 60% less data |
| Hardware AEC | Speaker echo (RMS 0.04-0.8) overwhelms speech (0.015-0.11) | `audioSource: 7` (VOICE_COMMUNICATION) routes mic through device AEC | Echo RMS → 0.0000 |
| Optimistic interrupt | Server barge-in has 200-500ms RTT delay | Client-side `stopAudioPlayback()` on cleaned RMS threshold | Instant interruption |

### 11.3 Memory Budget

| Resource | Size | Lifecycle |
|----------|------|-----------|
| Audio chunk (40ms) | ~2.5KB (1,920 bytes PCM + base64 overhead) | Ephemeral |
| Vision frame | ~25KB (384x384 JPEG Q0.5) | Ephemeral |
| Accelerometer window | 30 samples x ~24 bytes = ~720 bytes | Session |
| Gap words (server) | Max 50 x ~100 bytes = ~5KB | Session |
| Gap words (client) | Unbounded (AsyncStorage) | Persistent |
| AudioBuffer pool | Variable, cleaned on `onEnded` | Playback |
| Pending sources | Variable, cleared on stop | Playback |

---

## 12. Security Model

### 12.1 API Key Protection

```
NEVER on client:  OPENAI_API_KEY
Server only:      Loaded from .env, injected as Authorization header
.gitignore:       server/.env (confirmed removed from git tracking)
```

### 12.2 Input Validation (Server)

| Input | Validation | Rejection |
|-------|-----------|-----------|
| WebSocket frame | `maxPayload: 10MB` | Protocol-level reject |
| Image payload | Type check (string), size check (<5MB base64) | Warning + client error event |
| Tool arguments | Type check (`typeof === 'string'`) | Skip processing |
| Tool call_id | Existence check | Skip processing |
| Gap word dedup | `.some()` check | Silent skip |

### 12.3 Network Security

Current state: **ws:// (cleartext)**. This is acceptable for the prototype but must be upgraded to **wss:// (TLS)** before production. The relay runs on AWS EC2 with Security Group rules limiting inbound traffic to port 8082.

---

## 13. File Map & Module Responsibilities

### Server

| File | Lines | Responsibility |
|------|-------|---------------|
| `server/server.ts` | 739 | Complete relay server: WebSocket proxy, vision injection, Friend Loop, cleanup |

### Client - Core

| File | Lines | Responsibility |
|------|-------|---------------|
| `app/App.tsx` | 1,327 | Main screen: audio pipeline, WebSocket, state machine, vision capture |
| `app/theme.ts` | 135 | Design tokens: colors, typography (SF Pro/Inter), spacing, blur |

### Client - Components

| File | Lines | Responsibility |
|------|-------|---------------|
| `components/ActiveOrb.tsx` | 337 | Animated viewfinder crosshair with volume/stability reactivity |
| `components/Viewfinder.tsx` | 154 | Camera view wrapper with permission handling |
| `components/StatusPill.tsx` | 48 | Glassmorphic connection status indicator |
| `components/ControlSheet.tsx` | 123 | Bottom control panel (mute, camera, flip, end call) |
| `components/CallHistoryScreen.tsx` | 755 | Home screen with call history, agent creation |
| `components/GapWordsScreen.tsx` | 382 | Per-agent vocabulary gap review |
| `components/NewAgentSheet.tsx` | ~200* | Bottom sheet for creating new tutor agents |
| `components/CircleButton.tsx` | ~80* | Reusable circular icon button |
| `components/FeatureToggle.tsx` | ~60* | Toggle pill for camera/noise settings |

### Client - Hooks

| File | Lines | Responsibility |
|------|-------|---------------|
| `hooks/useCameraStability.ts` | 357 | Accelerometer-based stability detection (SharedValue output) |

### Client - Storage

| File | Lines | Responsibility |
|------|-------|---------------|
| `storage/index.ts` | 148 | AsyncStorage CRUD for agents, call history, gap words |

*\* Estimated - not read in this audit*

---

## Appendix A: Key Constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `SAMPLE_RATE` | 24,000 Hz | App.tsx | OpenAI Realtime requirement |
| `BARGE_IN_CONSECUTIVE_FRAMES` | 3 | App.tsx | ~120ms confirmation window |
| `CALIBRATION_SAMPLES` | 25 | App.tsx | ~1s ambient noise calibration |
| `VISION_COOLDOWN_MS` | 8,000 ms | App.tsx | Minimum time between captures |
| `CROSSHAIR_SIZE` | 280 px | App.tsx | Viewfinder box size |
| `ORB_SIZE` | 280 px | ActiveOrb.tsx | Must match CROSSHAIR_SIZE |
| `CORNER_RADIUS` | 40 px | ActiveOrb.tsx | Rounded square corners |
| `PING_INTERVAL_MS` | 30,000 ms | server.ts | Heartbeat frequency |
| `MAX_GAP_WORDS` | 50 | server.ts | Session memory cap |
| `MAX_INSTRUCTIONS_CHARS` | 8,000 | server.ts | Prompt size cap |
| `CONTEXT_UPDATE_DEBOUNCE_MS` | 2,000 ms | server.ts | Tool call coalescing |
| `UPDATE_INTERVAL_MS` | 16 ms | useCameraStability.ts | Accelerometer sample rate |
| `WINDOW_SIZE` | 30 samples | useCameraStability.ts | ~500ms sliding window |
| `STABILITY_THRESHOLD` | 0.15 G | useCameraStability.ts | Variance cutoff |
| `STABLE_DURATION_MS` | 1,200 ms | useCameraStability.ts | Required stable time |

## Appendix B: Event Sequence Diagrams

### B.1 Normal Conversation Turn

```
Time  Client              Relay                OpenAI
 |
 |    [User speaks]
 |    audio.append -------> forward ----------->
 |    audio.append -------> forward ----------->
 |    ...                   ...
 |                                               speech_stopped
 |                          <------------------- speech_stopped
 |    <-- speech_stopped --
 |    [Mode: processing]
 |                                               [Thinking...]
 |                                               audio.delta
 |                          <------------------- audio.delta
 |    <-- audio.delta -----
 |    [Mode: speaking]
 |    [Schedule audio]
 |                                               audio.delta
 |                          <------------------- audio.delta
 |    <-- audio.delta -----
 |    [Schedule audio]
 |    ...
 |                                               response.done
 |                          <------------------- response.done
 |    <-- response.done ---
 |    [Playback ends]
 |    [Mode: idle]
```

### B.2 Barge-In (Optimistic Interrupt)

```
Time  Client                           Relay                OpenAI
 |
 |    [AI speaking, mic audio AEC-cleaned]
 |    audio.append ------------>  forward -------> (cleaned audio always flows)
 |
 |    [User starts talking]
 |    [Audio frame: cleaned RMS above threshold]
 |    [consecutiveAbove = 1]
 |    audio.append ------------>  forward ------->
 |
 |    [Audio frame: cleaned RMS above threshold]
 |    [consecutiveAbove = 2]
 |    audio.append ------------>  forward ------->
 |
 |    [Audio frame: cleaned RMS above threshold]
 |    [consecutiveAbove = 3 >= REQUIRED]
 |    *** OPTIMISTIC INTERRUPT ***
 |    truncate ----------------->  forward ------->
 |    stopAudioPlayback()                        (server hasn't detected yet)
 |    [Mode: listening]
 |    audio.append ------------>  forward ------->
 |                                                 speech_started (200-500ms later)
 |                                <-------------- speech_started
 |    <-- speech_started --------
 |    (already listening, no-op)
 |                                                 response.cancelled
 |    audio.append ------------>  forward ------->
 |    [New turn begins...]
```

> **Key insight:** Hardware AEC (`audioSource: 7`) reduces echo RMS to 0.0000, so cleaned mic audio always flows to OpenAI during playback. The client detects speech at frame 3 (~120ms) and stops playback locally. The server's `speech_started` arrives 200-500ms later as backup. The user perceives instant interruption.

### B.3 Vision Capture

```
Time  Client              Relay                OpenAI
 |
 |    [Device stable for 1.2s]
 |    [Mode: processing]
 |    [Capture photo]
 |    [Crop + compress]
 |    [Audio pause ON]
 |    vision.inject ------>
 |    [Audio pause OFF]     conv.item.create -->
 |                          response.create ---->
 |                                               [Processes image]
 |                                               audio.delta
 |                          <------------------- audio.delta
 |    <-- audio.delta -----
 |    [Mode: speaking]
 |    "I see a coffee cup! Do you like coffee?"
```

### B.4 Friend Loop (Gap Word Detection)

```
Time  Client              Relay                OpenAI
 |
 |    User: "Au... store"
 |    audio.append -------> forward ----------->
 |                                               [Detects "store"]
 |                                               tool: log_gap_word
 |                          <------------------- fn_call.done
 |    <-- fn_call.done ----
 |    [Save to AsyncStorage]
 |                          addGapWord("store", "magasin")
 |                          tool_output -------->
 |                          response.create ---->
 |    <-- gap_word.logged -
 |                                               audio.delta
 |    <-- audio.delta -----
 |    AI: "Au magasin! Qu'est-ce que tu as achete?"
 |
 |    [2 seconds later]
 |                          session.update ----> [Updated context]
```
