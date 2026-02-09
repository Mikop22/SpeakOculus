import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  StatusBar,
  Platform,
  PermissionsAndroid,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import AudioRecord from 'react-native-audio-record';
import InCallManager from 'react-native-incall-manager';
import { Buffer } from 'buffer';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  interpolate,
  Extrapolation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  SharedValue,
} from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AudioContext, AudioBufferSourceNode } from 'react-native-audio-api';
import * as Haptics from 'expo-haptics';
import * as ImageManipulator from 'expo-image-manipulator';

// UI pieces
import { ActiveOrb, OrbMode } from './components/ActiveOrb';
import { StatusPill } from './components/StatusPill';
import { ControlSheet } from './components/ControlSheet';
import { Viewfinder, CameraFacing, ViewfinderRef } from './components/Viewfinder';
import { CallHistoryScreen, AgentConfig, CallHistoryItem, generateSystemPrompt } from './components/CallHistoryScreen';
import { GapWordsScreen } from './components/GapWordsScreen';
import { VocabularyPopup } from './components/VocabularyPopup';
import { THEME } from './theme';

// Persistence layer
import { loadAgents, addAgent, loadCallHistory, saveCallHistory, addGapWord, GapWord } from './storage';

// Quick and dirty UUID — good enough for our use case
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

import { useCameraStabilityWithReset } from './hooks/useCameraStability';

// ============================================================================
// CONFIG — tweak these when switching between local dev and production
// ============================================================================
// Flip this to true when you want to hit the relay on your own machine
const USE_LOCAL_RELAY = false;
const RELAY_PRODUCTION_URL = process.env.EXPO_PUBLIC_RELAY_URL ?? 'ws://localhost:8082';
const RELAY_PORT = 8082;
// If you've got a physical Android plugged in via USB, `adb reverse` lets
// us hit localhost as if it were the host machine. Pretty handy.
const USE_ADB_REVERSE = true; // assumes: adb reverse tcp:8082 tcp:8082
// iOS Sim / physical device without adb reverse → put your machine's LAN IP here.
// Android Emulator falls back to 10.0.2.2 when this is 'localhost'.
const LOCAL_RELAY_IP = 'localhost';

const RELAY_SERVER_URL = (() => {
  if (!USE_LOCAL_RELAY) return RELAY_PRODUCTION_URL;
  if (Platform.OS === 'android') {
    // Physical device + adb reverse: localhost on the phone tunnels to the host
    if (USE_ADB_REVERSE) return `ws://127.0.0.1:${RELAY_PORT}`;
    // Emulator quirk: 10.0.2.2 is how it reaches the host's loopback
    const host = LOCAL_RELAY_IP === 'localhost' ? '10.0.2.2' : LOCAL_RELAY_IP;
    return `ws://${host}:${RELAY_PORT}`;
  }
  return `ws://${LOCAL_RELAY_IP}:${RELAY_PORT}`;
})();

const SAMPLE_RATE = 24000; // OpenAI wants exactly 24kHz — no negotiating this one

// ============================================================================
// BARGE-IN — how we detect the user talking over the AI
// ============================================================================
// Since hardware AEC strips out the speaker echo, whatever RMS we see on the
// mic is actually the user's voice. We just need a few frames in a row above
// the noise floor to be confident it's real speech, not a bump or a cough.
const BARGE_IN_CONSECUTIVE_FRAMES = 3;   // 3 frames in a row (~120ms) = "yep, they're talking"
const CALIBRATION_SAMPLES = 25;           // ~1s of silence to figure out the room's noise floor

// Vision — don't spam OpenAI with images
const VISION_COOLDOWN_MS = 8000; // wait at least 8s between captures
const CROSSHAIR_SIZE = 280; // matches the orb size in ActiveOrb

// ============================================================================
// DEBUG — flip to false before shipping
// ============================================================================
const DEBUG_MODE = true;


const debugLog = (tag: string, message: string, data?: any) => {
  if (!DEBUG_MODE) return;
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[${timestamp}] 🔍 ${tag}: ${message}`, data);
  } else {
    console.log(`[${timestamp}] 🔍 ${tag}: ${message}`);
  }
};

// Mic config — audioSource 7 is Android's VOICE_COMMUNICATION mode,
// which flips on the hardware echo canceller. That's the secret sauce
// for barge-in without hearing the AI echo back into the mic.
const AUDIO_RECORD_OPTIONS = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 7,
  wavFile: 'speak_vision.wav',
  bufferSize: 1920, // 40ms worth of samples at 24kHz
};

// ============================================================================
// THE MAIN EVENT
// ============================================================================
const MainScreen = () => {
  const insets = useSafeAreaInsets();

  // -------------------------------------------------------------------------
  // All the state that makes this thing tick
  // -------------------------------------------------------------------------
  const [connectionStatus, setConnectionStatus] = useState<string>('Offline');
  const [isConnected, setIsConnected] = useState(false);
  const [agentName, setAgentName] = useState('Assistant');
  const [interactionMode, setInteractionMode] = useState<OrbMode>('idle');
  const interactionModeRef = useRef<OrbMode>('idle');
  const [permissionGranted, setPermissionGranted] = useState(false);

  // Who we're talking to and what happened before
  const [currentAgentConfig, setCurrentAgentConfig] = useState<AgentConfig | null>(null);
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>([]);

  // Gap words detail screen — which agent's words are we looking at?
  const [selectedAgentForGapWords, setSelectedAgentForGapWords] = useState<AgentConfig | null>(null);

  // Words the user missed during this call (shown in a floating popup)
  const [sessionGapWords, setSessionGapWords] = useState<GapWord[]>([]);
  const [showVocabPopup, setShowVocabPopup] = useState(false);

  // Basic UI toggles
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(true);
const [cameraFacing, setCameraFacing] = useState<CameraFacing>('back');
  const [isNoiseIsolationOn, setIsNoiseIsolationOn] = useState(true);

  // Camera capture state
  const [visionEnabled, setVisionEnabled] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);

  // Live subtitles — what the AI is currently saying
  const [aiTranscript, setAiTranscript] = useState('');
  const [displaySubtitle, setDisplaySubtitle] = useState('');

  // Refs so our WebSocket/audio callbacks always see fresh values
  // (React state inside closures goes stale — classic gotcha)
  const isMutedRef = useRef(false);
  const currentAgentConfigRef = useRef<AgentConfig | null>(null);

  // When did this session start? Used for call duration in history
  const sessionStartTimeRef = useRef<number | null>(null);

  // -------------------------------------------------------------------------
  // Refs — things we need to poke at imperatively
  // -------------------------------------------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  const audioRecordInitializedRef = useRef(false);
  const viewfinderRef = useRef<ViewfinderRef>(null);

  // Latency bookkeeping — helps us measure how snappy the round-trip feels
  const lastSpeechStoppedTimeRef = useRef<number | null>(null);
  const lastFirstAudioReceivedTimeRef = useRef<number | null>(null);

  // Vision capture guards — prevents overlapping captures and rate-limits them
  const lastCaptureTimeRef = useRef<number>(0);
  const captureInProgressRef = useRef(false);
  const visionSendInProgressRef = useRef(false);

  // -------------------------------------------------------------------------
  // Audio playback — Web Audio API handles gapless scheduling of PCM chunks
  // -------------------------------------------------------------------------
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const pendingSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const isPlayingRef = useRef(false);

  // -------------------------------------------------------------------------
  // Barge-in — lets the user interrupt the AI mid-sentence
  // -------------------------------------------------------------------------
  // We need to know which response item is playing so we can tell OpenAI
  // "hey, the user only heard up to X milliseconds of that"
  const lastResponseItemIdRef = useRef<string | null>(null);
  const responseStartTimeRef = useRef<number>(0); // when playback kicked off (AudioContext time)

  // How many audio frames in a row have been above the noise floor
  const consecutiveAboveRef = useRef<number>(0);
  const bargeInRmsHistoryRef = useRef<number[]>([]);

  // We measure the room's ambient noise before the AI starts talking.
  // That gives us a baseline so we don't confuse AC hum with speech.
  const ambientFloorRef = useRef<number>(0);
  const calibrationSamplesRef = useRef<number[]>([]);
  const isAmbientCalibratedRef = useRef<boolean>(false);

  // Subtitle queue — we break the AI transcript into sentences and show
  // them one at a time with timed transitions, like real subtitles
  const aiTranscriptRef = useRef('');
  const subtitleQueueRef = useRef<{text: string, duration: number}[]>([]);
  const subtitleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevBreakIdxRef = useRef(0);
  const isTimedDisplayRef = useRef(false);

  // -------------------------------------------------------------------------
  // Shared values — these live on the UI thread, no re-renders needed
  // -------------------------------------------------------------------------
  const volumeLevel = useSharedValue(0);

  // Keep refs in sync with state so callbacks always have fresh values
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Same deal for interaction mode
  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);

  // ...and the transcript, so our timed subtitle callbacks see the latest text
  useEffect(() => {
    aiTranscriptRef.current = aiTranscript;
  }, [aiTranscript]);

  // -------------------------------------------------------------------------
  // Stability detection — auto-captures when the phone is held steady
  // -------------------------------------------------------------------------
  const {
    isStableSV,
    stabilityProgress,
    varianceSV,
    resetStability,
  } = useCameraStabilityWithReset({
    enabled: visionEnabled && isConnected && isCameraOn && !isCapturing,
  });

  // -------------------------------------------------------------------------
  // RMS volume — how loud is the mic input right now?
  // -------------------------------------------------------------------------
  const calculateRMS = useCallback((base64Data: string): number => {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const len = buffer.length;
      if (len < 2) return 0;
      const samples = len >> 1;
      const view = new DataView(buffer.buffer, buffer.byteOffset, len);
      let sum = 0;
      for (let i = 0; i < len - 1; i += 2) {
        const sample = view.getInt16(i, true);
        sum += sample * sample;
      }
      return Math.min(Math.sqrt(sum / samples) / 16000, 1);
    } catch {
      return 0;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Vision capture — snap a photo and ship it to OpenAI via the relay
  // -------------------------------------------------------------------------
  const captureAndSendFrame = useCallback(async () => {
    // Don't stack captures on top of each other
    if (captureInProgressRef.current) {
      debugLog('VISION', 'Capture already in progress, skipping');
      return;
    }

    // Respect the cooldown between captures
    const now = Date.now();
    const timeSinceLastCapture = now - lastCaptureTimeRef.current;
    if (timeSinceLastCapture < VISION_COOLDOWN_MS) {
      debugLog('VISION', `Cooldown active (${Math.round((VISION_COOLDOWN_MS - timeSinceLastCapture) / 1000)}s remaining)`);
      return;
    }

    // Don't capture while the AI is mid-sentence — feels rude
    if (isPlayingRef.current) {
      debugLog('VISION', 'AI is speaking, skipping capture');
      return;
    }

    // Make sure the camera is actually available
    if (!viewfinderRef.current) {
      debugLog('VISION', 'Camera ref not available');
      return;
    }

    // No point capturing if we can't send it anywhere
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      debugLog('VISION', 'WebSocket not connected');
      return;
    }

    try {
      captureInProgressRef.current = true;
      setIsCapturing(true);

      // Let the user know we're working on it
      setInteractionMode('processing');

      // Snap the photo — no shutter sound so it doesn't interrupt the convo
      debugLog('VISION', 'Capturing frame...');
      const photo = await viewfinderRef.current.takePictureAsync({
        quality: 0.7, // a bit higher since we'll be cropping it down
        base64: true,
        skipProcessing: true,
        shutterSound: false,
      });

      if (!photo?.base64 || !photo.uri) {
        console.error('[VISION] Failed to capture photo - no base64 data');
        setInteractionMode('listening');
        return;
      }

      debugLog('VISION', `Photo captured: ${photo.width}x${photo.height}`);

      // Crop down to just what's inside the viewfinder box
      const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

      // Figure out where the crosshair sits on screen (it's always dead center)
      const crosshairScreenX = (screenWidth - CROSSHAIR_SIZE) / 2;
      const crosshairScreenY = (screenHeight - CROSSHAIR_SIZE) / 2;

      // The photo and the screen have different aspect ratios, so we need
      // to translate screen pixels into photo pixels carefully
      const photoAspect = photo.width / photo.height;
      const screenAspect = screenWidth / screenHeight;

      let scaleX: number, scaleY: number, offsetX = 0, offsetY = 0;

      if (photoAspect > screenAspect) {
        // Photo is wider — letterboxed on the sides
        scaleY = photo.height / screenHeight;
        scaleX = scaleY;
        offsetX = (photo.width - screenWidth * scaleX) / 2;
      } else {
        // Photo is taller — letterboxed on top/bottom
        scaleX = photo.width / screenWidth;
        scaleY = scaleX;
        offsetY = (photo.height - screenHeight * scaleY) / 2;
      }

      // Now we know where to cut
      const cropX = Math.max(0, Math.round(offsetX + crosshairScreenX * scaleX));
      const cropY = Math.max(0, Math.round(offsetY + crosshairScreenY * scaleY));
      const cropSize = Math.round(CROSSHAIR_SIZE * scaleX);

      // Clamp so we don't go out of bounds
      const finalCropX = Math.min(cropX, photo.width - cropSize);
      const finalCropY = Math.min(cropY, photo.height - cropSize);
      const finalCropSize = Math.min(cropSize, photo.width - finalCropX, photo.height - finalCropY);

      debugLog('VISION', `Cropping to: x=${finalCropX}, y=${finalCropY}, size=${finalCropSize}`);

      // Crop to the crosshair region and shrink to 384x384 for OpenAI
      const croppedImage = await ImageManipulator.manipulateAsync(
        photo.uri,
        [
          {
            crop: {
              originX: finalCropX,
              originY: finalCropY,
              width: finalCropSize,
              height: finalCropSize,
            },
          },
          {
            resize: { width: 384, height: 384 },
          },
        ],
        { base64: true, compress: 0.5, format: ImageManipulator.SaveFormat.JPEG }
      );

      if (!croppedImage.base64) {
        console.error('[VISION] Failed to crop photo');
        setInteractionMode('listening');
        return;
      }

      debugLog('VISION', `Cropped image: 384x384, base64 length: ${croppedImage.base64.length}`);

      // Fire it off to the relay server
      const payload = {
        type: 'vision.direct_injection',
        image: croppedImage.base64,
        timestamp: now,
      };

      visionSendInProgressRef.current = true;
      const visionTimeout = setTimeout(() => { visionSendInProgressRef.current = false; }, 200);
      wsRef.current.send(JSON.stringify(payload));
      visionSendInProgressRef.current = false;
      clearTimeout(visionTimeout);
      debugLog('VISION', 'Frame sent to server');

      // Start the cooldown timer
      lastCaptureTimeRef.current = now;

      // Reset so we don't immediately fire again
      resetStability();

    } catch (error) {
      console.error('[VISION] Capture error:', error);
      setInteractionMode('listening');
    } finally {
      captureInProgressRef.current = false;
      setIsCapturing(false);
    }
  }, [resetStability]);

  // -------------------------------------------------------------------------
  // When the phone goes from shaky to steady, snap a pic automatically.
  // This runs entirely on the UI thread — no React re-renders involved.
  // -------------------------------------------------------------------------
  useAnimatedReaction(
    () => isStableSV.value,
    (currentlyStable, previouslyStable) => {
      if (currentlyStable && !previouslyStable) {
        runOnJS(captureAndSendFrame)();
      }
    }
  );

  // -------------------------------------------------------------------------
  // Audio streaming — decode base64 PCM chunks and schedule them gaplessly
  // -------------------------------------------------------------------------
  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      console.log('[AUDIO] Initializing AudioContext');
      audioContextRef.current = new AudioContext({
        sampleRate: SAMPLE_RATE,
      });
      nextStartTimeRef.current = 0; // Reset time pointer
    } else if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  }, []);

  const scheduleAudioChunk = useCallback(async (base64Delta: string) => {
    if (!audioContextRef.current) initAudioContext();
    const ctx = audioContextRef.current!;

    // Wake it up if it went to sleep
    if (ctx.state === 'suspended') {
      console.log('[AUDIO] Context suspended. Resuming...');
      await ctx.resume();
    }

    try {
      // Decode the base64 into raw PCM16 bytes
      const rawBuffer = Buffer.from(base64Delta, 'base64');
      const int16Array = new Int16Array(
        rawBuffer.buffer,
        rawBuffer.byteOffset,
        rawBuffer.length / 2
      );

      // Web Audio wants float32 in the -1..1 range
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      // Wrap it in an AudioBuffer
      const audioBuffer = ctx.createBuffer(1, float32Array.length, SAMPLE_RATE);
      audioBuffer.copyToChannel(float32Array, 0);

      // Hook it up to the speakers
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      // Schedule it right after the last chunk ends. If we fell behind
      // (buffer underrun), just start playing immediately.
      const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
      source.start(startTime);

      // Mark as playing for barge-in detection
      if (!isPlayingRef.current) {
        isPlayingRef.current = true;
        console.log(`[AUDIO] Playback starting - ctx.state: ${ctx.state}, sampleRate: ${ctx.sampleRate}, currentTime: ${ctx.currentTime.toFixed(2)}s, samples: ${float32Array.length}, startTime: ${startTime.toFixed(2)}s, duration: ${audioBuffer.duration.toFixed(3)}s`);
      }

      // Log First Audio Playback Latency (optional tracking)
      if (lastFirstAudioReceivedTimeRef.current) {
        const now = Date.now();
        const processingLag = now - lastFirstAudioReceivedTimeRef.current;
        console.log(`[CLIENT] [LATENCY] Stream Started (Processing Lag: ${processingLag}ms)`);

        if (lastSpeechStoppedTimeRef.current) {
          console.log(`[CLIENT] [LATENCY] TOTAL E2E LATENCY: ${now - lastSpeechStoppedTimeRef.current}ms`);
        }
        lastFirstAudioReceivedTimeRef.current = null;
      }

      // 6. Advance Time Pointer
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      // Keep track to stop if needed
      pendingSourcesRef.current.push(source);

      // Cleanup when done (optional, but good for memory)
      const onEndedHandler = () => {
        if ((source as any)._hasEnded) return;
        (source as any)._hasEnded = true;

        const index = pendingSourcesRef.current.indexOf(source);
        if (index > -1) pendingSourcesRef.current.splice(index, 1);

        // If queue empty, we are idle
        if (pendingSourcesRef.current.length === 0) {
          debugLog('MODE', 'Mode: -> idle (playback complete)');
          setInteractionMode('idle');
          isPlayingRef.current = false;
        }
      };

      source.onEnded = onEndedHandler;
      (source as any).onEnded = onEndedHandler;

    } catch (e) {
      console.error('[AUDIO] Chunk scheduling error:', e);
    }
  }, [initAudioContext]);

  const stopAudioPlayback = useCallback(() => {
    console.log('[AUDIO] Stopping playback...');

    // Stop all active sources
    pendingSourcesRef.current.forEach(source => {
      try { source.stop(); } catch { }
    });
    pendingSourcesRef.current = [];

    // Reset Context Time
    nextStartTimeRef.current = 0;
    isPlayingRef.current = false;

    // Reset barge-in tracking
    consecutiveAboveRef.current = 0;
    bargeInRmsHistoryRef.current = [];
  }, []);

  // -------------------------------------------------------------------------
  // PERMISSION REQUEST
  // -------------------------------------------------------------------------
  const requestMicrophonePermission = useCallback(async (): Promise<boolean> => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message: 'Speak Vision needs microphone access.',
            buttonPositive: 'OK',
            buttonNegative: 'Cancel',
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        // iOS: Permission is requested automatically by react-native-audio-record
        // when recording starts. Return true to proceed.
        console.log('[CLIENT] iOS: Mic permission handled by native module');
        return true;
      }
    } catch (error) {
      console.error('[CLIENT] Permission error:', error);
      return false;
    }
  }, []);

  // -------------------------------------------------------------------------
  // AUDIO RECORD INITIALIZATION
  // -------------------------------------------------------------------------
  const initAudioRecord = useCallback((): boolean => {
    if (audioRecordInitializedRef.current) return true;

    if (!AudioRecord || typeof (AudioRecord as any).init !== 'function') {
      console.error('[CLIENT] AudioRecord native module not available');
      return false;
    }

    console.log('[CLIENT] Initializing AudioRecord');
    AudioRecord.init(AUDIO_RECORD_OPTIONS);

    AudioRecord.on('data', (base64Data: string) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        if (Math.random() < 0.02) console.log(`[MIC] Audio received but WS not open (readyState: ${wsRef.current?.readyState ?? 'null'})`);
        return;
      }
      if (!base64Data || base64Data.length < 50) {
        console.log(`[MIC] Audio chunk too small or empty: ${base64Data?.length ?? 0}`);
        return;
      }

      // Calculate RMS for visualization
      const rms = calculateRMS(base64Data);

      // Early return if muted (use ref to avoid stale closure)
      if (isMutedRef.current) {
        // Still update visualization when muted (shows user they're speaking but muted)
        volumeLevel.value = withTiming(rms * 0.3, {
          duration: 40,
          easing: Easing.out(Easing.quad),
        });
        return;
      }

      // Vision pause: throttle audio during vision frame upload to prevent stutter
      if (visionSendInProgressRef.current) {
        volumeLevel.value = withTiming(rms * 0.3, {
          duration: 40,
          easing: Easing.out(Easing.quad),
        });
        return;
      }

      // =========================================================================
      // AMBIENT CALIBRATION
      // Collect RMS samples before AI speaks to establish background noise floor.
      // The AI always speaks first, so we have a natural calibration window
      // between mic start and first response.audio.delta.
      // =========================================================================
      if (!isAmbientCalibratedRef.current) {
        if (!isPlayingRef.current) {
          // Still quiet - collect ambient sample
          calibrationSamplesRef.current.push(rms);
          if (calibrationSamplesRef.current.length >= CALIBRATION_SAMPLES) {
            const sum = calibrationSamplesRef.current.reduce((a, b) => a + b, 0);
            ambientFloorRef.current = sum / calibrationSamplesRef.current.length;
            isAmbientCalibratedRef.current = true;
            console.log(`[CALIBRATION] Ambient floor: ${ambientFloorRef.current.toFixed(4)} RMS (${CALIBRATION_SAMPLES} samples)`);
            calibrationSamplesRef.current = [];
          }
          volumeLevel.value = withTiming(rms * 0.3, { duration: 40, easing: Easing.out(Easing.quad) });
          return;
        }
        // AI started speaking before calibration finished - force-complete
        const samples = calibrationSamplesRef.current;
        if (samples.length >= 3) {
          const sum = samples.reduce((a, b) => a + b, 0);
          ambientFloorRef.current = sum / samples.length;
        } else {
          ambientFloorRef.current = 0.01; // Conservative default
        }
        isAmbientCalibratedRef.current = true;
        console.log(`[CALIBRATION] Ambient floor (force): ${ambientFloorRef.current.toFixed(4)} RMS (${samples.length} samples)`);
        calibrationSamplesRef.current = [];
        // Fall through to playback gate
      }

      // =========================================================================
      // BARGE-IN DURING PLAYBACK (Hardware AEC active via VOICE_COMMUNICATION)
      //
      // With audioSource 7, the OS cancels speaker echo before we see it.
      // Echo RMS is ~0.0000 during playback, so cleaned RMS reflects real speech.
      // We send all audio to OpenAI and let both barge-in paths work:
      //   1. Client-side (optimistic): RMS spike → stop playback immediately
      //   2. Server-side (OpenAI VAD): cleaned audio → server detects speech
      // =========================================================================
      if (isPlayingRef.current) {
        // Barge-in detection on the AEC-cleaned signal
        const threshold = Math.max(ambientFloorRef.current * 3, 0.02);
        if (rms > threshold) {
          consecutiveAboveRef.current++;
          bargeInRmsHistoryRef.current.push(rms);
          if (consecutiveAboveRef.current >= BARGE_IN_CONSECUTIVE_FRAMES) {
            console.log(`[BARGE-IN] Local barge-in triggered! RMS history: [${bargeInRmsHistoryRef.current.map(r => r.toFixed(4)).join(', ')}], threshold: ${threshold.toFixed(4)}`);
            consecutiveAboveRef.current = 0;
            bargeInRmsHistoryRef.current = [];

            // Calculate how much audio played before interrupt (for truncation)
            let audioEndMs = 0;
            if (audioContextRef.current && responseStartTimeRef.current > 0) {
              const elapsedSeconds = audioContextRef.current.currentTime - responseStartTimeRef.current;
              audioEndMs = Math.max(0, Math.floor(elapsedSeconds * 1000));
            }

            // Send truncation event
            if (lastResponseItemIdRef.current && audioEndMs > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: 'conversation.item.truncate',
                item_id: lastResponseItemIdRef.current,
                content_index: 0,
                audio_end_ms: audioEndMs,
              }));
              console.log(`[BARGE-IN] Sent truncate: item_id=${lastResponseItemIdRef.current}, audio_end_ms=${audioEndMs}`);
            }

            stopAudioPlayback();
            setInteractionMode('listening');
            lastResponseItemIdRef.current = null;
            responseStartTimeRef.current = 0;
          }
        } else {
          consecutiveAboveRef.current = 0;
          bargeInRmsHistoryRef.current = [];
        }

        // Always update visualization and send cleaned audio to OpenAI
        volumeLevel.value = withTiming(rms, { duration: 40, easing: Easing.out(Easing.quad) });
        wsRef.current.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64Data,
        }));
        return;
      }

      // Update volume visualization with timing matched to 40ms audio chunk cadence
      volumeLevel.value = withTiming(rms, {
        duration: 40,
        easing: Easing.out(Easing.quad),
      });

      // Send audio to relay server
      wsRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Data,
      }));
    });

    audioRecordInitializedRef.current = true;
    return true;
  }, [calculateRMS, volumeLevel]);

  // -------------------------------------------------------------------------
  // RECORDING CONTROLS
  // -------------------------------------------------------------------------
  const startRecording = useCallback(async () => {
    if (!permissionGranted) return;
    const ready = initAudioRecord();
    if (!ready) return;

    // Ensure playback is stopped before listening
    stopAudioPlayback();

    AudioRecord.start();
    console.log('[MIC] AudioRecord.start() called - microphone active');
    debugLog('MODE', 'Mode: -> listening (recording started)');
    setInteractionMode('listening');
  }, [permissionGranted, initAudioRecord, stopAudioPlayback]);

  const stopRecording = useCallback(() => {
    try { AudioRecord.stop(); } catch { }
    volumeLevel.value = 0;
    console.log('[CLIENT] Recording stopped');
  }, [volumeLevel]);

  // -------------------------------------------------------------------------
  // WEBSOCKET MESSAGE HANDLER
  // -------------------------------------------------------------------------
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      const eventType = data.type || 'unknown';

      // Log ALL events for debugging (throttle audio.delta)
      if (eventType === 'response.audio.delta') {
        if (Math.random() < 0.05) {
          console.log(`[RESPONSE] audio.delta received, delta length: ${data.delta?.length ?? 0}`);
        }
      } else {
        console.log(`[RESPONSE] <- ${eventType}`, eventType === 'error' ? JSON.stringify(data.error || data) : '');
      }

      switch (eventType) {
        case 'session.created':
          console.log('[CLIENT] Session created');
          initAudioContext();
          setConnectionStatus('AI Connected');
          setIsConnected(true);
          // Start recording audio immediately upon connection
          startRecording();
          break;

        case 'session.updated':
          console.log('[CLIENT] Session ready');
          break;

        case 'response.created':
          // Clear transcript at the very start of a new response,
          // before any audio or transcript deltas arrive.
          setAiTranscript('');
          setDisplaySubtitle('');
          subtitleQueueRef.current = [];
          prevBreakIdxRef.current = 0;
          isTimedDisplayRef.current = false;
          if (subtitleTimerRef.current) { clearTimeout(subtitleTimerRef.current); subtitleTimerRef.current = null; }
          break;

        case 'response.function_call_arguments.done':
          // Tool call from the LLM (e.g. log_gap_word in Friend Mode)
          const toolName = data.name ?? 'unknown';
          let toolArgs: Record<string, string> = {};
          try {
            if (typeof data.arguments === 'string') toolArgs = JSON.parse(data.arguments);
          } catch { /* ignore */ }
          console.log('[CLIENT] TOOL CALL:', toolName, toolArgs);

          // Handle log_gap_word tool - save the gap word to storage
          // Read from ref to avoid stale closure in useCallback
          const agentConfig = currentAgentConfigRef.current;
          if (toolName === 'log_gap_word' && agentConfig) {
            const gapWord: GapWord = {
              native_word: toolArgs.native_word || '',
              target_word: toolArgs.target_word || '',
              timestamp: Date.now(),
            };
            addGapWord(agentConfig.name, gapWord);
            setSessionGapWords(prev => [...prev, gapWord]);
            console.log('[CLIENT] Gap word saved:', gapWord);
          }
          break;

        case 'response.audio.delta':
          // Track item_id for truncation on interrupt
          if (data.item_id) {
            lastResponseItemIdRef.current = data.item_id;
          }

          if (interactionModeRef.current !== 'speaking') {
            debugLog('MODE', 'Mode: -> speaking (streaming started)');
            setInteractionMode('speaking');

            // Track when this response started playing (for truncation calculation)
            if (audioContextRef.current) {
              responseStartTimeRef.current = audioContextRef.current.currentTime;
              debugLog('BARGE-IN', `Response started at AudioContext time: ${responseStartTimeRef.current.toFixed(3)}s`);
            }
          }

          // Latency Log: First Byte
          if (lastSpeechStoppedTimeRef.current && !lastFirstAudioReceivedTimeRef.current) {
            lastFirstAudioReceivedTimeRef.current = Date.now();
            const latency = lastFirstAudioReceivedTimeRef.current - lastSpeechStoppedTimeRef.current;
            console.log(`[CLIENT] [LATENCY] First Audio Delta Received: ${latency}ms`);
          }

          if (data.delta) {
            scheduleAudioChunk(data.delta);
          }
          break;

        case 'response.audio_transcript.delta':
          if (data.delta) {
            setAiTranscript(prev => prev + data.delta);
          }
          break;

        case 'input_audio_buffer.speech_started':
          console.log('[CLIENT] INTERRUPT - User speaking (server VAD)');
          debugLog('MODE', 'INTERRUPT! Mode: -> listening');

          // Calculate how much audio actually played before interrupt (for truncation)
          let audioEndMs = 0;
          if (audioContextRef.current && responseStartTimeRef.current > 0) {
            const elapsedSeconds = audioContextRef.current.currentTime - responseStartTimeRef.current;
            audioEndMs = Math.max(0, Math.floor(elapsedSeconds * 1000));
            debugLog('BARGE-IN', `Audio played before interrupt: ${audioEndMs}ms`);
          }

          // Send truncation event to keep conversation history coherent
          // This tells OpenAI exactly how much of its response the user heard
          if (lastResponseItemIdRef.current && audioEndMs > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
            const truncateEvent = {
              type: 'conversation.item.truncate',
              item_id: lastResponseItemIdRef.current,
              content_index: 0,
              audio_end_ms: audioEndMs,
            };
            wsRef.current.send(JSON.stringify(truncateEvent));
            console.log(`[CLIENT] Sent truncate event: item_id=${lastResponseItemIdRef.current}, audio_end_ms=${audioEndMs}`);
          }

          stopAudioPlayback();
          setInteractionMode('listening');
          setAiTranscript('');
          setDisplaySubtitle('');
          subtitleQueueRef.current = [];
          prevBreakIdxRef.current = 0;
          isTimedDisplayRef.current = false;
          if (subtitleTimerRef.current) { clearTimeout(subtitleTimerRef.current); subtitleTimerRef.current = null; }

          // Reset tracking refs
          lastResponseItemIdRef.current = null;
          responseStartTimeRef.current = 0;
          break;

        case 'input_audio_buffer.speech_stopped':
          debugLog('MODE', 'Mode: -> processing');
          lastSpeechStoppedTimeRef.current = Date.now();
          lastFirstAudioReceivedTimeRef.current = null;
          setInteractionMode('processing');
          break;

        // Barge-in confirmation events
        case 'response.cancelled':
          console.log('[CLIENT] Response cancelled (barge-in successful)');
          break;

        case 'conversation.item.truncated':
          debugLog('BARGE-IN', 'Truncation confirmed by OpenAI');
          break;

        // Vision acknowledgment from server (optional)
        case 'vision.received':
          debugLog('VISION', 'Server acknowledged vision frame');
          break;
      }
    } catch (e) {
      console.log('[CLIENT] Non-JSON message received');
    }
  }, [scheduleAudioChunk, stopAudioPlayback, initAudioContext, startRecording]);

  // -------------------------------------------------------------------------
  // WEBSOCKET CONNECTION
  // -------------------------------------------------------------------------
  const BYPASS_BACKEND = false; // Set to true for UI testing without AWS backend

  const connect = useCallback((config: AgentConfig) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    // Validate config
    if (!config || !config.name || !config.language) {
      console.error('[CLIENT] Invalid agent config:', config);
      return;
    }

    // Store the agent config and update display name
    try {
      setCurrentAgentConfig(config);
      currentAgentConfigRef.current = config;
      setAgentName(config.name);
      sessionStartTimeRef.current = Date.now();
      debugLog('CONNECTION', `Connecting to ${config.name} (${config.language})...`);
      setConnectionStatus('Connecting...');

      // Clear any leftover state from a previous call
      setAiTranscript('');
      setSessionGapWords([]);
      setShowVocabPopup(false);
      setDisplaySubtitle('');
      subtitleQueueRef.current = [];
      prevBreakIdxRef.current = 0;
      isTimedDisplayRef.current = false;
      if (subtitleTimerRef.current) { clearTimeout(subtitleTimerRef.current); subtitleTimerRef.current = null; }
    } catch (e) {
      console.error('[CLIENT] Error setting up connection state:', e);
      return;
    }

    if (BYPASS_BACKEND) {
      console.log('[CLIENT] BYPASS_BACKEND active. Simulating connection...');
      setTimeout(() => {
        setConnectionStatus('AI Connected');
        setIsConnected(true);
        setInteractionMode('listening');
        debugLog('CONNECTION', 'Connected (Simulated)');
      }, 1500);
      return;
    }

    try {
      console.log(`[CLIENT] Connecting to: ${RELAY_SERVER_URL}`);
      const ws = new WebSocket(RELAY_SERVER_URL);
      wsRef.current = ws;

      // Track if we successfully connected (to distinguish close events)
      let didConnect = false;

      ws.onopen = () => {
        didConnect = true;
        console.log('[CLIENT] Connected');
        debugLog('CONNECTION', 'Connected');

        // =====================================================================
        // HARDWARE AEC ACTIVATION
        // Start InCallManager to activate iOS voiceChat mode / Android voice
        // call routing. This enables hardware echo cancellation which is
        // critical for barge-in to work without feedback loops.
        // =====================================================================
        try {
          InCallManager.start({ media: 'audio' });
          InCallManager.setSpeakerphoneOn(true);
          console.log('[AEC] InCallManager started - speaker mode ON');
        } catch (e) {
          console.warn('[AEC] Failed to start InCallManager:', e);
        }

        // Reset ambient calibration for new session
        isAmbientCalibratedRef.current = false;
        calibrationSamplesRef.current = [];
        ambientFloorRef.current = 0;

        // PHASE 3.1: Send agent.config
        // The server will handle generating the Friend Mode system prompt
        const agentConfigMessage = {
          type: 'agent.config',
          config: {
            name: config.name,
            language: config.language,
          },
        };
        ws.send(JSON.stringify(agentConfigMessage));
        debugLog('SESSION', `Sent agent.config for ${config.name}: ${config.language} tutor`);
      };

      ws.onmessage = handleMessage;

      ws.onerror = (e) => {
        console.error('[CLIENT] WebSocket error:', e);
        // Don't reset UI here - let onclose handle it
      };

      ws.onclose = (event) => {
        console.log('[CLIENT] Disconnected, code:', event.code, 'reason:', event.reason);
        debugLog('CONNECTION', 'Disconnected');

        // Only reset UI if we were previously connected or after a delay
        if (didConnect) {
          // Normal disconnect - reset immediately
          setConnectionStatus('Offline');
          setIsConnected(false);
          setInteractionMode('idle');
        } else {
          // Connection failed - show error briefly before resetting
          setConnectionStatus('Connection Failed');
          setTimeout(() => {
            setConnectionStatus('Offline');
            setIsConnected(false);
            setInteractionMode('idle');
          }, 2000);
        }

        wsRef.current = null;
        stopAudioPlayback();
        stopRecording();
      };
    } catch (error) {
      console.error('[CLIENT] Failed to create WebSocket:', error);
      setConnectionStatus('Connection Failed');
      setTimeout(() => {
        setConnectionStatus('Offline');
        setIsConnected(false);
      }, 2000);
    }
  }, [handleMessage, stopRecording, stopAudioPlayback]);

  const disconnect = useCallback(() => {
    // Save to history before disconnecting
    if (currentAgentConfig && sessionStartTimeRef.current) {
      const duration = Math.floor((Date.now() - sessionStartTimeRef.current) / 1000);
      const historyItem: CallHistoryItem = {
        id: generateUUID(),
        agentConfig: currentAgentConfig,
        timestamp: new Date(sessionStartTimeRef.current),
        duration,
      };
      setCallHistory(prev => {
        const updated = [historyItem, ...prev];
        // Persist to AsyncStorage
        saveCallHistory(updated);
        return updated;
      });
      // Also save the agent to persistent storage
      addAgent(currentAgentConfig);
      debugLog('HISTORY', `Saved session: ${currentAgentConfig.name} (${duration}s)`);
    }

    stopRecording();
    stopAudioPlayback();

    // Stop hardware AEC
    try {
      InCallManager.stop();
      console.log('[AEC] InCallManager stopped');
    } catch (e) {
      console.warn('[AEC] Failed to stop InCallManager:', e);
    }

    // Reset agent config
    setCurrentAgentConfig(null);
    currentAgentConfigRef.current = null;
    sessionStartTimeRef.current = null;

    if (BYPASS_BACKEND) {
      setConnectionStatus('Offline');
      setIsConnected(false);
      setInteractionMode('idle');
      return;
    }

    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected');
      wsRef.current = null;
    }
    setConnectionStatus('Offline');
    setIsConnected(false);
  }, [stopRecording, stopAudioPlayback, currentAgentConfig]);

  // -------------------------------------------------------------------------
  // UI CONTROL HANDLERS
  // -------------------------------------------------------------------------
  const handleToggleMute = useCallback(() => {
    setIsMuted(prev => !prev);
  }, []);

  const handleToggleCamera = useCallback(() => {
    setIsCameraOn(prev => !prev);
  }, []);

  const handleFlipCamera = useCallback(() => {
    setCameraFacing(prev => prev === 'front' ? 'back' : 'front');
  }, []);

  const handleToggleNoiseIsolation = useCallback(() => {
    setIsNoiseIsolationOn(prev => !prev);
  }, []);

  // Delete a call history item
  const handleDeleteItem = useCallback((itemId: string) => {
    setCallHistory(prev => {
      const updated = prev.filter(item => item.id !== itemId);
      saveCallHistory(updated);
      return updated;
    });
  }, []);

  // -------------------------------------------------------------------------
  // LIFECYCLE
  // -------------------------------------------------------------------------
  useEffect(() => {
    const init = async () => {
      const granted = await requestMicrophonePermission();
      setPermissionGranted(granted);

      // Load persisted data from AsyncStorage
      const storedHistory = await loadCallHistory();

      // If no history exists, load placeholder data for preview
      if (storedHistory.length === 0) {
        const placeholderHistory: CallHistoryItem[] = [
          {
            id: 'demo-1',
            agentConfig: { name: 'María', language: 'Spanish', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 30), // 30 min ago
            duration: 245,
          },
          {
            id: 'demo-2',
            agentConfig: { name: 'Pierre', language: 'French', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 60 * 3), // 3 hours ago
            duration: 180,
          },
          {
            id: 'demo-3',
            agentConfig: { name: 'Yuki', language: 'Japanese', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24), // yesterday
            duration: 420,
          },
        ];
        setCallHistory(placeholderHistory);

        // Also add some placeholder gap words for María
        const { saveAllGapWords } = await import('./storage');
        await saveAllGapWords({
          'María': [
            { native_word: 'to run', target_word: 'correr', timestamp: Date.now() - 1000 * 60 * 25 },
            { native_word: 'window', target_word: 'ventana', timestamp: Date.now() - 1000 * 60 * 20 },
            { native_word: 'to understand', target_word: 'entender', timestamp: Date.now() - 1000 * 60 * 15 },
            { native_word: 'beautiful', target_word: 'hermoso', timestamp: Date.now() - 1000 * 60 * 10 },
          ],
          'Pierre': [
            { native_word: 'always', target_word: 'toujours', timestamp: Date.now() - 1000 * 60 * 60 * 2 },
            { native_word: 'tomorrow', target_word: 'demain', timestamp: Date.now() - 1000 * 60 * 60 * 2.5 },
          ],
        });
        console.log('[STORAGE] Loaded placeholder data for preview');
      } else {
        setCallHistory(storedHistory);
        console.log('[STORAGE] Loaded call history:', storedHistory.length, 'items');
      }
    };
    init();

    return () => {
      stopRecording();
      stopAudioPlayback();
      if (wsRef.current) wsRef.current.close();
    };
  }, [requestMicrophonePermission, stopRecording, stopAudioPlayback]);


  // -------------------------------------------------------------------------
  // AUTO-CONNECT FOR DEMO (Optional)
  // -------------------------------------------------------------------------
  useEffect(() => {
    // connect(); // Uncomment to auto-connect on load
  }, [connect]);


  const showCallUI = isConnected || connectionStatus === 'Connecting...' || connectionStatus === 'Connection Failed';

  // -------------------------------------------------------------------------
  // ANIMATION STATE & STYLES (Optimized for 120Hz iOS + Android)
  // -------------------------------------------------------------------------
  const animState = useSharedValue(0); // 0 = Disconnected (Sheet visible), 1 = Connected (UI visible)
  const { height: SCREEN_HEIGHT } = Dimensions.get('window');

  useEffect(() => {
    if (showCallUI) {
      // Spring in: UI arrives with momentum (physical, satisfying)
      animState.value = withSpring(1, {
        damping: 20,
        stiffness: 180,
        mass: 0.8,
      });
    } else {
      // Timing out: decisive dismissal (no bounce on exit)
      animState.value = withTiming(0, {
        duration: 350,
        easing: Easing.in(Easing.cubic),
      });
    }
  }, [showCallUI]);

  // Call history: iOS slides down, Android fades + scales
  const sheetStyle = useAnimatedStyle(() => {
    'worklet';
    if (Platform.OS === 'android') {
      return {
        opacity: interpolate(animState.value, [0, 1], [1, 0], Extrapolation.CLAMP),
        transform: [{
          scale: interpolate(animState.value, [0, 1], [1, 0.95], Extrapolation.CLAMP),
        }],
      };
    }
    return {
      opacity: interpolate(animState.value, [0, 0.6, 1], [1, 0.8, 0], Extrapolation.CLAMP),
      transform: [{
        translateY: interpolate(animState.value, [0, 1], [0, SCREEN_HEIGHT], Extrapolation.CLAMP),
      }],
    };
  });

  // Call UI fades in
  const uiLayerStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: interpolate(animState.value, [0, 0.4, 1], [0, 0, 1], Extrapolation.CLAMP),
    };
  });


  // -------------------------------------------------------------------------
  // TIMED SUBTITLE QUEUE
  // -------------------------------------------------------------------------
  // Advance to the next queued sentence, or fall back to the streaming tail.
  const advanceSubtitle = useCallback(() => {
    subtitleTimerRef.current = null;
    if (subtitleQueueRef.current.length > 0) {
      const next = subtitleQueueRef.current.shift()!;
      setDisplaySubtitle(next.text);
      isTimedDisplayRef.current = true;
      subtitleTimerRef.current = setTimeout(advanceSubtitle, next.duration);
    } else {
      isTimedDisplayRef.current = false;
      // Show current streaming tail (in-progress sentence)
      const tail = aiTranscriptRef.current.slice(prevBreakIdxRef.current).trim();
      setDisplaySubtitle(tail);
    }
  }, []);

  // Detect sentence boundaries and enqueue timed subtitles.
  useEffect(() => {
    if (!aiTranscript) return; // resets handled by event handlers directly

    // Scan for new sentence boundaries
    const breakPoints = /[.!?。！？]\s/g;
    let m;
    while ((m = breakPoints.exec(aiTranscript)) !== null) {
      const breakEnd = m.index + m[0].length;
      if (breakEnd > prevBreakIdxRef.current) {
        const sentence = aiTranscript.slice(prevBreakIdxRef.current, m.index + 1).trim();
        if (sentence) {
          // ~60ms per char, floor 1.2s, cap 4s
          const duration = Math.min(4000, Math.max(1200, sentence.length * 60));
          subtitleQueueRef.current.push({ text: sentence, duration });
        }
        prevBreakIdxRef.current = breakEnd;
      }
    }

    // If nothing timed is on screen, either start the queue or show streaming tail
    if (!isTimedDisplayRef.current) {
      if (subtitleQueueRef.current.length > 0) {
        const next = subtitleQueueRef.current.shift()!;
        setDisplaySubtitle(next.text);
        isTimedDisplayRef.current = true;
        subtitleTimerRef.current = setTimeout(advanceSubtitle, next.duration);
      } else {
        // Live-stream the current in-progress sentence
        const tail = aiTranscript.slice(prevBreakIdxRef.current).trim();
        if (tail) setDisplaySubtitle(tail);
      }
    }
  }, [aiTranscript, advanceSubtitle]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (subtitleTimerRef.current) clearTimeout(subtitleTimerRef.current); };
  }, []);

  // -------------------------------------------------------------------------
  // RENDER
  // -------------------------------------------------------------------------
  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* LAYER 1: Viewfinder Background (Always active but obscured by Sheet initially) */}
      <Viewfinder
        ref={viewfinderRef}
        isCameraOn={isCameraOn}
        facing={cameraFacing}
      />

      {/* LAYER 2: Main Call UI (Fade In / Slide Up) */}
      <Animated.View
        style={[
          styles.uiLayer,
          { paddingTop: insets.top, paddingBottom: insets.bottom, zIndex: showCallUI ? 10 : 0 },
          uiLayerStyle
        ]}
        pointerEvents={showCallUI ? 'auto' : 'none'}
      >
        {/* Top Status */}
        <StatusPill
          status={isConnected ? `Connected to ${agentName}` : connectionStatus}
          isConnected={isConnected}
        />

        {/* Center Orb */}
        <View style={styles.orbContainer}>
          <ActiveOrb
            mode={interactionMode}
            volumeLevel={volumeLevel}
            stabilityProgress={stabilityProgress}
            isStable={isStableSV}
          />
        </View>

        {/* AI Transcript (between orb and controls) */}
        {displaySubtitle.length > 0 && (
          <View style={styles.transcriptContainer}>
            <View style={styles.transcriptBubble}>
              <Text style={styles.transcriptText} numberOfLines={3}>
                {displaySubtitle}
              </Text>
            </View>
          </View>
        )}

        {/* Vocabulary Popup (floats above controls) */}
        <VocabularyPopup
          words={sessionGapWords}
          isVisible={showVocabPopup}
          onClose={() => setShowVocabPopup(false)}
        />

        {/* Bottom Controls */}
        <ControlSheet
          onDisconnect={disconnect}
          isMuted={isMuted}
          onToggleMute={handleToggleMute}
          isCameraOn={isCameraOn}
          onToggleCamera={handleToggleCamera}
          onFlipCamera={handleFlipCamera}
          isNoiseIsolationOn={isNoiseIsolationOn}
          onToggleNoiseIsolation={handleToggleNoiseIsolation}
          onToggleVocabulary={() => setShowVocabPopup(prev => !prev)}
        />
      </Animated.View>

      {/* LAYER 3: Call History / Start Screen (Slides Down) */}
      <Animated.View style={[StyleSheet.absoluteFill, sheetStyle]}>
        <CallHistoryScreen
          onConnect={connect}
          history={callHistory}
          onViewGapWords={(agent) => setSelectedAgentForGapWords(agent)}
          onDeleteItem={handleDeleteItem}
        />
      </Animated.View>

      {/* LAYER 4: Gap Words Screen (slides in from right) */}
      {selectedAgentForGapWords && (
        <GapWordsScreen
          agent={selectedAgentForGapWords}
          onBack={() => setSelectedAgentForGapWords(null)}
        />
      )}
    </View>
  );
};

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Show loading indicator while fonts load (Android only needs this)
  if (!fontsLoaded && Platform.OS === 'android') {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#34C759" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <MainScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  uiLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    zIndex: 10,
  },
  orbContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transcriptContainer: {
    paddingHorizontal: 24,
    paddingBottom: 12,
    alignItems: 'center',
  },
  transcriptBubble: {
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxWidth: '100%',
  },
  transcriptText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '400',
    letterSpacing: -0.24,
    textAlign: 'center',
    lineHeight: 20,
  },
});
