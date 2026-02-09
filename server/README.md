# Speak Vision Relay — Backend Summary

Summary for engineers: what this backend is, how it’s deployed, and how to run it.

---

## Overview

The backend is a **Node.js WebSocket relay** between the React Native app and the **OpenAI Realtime API**. It runs on **AWS EC2** in **us-east-1** for low latency to OpenAI. The app connects to this relay (not directly to OpenAI).

---

## Architecture

```
[React Native App]  ←→  [EC2 Relay :8082]  ←→  [OpenAI Realtime API]
     (PCM16)                  (proxy)              (wss://api.openai.com/...)
```

- **App → Relay:** WebSocket; JSON messages (e.g. `input_audio_buffer.append`, `response.cancel`); PCM16 audio as base64.
- **Relay → OpenAI:** One WebSocket per client; relay forwards client messages and streams OpenAI responses back.
- **One relay connection = one OpenAI Realtime session** (1:1).

---

## Deployment (EC2)

| Item | Value |
|------|--------|
| **Region** | us-east-1 (N. Virginia) |
| **Endpoint** | `ws://YOUR_EC2_IP:8082` (use Elastic IP if you want a stable URL) |
| **Port** | 8082 (TCP) |
| **Security group** | Inbound: SSH 22 (restrict to your IP), Custom TCP 8082 from 0.0.0.0/0 (or restrict as needed) |

**Server path on EC2:** `~/speak-relay/`  
**Process manager:** PM2 (see below). No reverse proxy in front yet (plain `ws://`).

---

## Repo Layout

- **Relay server:** `SpeakOculusExpo/server/`
  - Entry: `server.ts` → built to `dist/server.js`
  - Config: `SESSION_CONFIG` in `server.ts` (voice, VAD, instructions, etc.)
  - Env: `.env` with `OPENAI_API_KEY` only (no other config for basic run)
  - PM2: `ecosystem.config.js` for `pm2 start ecosystem.config.js`

---

## .env and Build

When you run `node dist/server.js`, `__dirname` is `dist/`, so the code looks for `.env` in `dist/`. Either:

- **Option A:** After `npm run build`, copy `.env` into `dist/`:
  ```bash
  cp .env dist/.env
  ```
- **Option B:** Change the code to load `.env` from the project root (e.g. `path.resolve(__dirname, '..', '.env')`).

**tsconfig:** The server `tsconfig.json` must **not** extend `expo/tsconfig.base` when building on the server (remove that line), or the build can fail (e.g. `moduleResolution: "bundler"` vs `module: "commonjs"`).

---

## PM2 (Process Manager)

PM2 keeps the relay running, restarts it on crash, and starts it on EC2 reboot.

### One-time setup on EC2

```bash
sudo npm install -g pm2
cd ~/speak-relay
pm2 start ecosystem.config.js --name speak-relay
pm2 save
pm2 startup
# Run the command that pm2 startup prints (e.g. sudo env PATH=... pm2 startup systemd -u ec2-user --hp /home/ec2-user)
```

### Useful commands

| Command | Purpose |
|--------|--------|
| `pm2 status` | See if relay is running, restarts, memory |
| `pm2 logs speak-relay` | Stream logs (stdout/stderr) |
| `pm2 restart speak-relay` | Restart after a deploy |
| `pm2 stop speak-relay` | Stop the relay |
| `pm2 start speak-relay` | Start again |

---

## Deploy Workflow (from your Mac)

1. **Sync code to EC2 (no node_modules):**
   ```bash
   cd /path/to/SpeakOculusExpo
   rsync -avz -e "ssh -i /path/to/your-key.pem" \
     --exclude node_modules server/ ec2-user@YOUR_EC2_PUBLIC_IP:~/speak-relay/
   ```

2. **On EC2:**
   ```bash
   cd ~/speak-relay
   npm install
   npm run build
   cp .env dist/.env
   pm2 restart speak-relay
   ```

Use your instance’s **public IPv4** in the rsync command. Ensure `.env` exists in `~/speak-relay/` with `OPENAI_API_KEY=sk-proj-...`.

---

## Session / API Details

- **OpenAI endpoint:** `wss://api.openai.com/v1/realtime?model=gpt-realtime-mini-2025-12-15`
- **Auth:** `OPENAI_API_KEY` from `.env`, sent as `Authorization: Bearer <key>`.
- **Audio:** PCM16, 24 kHz (matches app). No transcoding in the relay.
- **Turn detection:** OpenAI `server_vad`; app also has client-side “dirty” VAD for fast barge-in; relay just forwards messages (e.g. `response.cancel`).

The relay is stateless per connection; it does not persist state or store keys beyond `.env`.

---

## App-Side Configuration

- **Relay URL:** In the app, set `EXPO_PUBLIC_RELAY_URL` in `app/.env` (or the fallback in `App.tsx`) to your EC2 WebSocket URL, e.g. `ws://YOUR_EC2_IP:8082`.
- For production, consider an env or build-time variable so the URL can change without code edits (e.g. dev vs prod, or when you add a domain/Elastic IP).

---

## Optional Next Steps

1. **Elastic IP** — Attach to the EC2 instance so the URL doesn’t change on restart.
2. **Domain + TLS** — Put the relay behind an ALB (or similar) with HTTPS/WSS and a certificate so the app can use `wss://` (some networks block plain `ws://`).
3. **Fix .env path in code** — Load `.env` from the project root so you don’t need to copy it into `dist/` after each build.
