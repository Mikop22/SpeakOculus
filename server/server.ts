import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';

// ── Environment Setup ────────────────────────────────────────────────────────
// Hunt for the .env file in a few likely spots. If we're running from dist/,
// __dirname points there, so we check the project root first.
const envPaths = [
    path.resolve(__dirname, '../.env'),            // up one level (project root when in dist/)
    path.resolve(__dirname, '.env'),               // right next to the script
    path.resolve(process.cwd(), '.env'),          // wherever you ran the command from
];

for (const envPath of envPaths) {
    const result = dotenv.config({ path: envPath });
    if (!result.error) {
        console.log(`[RELAY] Loaded .env from: ${envPath}`);
        break;
    }
}

const PORT = 8082;
const HOST = '0.0.0.0'; // listen on all interfaces so AWS EC2 (and LAN devices) can reach us
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

// ── Stability & Safety Constants ─────────────────────────────────────────────

// Ping every 30s so AWS load balancers and home routers don't kill idle sockets
const PING_INTERVAL_MS = 30_000;
// Cap how many gap words we remember per session — oldest ones get evicted
const MAX_GAP_WORDS = 50;
// OpenAI gives us ~16K tokens for instructions + tools. At ~4 chars/token that's
// ~65K chars, but we stay well under that so tool defs and safety margin fit too.
const MAX_INSTRUCTIONS_CHARS = 8_000;
// If the AI fires several tool calls in quick succession, we batch them into one
// session.update instead of spamming OpenAI with rapid-fire updates.
const CONTEXT_UPDATE_DEBOUNCE_MS = 2_000;
// Largest base64 image we'll accept (~5MB decoded). Anything bigger gets rejected.
const MAX_IMAGE_BASE64_CHARS = 5 * 1024 * 1024 * (4 / 3); // ~6.67M chars
// Hard ceiling on any single WebSocket message from the client
const MAX_CLIENT_MESSAGE_BYTES = 10 * 1024 * 1024;

if (!OPENAI_API_KEY) {
    console.error('[FATAL] OPENAI_API_KEY is missing or empty in .env');
    console.error('[FATAL] Check: .env must contain exactly one line: OPENAI_API_KEY=sk-proj-... (no spaces, no quotes)');
    process.exit(1);
}

// Spin up the WS server — maxPayload keeps giant frames from blowing us up
const wss = new WebSocketServer({
    port: PORT,
    host: HOST,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
});

console.log(`[RELAY] Server running on ${HOST}:${PORT}`);
console.log('[RELAY] Waiting for client connections...');

// ── Session Config (OpenAI Realtime API) ─────────────────────────────────────
// Fallback personality — the client usually overrides this with agent.config
const DEFAULT_INSTRUCTIONS = `
You are a friendly, helpful AI assistant.
- Style: Conversational, concise, and warm.
- Voice: Alloy.
- Language: English.
- Response: Keep responses short (1-2 sentences) unless asked for detail.
`;

const SESSION_CONFIG = {
    modalities: ['audio', 'text'],
    instructions: DEFAULT_INSTRUCTIONS,
    voice: 'alloy',
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16', // raw PCM16 at 24kHz — what OpenAI expects
    input_audio_transcription: {
        model: 'whisper-1',
    },
    turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500, // short pause = snappy turn-taking
    },
    // ── Tools (the Friend Loop) ───────────────────────────────────────────
    tools: [
        {
            type: 'function',
            name: 'log_gap_word',
            description: 'MANDATORY: You MUST call this tool whenever the user says a meaningful word in ANY language other than the current target language. This includes English, French, Spanish, Portuguese, Mandarin, Arabic, or ANY non-target language. Only log words that represent genuine vocabulary gaps — NOT universal discourse markers (okay, yes, no, um, hmm), NOT loanwords commonly used in the target language, and NOT filler words. If the user says multiple non-target-language words in one utterance, log only the MOST important one. Do NOT log the same word twice in one session. A recast without a tool call is a BUG — always call this tool alongside your correction.',
            parameters: {
                type: 'object',
                properties: {
                    native_word: {
                        type: 'string',
                        description: 'The non-target-language word or short phrase the user said (any language, not just English)',
                    },
                    target_word: {
                        type: 'string',
                        description: 'The correct translation in the target language',
                    },
                    severity: {
                        type: 'string',
                        enum: ['critical', 'topic', 'common', 'recurring'],
                        description: 'How important this correction is: critical=incomprehensible, topic=related to current discussion, common=high-frequency word, recurring=user has said this before',
                    },
                },
                required: ['native_word', 'target_word', 'severity'],
            },
        },
    ],
    tool_choice: 'auto',
};

// ── Critical Events ──────────────────────────────────────────────────────────
// These are the events the frontend actually cares about for keeping the UI in sync.
const CRITICAL_EVENTS = [
    'session.created',                          // we're in — client can show "connected"
    'session.updated',                          // config change acknowledged
    'input_audio_buffer.speech_started',        // user started talking — kill AI playback (barge-in)
    'input_audio_buffer.speech_stopped',        // user went quiet
    'response.created',                         // AI is about to speak
    'response.done',                            // AI finished its turn
    'response.cancelled',                       // barge-in cut the AI off
    'conversation.item.truncated',              // OpenAI confirmed the truncation
    'response.function_call_arguments.done',    // tool call came back — time to handle it
    'error',                                    // something broke
];

// ── Connection Handler ───────────────────────────────────────────────────────
// Every client gets its own dedicated OpenAI session — strictly 1:1.
wss.on('connection', (clientWs: WebSocket) => {
    const clientId = Date.now().toString(36); // quick & dirty unique id for logs
    console.log(`[RELAY] Client ${clientId} connected`);

    // guard against cleaning up twice if both sides close at the same time
    let isCleanedUp = false;
    let pingInterval: NodeJS.Timeout | null = null;

    // we flip these to false before each ping; if the pong never comes back, the socket is dead
    let clientIsAlive = true;
    let openAiIsAlive = true;

    // ── Session Memory (Friend Loop) ───────────────────────────────────────
    // Words the user blanked on during this conversation (capped, oldest get tossed)
    let gapWords: Array<{ native: string; target: string }> = [];
    // The persona prompt — agent.config replaces this wholesale, never appended to
    let baseInstructions = DEFAULT_INSTRUCTIONS;
    // If the client sends agent.config before the OpenAI socket is ready, stash it here
    let pendingAgentConfig: { name: string; language: string } | null = null;

    // Batches rapid tool calls so we don't hammer OpenAI with back-to-back session.updates
    let contextUpdateTimer: NodeJS.Timeout | null = null;

    // ── addGapWord ────────────────────────────────────────────────────────
    // Stash a word the user forgot. Skips dupes, evicts the oldest if we're full.
    const addGapWord = (native: string, target: string): void => {
        // already got this one — no need to log it again
        const exists = gapWords.some(
            (gw) => gw.native === native && gw.target === target
        );
        if (exists) {
            console.log(`[MEMORY] Duplicate gap word skipped for ${clientId}: "${native}" -> "${target}"`);
            return;
        }

        // full up — drop the oldest word to make room
        if (gapWords.length >= MAX_GAP_WORDS) {
            const evicted = gapWords.shift();
            console.log(`[MEMORY] Evicted oldest gap word for ${clientId}: "${evicted?.native}" -> "${evicted?.target}"`);
        }

        gapWords.push({ native, target });
        console.log(`[MEMORY] Logged gap word for ${clientId}: "${native}" -> "${target}" (${gapWords.length}/${MAX_GAP_WORDS})`);
    };

    // ── buildInstructionsWithContext ────────────────────────────────────────
    // Rebuilds the full prompt from scratch each time: base persona + the last
    // few gap words. This way we never grow instructions without bound.
    const buildInstructionsWithContext = (): string => {
        if (gapWords.length === 0) {
            return baseInstructions;
        }

        // only show the AI the 3 most recent struggles — keeps things focused
        const recentGapWords = gapWords.slice(-3);
        const gapWordSummary = recentGapWords
            .map((gw) => `"${gw.target}" (user said "${gw.native}")`)
            .join(', ');

        const contextSection = `\n\n== SESSION MEMORY ==
Words the user has struggled with recently: ${gapWordSummary}.
Do NOT quiz them on these words. When a natural opportunity arises (topic change, related question), you may weave ONE of these words into your response — but only if it fits organically. Never force it.`;

        const fullInstructions = baseInstructions + contextSection;

        // safety net — if somehow the prompt got too long, just chop it
        if (fullInstructions.length > MAX_INSTRUCTIONS_CHARS) {
            console.warn(`[RELAY] Instructions truncated for ${clientId}: ${fullInstructions.length} > ${MAX_INSTRUCTIONS_CHARS} chars`);
            return fullInstructions.substring(0, MAX_INSTRUCTIONS_CHARS);
        }

        return fullInstructions;
    };

    // ── scheduleContextUpdate ─────────────────────────────────────────────
    // Waits a beat before pushing new context to OpenAI, so a burst of tool
    // calls collapses into one update instead of flooding the API.
    const scheduleContextUpdate = (): void => {
        // reset the timer if we already had one queued
        if (contextUpdateTimer) {
            clearTimeout(contextUpdateTimer);
        }

        contextUpdateTimer = setTimeout(() => {
            contextUpdateTimer = null;

            // bail if the session died while we were waiting
            if (isCleanedUp || openAiWs.readyState !== WebSocket.OPEN) {
                return;
            }

            const instructions = buildInstructionsWithContext();
            const sessionUpdate = {
                type: 'session.update',
                session: { instructions },
            };
            openAiWs.send(JSON.stringify(sessionUpdate));
            console.log(`[RELAY] Debounced context update sent for ${clientId} (${gapWords.length} gap words, ${instructions.length} chars)`);
        }, CONTEXT_UPDATE_DEBOUNCE_MS);
    };

    // ── cleanup — the "billing saver" ──────────────────────────────────────
    // When either side drops, tear everything down so we don't leave a ghost
    // session silently burning API credits.
    const cleanup = (reason: string) => {
        if (isCleanedUp) return; // already handled — nothing to do
        isCleanedUp = true;

        console.log(`[RELAY] Cleanup triggered for ${clientId}: ${reason}`);

        // kill any pending context push — that session is gone
        if (contextUpdateTimer) {
            clearTimeout(contextUpdateTimer);
            contextUpdateTimer = null;
        }

        // stop pinging — nobody's listening
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        // shut down the OpenAI side if it's still hanging around
        if (openAiWs.readyState === WebSocket.OPEN || openAiWs.readyState === WebSocket.CONNECTING) {
            console.log(`[RELAY] Closing OpenAI socket for ${clientId}`);
            openAiWs.close();
        }

        // same for the client side
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
            console.log(`[RELAY] Closing Client socket for ${clientId}`);
            clientWs.close();
        }

        // rip out all listeners so the GC can actually reclaim this session's memory
        openAiWs.removeAllListeners();
        clientWs.removeAllListeners();

        // zero out session state now instead of hoping the closure gets collected eventually
        gapWords = [];
        baseInstructions = '';
        pendingAgentConfig = null;

        console.log(`[RELAY] Session ${clientId} fully cleaned up (listeners removed, state cleared)`);
    };

    // ── applyAgentConfig ──────────────────────────────────────────────────
    // Builds the full "friend mode" persona prompt and pushes it to OpenAI.
    const applyAgentConfig = (name: string, language: string) => {
        // this replaces baseInstructions entirely — context injection rebuilds
        // from here + gap words every time, so nothing grows unbounded
        baseInstructions = `You are ${name}, a native ${language} speaker having a relaxed, friendly conversation. You are NOT a teacher. You are a friend who happens to speak ${language} natively.

== LANGUAGE RULE ==
Speak ONLY in ${language}. Your entire output must be in ${language}, except when performing a recast correction (see below).

== YOUR PERSONALITY ==
- You are curious, warm, and genuinely interested in what the user has to say.
- You react to the CONTENT of their message first. Their ideas matter more than their grammar.
- You keep responses short (1-2 sentences). This is a real-time voice conversation, not a lecture.
- You ask follow-up questions to keep the conversation flowing.
- You celebrate when the user expresses something well, but casually — like a friend would ("Nice!", "Exactement!"), not like a teacher grading them.
- If the user shows you an object (via image), describe it and ask questions about it — all in ${language}.
- Start your first message with a warm, casual greeting in ${language}.

== CORRECTION PHILOSOPHY ==
You follow the "patient friend" approach to corrections:
1. FLOW OVER ACCURACY: A user who keeps talking with errors is learning faster than a user who stops talking because they are afraid of errors. Protect their confidence above all.
2. RECAST, DO NOT LECTURE: When correcting, naturally weave the correct ${language} word into YOUR response. Do NOT say "the word for X is Y" or "you made a mistake." Just USE the correct word naturally and move on.
3. ONE BITE AT A TIME: If the user makes multiple errors in one sentence, correct AT MOST ONE — the most important one. Silently let the rest go.
4. LET IT BREATHE: After delivering a correction (even a gentle recast), do NOT correct again for your next 3 responses. During this cooldown, focus entirely on conversation flow and encouragement.

== CORRECTION PRIORITY (when choosing which error to address) ==
If the user says multiple non-${language} words (in ANY language — English, their native tongue, or any other), pick the ONE that matters most:
1. CRITICAL: The error makes the sentence incomprehensible (always correct these).
2. TOPIC WORD: The word is directly related to what you are currently discussing.
3. COMMON WORD: The word is extremely high-frequency and the user will need it constantly.
4. RECURRING: The user has made this same error before in this conversation.

IGNORE (never correct, even if you notice them):
- Discourse markers: "okay", "so", "um", "like", "yes", "no", "well", "right"
- Loanwords commonly used in ${language}
- Minor grammar errors that do not affect comprehension
- Pronunciation differences (you are in a voice conversation — accent is not an error)

== MANDATORY TOOL PROTOCOL: log_gap_word ==
This is a NON-NEGOTIABLE rule. Follow this exact sequence for EVERY user turn:

STEP 1 — DETECT: Scan the user's message for ANY word that is NOT in ${language}.
  This means ANY language: English, French, Spanish, Portuguese, Mandarin, Arabic, their native tongue — ANYTHING that is not ${language}.

STEP 2 — CLASSIFY: Is the non-${language} word a genuine vocabulary gap?
  YES (log it) = The word carries meaning and has a ${language} equivalent (Priority 1-4 above).
  NO (skip it) = The word is a universal filler (um, hmm), a loanword commonly used in ${language}, or a discourse marker.

STEP 3 — CALL TOOL: If YES in Step 2, you MUST call log_gap_word BEFORE speaking.
  This is MANDATORY. You CANNOT skip the tool call and "just recast."
  Recasting without logging means the word is LOST from session memory.
  If multiple non-${language} words exist, pick the single most important one (Priority 1-4).

STEP 4 — RESPOND: After the tool call completes, deliver your natural recast and continue the conversation. MOVE ON.

CRITICAL: A recast WITHOUT a tool call is a BUG. If you correct a word, you MUST ALSO log it. The tool call and the recast are a PAIR — never do one without the other.

== CALLBACK BEHAVIOR (reinforcing previous words) ==
When the conversation context mentions words the user previously forgot:
- Do NOT quiz them ("Do you remember the word for X?").
- Do NOT bring it up immediately. Wait for a natural topic transition.
- Weave the word into something YOU would say anyway, organically.
- If the user produces the word correctly on their own, acknowledge it briefly and move on. That word is now learned.

== WHAT A GREAT RESPONSE LOOKS LIKE ==
User: "Hier, je suis alle au... um... store pour acheter du... food"
Step 1: Detect "store" (English) and "food" (English) — both are non-${language}.
Step 2: "store" = meaningful gap (Priority 2: topic word). "food" = also meaningful but pick ONE.
Step 3: CALL log_gap_word("store", "magasin", "topic"). MANDATORY — do this BEFORE responding.
Step 4: Respond naturally: "Au magasin! Qu'est-ce que tu as achete? Moi j'adore faire les courses le weekend."
(Tool called. Recast "magasin" naturally. Ignored "food" — that can wait. Engaging follow-up. No lecture.)

== WHAT A BAD RESPONSE LOOKS LIKE ==
User: "Hier, je suis alle au... um... store pour acheter du... food"
You: "Au magasin! Qu'est-ce que tu as achete?" (recast without calling log_gap_word — the word is LOST from memory. THIS IS A BUG.)
Also bad: "On dit 'magasin' pour 'store', et 'nourriture' pour 'food'. Aussi, c'est 'alle' pas 'alle' — tu dois utiliser..."
(Corrects everything at once. Feels like a test. User will stop talking.)`;

        // push the new persona to OpenAI
        const instructions = buildInstructionsWithContext();
        const sessionUpdate = {
            type: 'session.update',
            session: { instructions },
        };
        openAiWs.send(JSON.stringify(sessionUpdate));
        console.log(`[RELAY] Agent configured for ${clientId}: "${name}" teaching "${language}" (${instructions.length} chars)`);
    };

    // ── Upstream: connect to OpenAI Realtime API ──────────────────────────
    // using the mini model — cheaper and still has vision support
    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-mini-2025-12-15', {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1',
        },
    });

    // handshake done — set up the session config and start heartbeats
    openAiWs.on('open', () => {
        console.log(`[RELAY] OpenAI handshake complete for ${clientId}`);

        // tell OpenAI how we want the session to behave
        const sessionUpdate = {
            type: 'session.update',
            session: SESSION_CONFIG,
        };
        openAiWs.send(JSON.stringify(sessionUpdate));
        console.log(`[RELAY] Session configured for ${clientId}`);

        // if the client sent an agent config while we were still connecting, apply it now
        if (pendingAgentConfig) {
            console.log(`[RELAY] Applying pending agent config for ${clientId}`);
            applyAgentConfig(pendingAgentConfig.name, pendingAgentConfig.language);
            pendingAgentConfig = null;
        }

        // heartbeat loop — ping both ends every 30s. If we didn't get a pong
        // back since the last ping, assume the connection is dead and kill it.
        pingInterval = setInterval(() => {
            // is the client still there?
            if (!clientIsAlive) {
                console.warn(`[ZOMBIE] Client ${clientId} failed pong check - terminating`);
                clientWs.terminate(); // hard kill — the 'close' handler will run cleanup
                return;
            }
            clientIsAlive = false;
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.ping();
            }

            // is OpenAI still there?
            if (!openAiIsAlive) {
                console.warn(`[ZOMBIE] OpenAI socket for ${clientId} failed pong check - terminating`);
                openAiWs.terminate();
                return;
            }
            openAiIsAlive = false;
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.ping();
                // heads-up if the outgoing buffer is getting backed up
                if (openAiWs.bufferedAmount > 32 * 1024) {
                    console.warn(
                        `[RELAY] Buffer warning for ${clientId}: ` +
                        `OpenAI=${openAiWs.bufferedAmount}B, Client=${clientWs.bufferedAmount}B`
                    );
                }
            }
        }, PING_INTERVAL_MS);
    });

    // got a pong back — they're alive
    clientWs.on('pong', () => {
        clientIsAlive = true;
    });
    openAiWs.on('pong', () => {
        openAiIsAlive = true;
    });

    // incoming from OpenAI — figure out what it is and relay to the client
    openAiWs.on('message', (data: any) => {
        try {
            const response = JSON.parse(data.toString());
            const eventType = response.type;

            // ===== CRITICAL EVENT: SPEECH STARTED (VAD Link) =====
            // This is the most important event for UI synchronization.
            // When OpenAI detects the user speaking, we IMMEDIATELY notify
            // the client so it can stop AI audio playback (barge-in).
            if (eventType === 'input_audio_buffer.speech_started') {
                console.log(`[RELAY] Speech started - interrupting client ${clientId}`);
            }

            // =================================================================
            // TOOL CALL HANDLER (Phase 3.0 - The Friend Loop)
            // When OpenAI calls a function, we handle it here.
            // =================================================================
            if (eventType === 'response.function_call_arguments.done') {
                const { call_id, name, arguments: argsJson } = response;

                // [FIX: Input Validation] Validate call_id exists before using it
                if (!call_id) {
                    console.error(`[RELAY] Tool call missing call_id for ${clientId}, skipping`);
                } else if (name === 'log_gap_word') {
                    try {
                        const args = JSON.parse(argsJson);
                        const { native_word, target_word } = args;

                        // [FIX: Input Validation] Validate tool arguments are strings
                        if (typeof native_word !== 'string' || typeof target_word !== 'string') {
                            console.error(`[RELAY] Invalid tool args for ${clientId}: native_word or target_word not a string`);
                            return;
                        }

                        // 1. Store in session memory (bounded, deduplicated)
                        addGapWord(native_word, target_word);

                        // 2. Send function output back to OpenAI (completes the tool call loop)
                        const toolOutput = {
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: call_id,
                                output: JSON.stringify({
                                    status: 'logged',
                                    native_word,
                                    target_word,
                                    message: 'Word logged. Continue the conversation naturally. Do NOT force this word into your next response. It will come up organically later.',
                                }),
                            },
                        };
                        openAiWs.send(JSON.stringify(toolOutput));
                        console.log(`[RELAY] Sent tool output for ${clientId}`);

                        // 3. Trigger response so AI continues speaking
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        console.log(`[RELAY] Triggered response.create for ${clientId}`);

                        // 4. Notify client for UI feedback (gap word indicator)
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(JSON.stringify({
                                type: 'gap_word.logged',
                                native_word,
                                target_word,
                                severity: args.severity || 'common',
                                total_gaps: gapWords.length,
                            }));
                        }

                        // 5. [FIX: Race Condition] Schedule debounced context injection.
                        // Instead of sending session.update immediately (which races with
                        // the response.create above), we debounce it. Multiple rapid tool
                        // calls coalesce into a single session.update after a quiet period.
                        scheduleContextUpdate();

                    } catch (e) {
                        console.error(`[RELAY] Failed to parse tool arguments for ${clientId}:`, e);
                    }
                }
            }

            // Log critical events, suppress audio delta spam
            if (CRITICAL_EVENTS.includes(eventType)) {
                console.log(`[OPENAI -> CLIENT] ${eventType}`);
            } else if (eventType !== 'response.audio.delta') {
                // Log non-audio events for debugging
                console.log(`[OPENAI] ${eventType}`);
            }

            // Forward to Client (passthrough - no transformation)
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data.toString());
            }
        } catch (e) {
            console.error(`[RELAY] Error parsing OpenAI message for ${clientId}:`, e);
        }
    });

    // OpenAI Socket Closed - Trigger cleanup
    openAiWs.on('close', (code, reason) => {
        console.log(`[RELAY] OpenAI disconnected for ${clientId} (code: ${code}, reason: ${reason || 'none'})`);
        cleanup('OpenAI socket closed');
    });

    // OpenAI Socket Error - Log and cleanup
    openAiWs.on('error', (err: Error) => {
        console.error(`[RELAY] OpenAI error for ${clientId}:`, err.message);
        cleanup('OpenAI socket error');
    });

    // -------------------------------------------------------------------------
    // DOWNSTREAM CONNECTION - Client <-> Relay
    // -------------------------------------------------------------------------

    // Client Message Received - Forward to OpenAI
    clientWs.on('message', (data: any) => {
        try {
            const message = JSON.parse(data.toString());
            const messageType = message.type;

            // Log non-audio messages for debugging
            if (messageType !== 'input_audio_buffer.append') {
                console.log(`[CLIENT -> OPENAI] ${messageType}`);
            }

            // =================================================================
            // VISION DIRECT INJECTION HANDLER (Phase 2.1)
            // Injects images directly into the active OpenAI Realtime session
            // as a user message with multimodal content (text + image).
            //
            // Documentation confirms format uses:
            //   - type: 'input_image'
            //   - image_url: 'data:image/jpeg;base64,...' (data URI format)
            // =================================================================
            if (messageType === 'vision.direct_injection') {
                const base64Image = message.image;

                if (!base64Image) {
                    console.warn(`[Vision] Received vision event without image payload`);
                    return;
                }

                // [FIX: Input Validation] Reject oversized image payloads
                if (typeof base64Image !== 'string') {
                    console.warn(`[Vision] Image payload is not a string for ${clientId}`);
                    return;
                }
                if (base64Image.length > MAX_IMAGE_BASE64_CHARS) {
                    console.warn(`[Vision] Image too large for ${clientId}: ${base64Image.length} chars (max: ${Math.floor(MAX_IMAGE_BASE64_CHARS)})`);
                    // Notify client of rejection
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            type: 'error',
                            error: { message: 'Image payload exceeds maximum size limit (5MB)' },
                        }));
                    }
                    return;
                }

                console.log(`[Vision] Received image payload. Size: ${base64Image.length} chars`);

                // Construct the conversation.item.create payload with multimodal content
                const visionPayload = {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [
                            {
                                type: 'input_text',
                                text: 'I am showing you something. Describe it briefly and ask me a question about it.',
                            },
                            {
                                type: 'input_image',
                                image_url: `data:image/jpeg;base64,${base64Image}`,
                            },
                        ],
                    },
                };

                // Safety: Wrap send in try/catch to handle flaky connections
                try {
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        // [FIX: Backpressure] Check buffer before sending large vision payload
                        const VISION_BUFFER_LIMIT = 128 * 1024; // 128KB threshold
                        if (openAiWs.bufferedAmount > VISION_BUFFER_LIMIT) {
                            console.warn(
                                `[Vision] Dropping vision frame for ${clientId} - ` +
                                `OpenAI socket congested (bufferedAmount: ${openAiWs.bufferedAmount} bytes)`
                            );
                            return;
                        }

                        // Send the image injection
                        openAiWs.send(JSON.stringify(visionPayload));
                        console.log(`[Vision] Injected image for ${clientId} (bufferedAmount: ${openAiWs.bufferedAmount} bytes)`);

                        // Immediately trigger a response so AI acknowledges the image now
                        const responseCreate = { type: 'response.create' };
                        openAiWs.send(JSON.stringify(responseCreate));
                        console.log(`[Vision] Triggered response.create for ${clientId}`);
                    } else {
                        console.warn(`[Vision] Cannot inject - OpenAI socket not open (state: ${openAiWs.readyState})`);
                    }
                } catch (sendError) {
                    console.error(`[Vision] Failed to send vision payload for ${clientId}:`, sendError);
                }

                return; // Don't forward vision.direct_injection to OpenAI as-is
            }

            // =================================================================
            // DYNAMIC PERSONA HANDLER (Phase 3.0 - The Friend Loop)
            // Client sends agent config (name, language) to set up Friend Mode.
            // =================================================================
            if (messageType === 'agent.config') {
                const { name, language } = message.config || {};

                if (name && language) {
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        // OpenAI is ready - apply immediately
                        applyAgentConfig(name, language);
                    } else {
                        // OpenAI not ready yet - queue for later
                        console.log(`[RELAY] Queuing agent config for ${clientId} (OpenAI not ready)`);
                        pendingAgentConfig = { name, language };
                    }
                } else {
                    console.warn(`[RELAY] Received agent.config without name or language for ${clientId}`);
                }

                return; // Don't forward agent.config to OpenAI as-is
            }

            // Forward to OpenAI (passthrough - no transformation)
            if (openAiWs.readyState === WebSocket.OPEN) {
                // [FIX: Backpressure] Drop audio frames if OpenAI socket buffer is congested
                const MAX_AUDIO_BUFFER_BYTES = 64 * 1024; // 64KB threshold
                if (messageType === 'input_audio_buffer.append' && openAiWs.bufferedAmount > MAX_AUDIO_BUFFER_BYTES) {
                    if (!isCleanedUp) {
                        console.warn(
                            `[RELAY] Backpressure: dropping audio frame for ${clientId} ` +
                            `(bufferedAmount: ${openAiWs.bufferedAmount} bytes)`
                        );
                    }
                    return;
                }
                openAiWs.send(JSON.stringify(message));
            } else {
                console.warn(`[RELAY] Cannot forward to OpenAI - socket not open (state: ${openAiWs.readyState})`);
            }
        } catch (e) {
            console.error(`[RELAY] Error parsing client message for ${clientId}:`, e);
        }
    });

    // Client Socket Closed - Trigger cleanup
    clientWs.on('close', (code, reason) => {
        console.log(`[RELAY] Client ${clientId} disconnected (code: ${code}, reason: ${reason || 'none'})`);
        cleanup('Client socket closed');
    });

    // Client Socket Error - Log and cleanup
    clientWs.on('error', (err: Error) => {
        console.error(`[RELAY] Client error for ${clientId}:`, err.message);
        cleanup('Client socket error');
    });
});

// =============================================================================
// GRACEFUL SHUTDOWN - Clean exit for PM2 and manual termination
// =============================================================================
const shutdown = (signal: string) => {
    console.log(`[RELAY] ${signal} received - shutting down gracefully...`);

    // Close the server (stop accepting new connections)
    wss.close(() => {
        console.log('[RELAY] Server closed');
        process.exit(0);
    });

    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('[RELAY] Forced shutdown after timeout');
        process.exit(1);
    }, 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
