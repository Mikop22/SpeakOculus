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
**Relay Server** — A lightweight Node.js WebSocket proxy on AWS. This exists because deploying right beside OpenAI's servers saves ~200ms of round-trip latency.

**OpenAI Realtime API** — `gpt-realtime-mini`. Handles all the voice activity detection (VAD), Whisper transcription, response generation, audio synthesis, tool calling, and vision. The relay is intentionally thin so OpenAI does the work.


