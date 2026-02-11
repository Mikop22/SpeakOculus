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
} from 'react-native-reanimated';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AudioContext, AudioBufferSourceNode } from 'react-native-audio-api';
import * as ImageManipulator from 'expo-image-manipulator';

import { ActiveOrb, OrbMode } from './components/ActiveOrb';
import { StatusPill } from './components/StatusPill';
import { ControlSheet } from './components/ControlSheet';
import { Viewfinder, CameraFacing, ViewfinderRef } from './components/Viewfinder';
import { CallHistoryScreen, AgentConfig, CallHistoryItem } from './components/CallHistoryScreen';
import { GapWordsScreen } from './components/GapWordsScreen';
import { VocabularyPopup } from './components/VocabularyPopup';
import { useCameraStabilityWithReset } from './hooks/useCameraStability';

import { addAgent, loadCallHistory, saveCallHistory, addGapWord, GapWord } from './storage';

// ── Configuration ──

const USE_LOCAL_RELAY = true;
const RELAY_PRODUCTION_URL = process.env.EXPO_PUBLIC_RELAY_URL ?? 'ws://localhost:8082';
const RELAY_PORT = 8082;
const USE_ADB_REVERSE = true; // Assumes `adb reverse tcp:8082 tcp:8082`
const LOCAL_RELAY_IP = 'localhost';

const RELAY_SERVER_URL = (() => {
  if (!USE_LOCAL_RELAY) return RELAY_PRODUCTION_URL;
  if (Platform.OS === 'android') {
    if (USE_ADB_REVERSE) return `ws://127.0.0.1:${RELAY_PORT}`;
    // Android emulator maps 10.0.2.2 to the host loopback
    const host = LOCAL_RELAY_IP === 'localhost' ? '10.0.2.2' : LOCAL_RELAY_IP;
    return `ws://${host}:${RELAY_PORT}`;
  }
  return `ws://${LOCAL_RELAY_IP}:${RELAY_PORT}`;
})();

const SAMPLE_RATE = 24000; // OpenAI Realtime API requires 24 kHz PCM

// Barge-in: consecutive frames above the noise floor to confirm real speech
const BARGE_IN_CONSECUTIVE_FRAMES = 3; // ~120 ms at 40 ms per frame
const CALIBRATION_SAMPLES = 25;        // ~1 s of silence for noise floor

const VISION_COOLDOWN_MS = 8000;
const CROSSHAIR_SIZE = 280; // Must match the orb diameter in ActiveOrb

const DEBUG_MODE = false;
const BYPASS_BACKEND = false; // UI-only testing without a relay server

function debugLog(tag: string, message: string, data?: any): void {
  if (!DEBUG_MODE) return;
  const timestamp = new Date().toISOString().substr(11, 12);
  if (data !== undefined) {
    console.log(`[${timestamp}] ${tag}: ${message}`, data);
  } else {
    console.log(`[${timestamp}] ${tag}: ${message}`);
  }
}

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// audioSource 7 = VOICE_COMMUNICATION mode (Android), enabling hardware AEC.
// Critical for barge-in: prevents AI playback from echoing back into the mic.
const AUDIO_RECORD_OPTIONS = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 7,
  wavFile: 'speak_vision.wav',
  bufferSize: 1920, // 40 ms at 24 kHz
};

// ── Main Screen ──

const MainScreen = () => {
  const insets = useSafeAreaInsets();

  const [connectionStatus, setConnectionStatus] = useState<string>('Offline');
  const [isConnected, setIsConnected] = useState(false);
  const [agentName, setAgentName] = useState('Assistant');
  const [interactionMode, setInteractionMode] = useState<OrbMode>('idle');
  const interactionModeRef = useRef<OrbMode>('idle');
  const [permissionGranted, setPermissionGranted] = useState(false);

  const [currentAgentConfig, setCurrentAgentConfig] = useState<AgentConfig | null>(null);
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>([]);
  const [selectedAgentForGapWords, setSelectedAgentForGapWords] = useState<AgentConfig | null>(null);

  const [sessionGapWords, setSessionGapWords] = useState<GapWord[]>([]);
  const [showVocabPopup, setShowVocabPopup] = useState(false);

  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>('back');
  const [isNoiseIsolationOn, setIsNoiseIsolationOn] = useState(true);

  const [visionEnabled, setVisionEnabled] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);

  const [aiTranscript, setAiTranscript] = useState('');
  const [displaySubtitle, setDisplaySubtitle] = useState('');

  // Refs mirror state for use inside non-re-rendering closures (audio callbacks)
  const isMutedRef = useRef(false);
  const currentAgentConfigRef = useRef<AgentConfig | null>(null);
  const sessionStartTimeRef = useRef<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioRecordInitializedRef = useRef(false);
  const viewfinderRef = useRef<ViewfinderRef>(null);

  const lastSpeechStoppedTimeRef = useRef<number | null>(null);
  const lastFirstAudioReceivedTimeRef = useRef<number | null>(null);

  const lastCaptureTimeRef = useRef<number>(0);
  const captureInProgressRef = useRef(false);

  // Web Audio API for gapless PCM scheduling
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const pendingSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const isPlayingRef = useRef(false);

  const lastResponseItemIdRef = useRef<string | null>(null);
  const responseStartTimeRef = useRef<number>(0);
  const consecutiveAboveRef = useRef<number>(0);
  const bargeInRmsHistoryRef = useRef<number[]>([]);

  // Ambient noise calibration (baseline for barge-in thresholds)
  const ambientFloorRef = useRef<number>(0);
  const calibrationSamplesRef = useRef<number[]>([]);
  const isAmbientCalibratedRef = useRef<boolean>(false);

  // Subtitle queue (sentences shown one at a time with timed transitions)
  const aiTranscriptRef = useRef('');
  const subtitleQueueRef = useRef<{text: string; duration: number}[]>([]);
  const subtitleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevBreakIdxRef = useRef(0);
  const isTimedDisplayRef = useRef(false);

  const volumeLevel = useSharedValue(0);

  // Sync refs so non-re-rendering callbacks read fresh values
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { interactionModeRef.current = interactionMode; }, [interactionMode]);
  useEffect(() => { aiTranscriptRef.current = aiTranscript; }, [aiTranscript]);

  // ── Helpers ──

  /** Animate the volume orb. Dampened mode (30%) is used when muted or calibrating. */
  function animateVolume(rms: number, dampened = false): void {
    volumeLevel.value = withTiming(dampened ? rms * 0.3 : rms, {
      duration: 40,
      easing: Easing.out(Easing.quad),
    });
  }

  /** Reset all subtitle and transcript state between responses. */
  function resetSubtitleState(): void {
    setAiTranscript('');
    setDisplaySubtitle('');
    subtitleQueueRef.current = [];
    prevBreakIdxRef.current = 0;
    isTimedDisplayRef.current = false;
    if (subtitleTimerRef.current) {
      clearTimeout(subtitleTimerRef.current);
      subtitleTimerRef.current = null;
    }
  }

  /** Returns how many ms of audio actually played before an interrupt (for truncation). */
  function calculatePlayedAudioMs(): number {
    if (!audioContextRef.current || responseStartTimeRef.current <= 0) return 0;
    const elapsed = audioContextRef.current.currentTime - responseStartTimeRef.current;
    return Math.max(0, Math.floor(elapsed * 1000));
  }

  /** Notify OpenAI how much audio the user actually heard before a barge-in. */
  function sendTruncationEvent(audioEndMs: number, logPrefix: string): void {
    if (!lastResponseItemIdRef.current || audioEndMs <= 0) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'conversation.item.truncate',
      item_id: lastResponseItemIdRef.current,
      content_index: 0,
      audio_end_ms: audioEndMs,
    }));
    console.log(`[${logPrefix}] Sent truncate: item_id=${lastResponseItemIdRef.current}, audio_end_ms=${audioEndMs}`);
  }

  // ── Stability detection (auto-captures when the device is held steady) ──

  const {
    isStableSV,
    stabilityProgress,
    resetStability,
  } = useCameraStabilityWithReset({
    enabled: visionEnabled && isConnected && isCameraOn && !isCapturing,
  });

  // ── RMS calculation ──

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

  // ── Vision capture ──

  const captureAndSendFrame = useCallback(async () => {
    if (captureInProgressRef.current) return;

    const now = Date.now();
    if (now - lastCaptureTimeRef.current < VISION_COOLDOWN_MS) return;
    if (isPlayingRef.current) return;
    if (!viewfinderRef.current) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    try {
      captureInProgressRef.current = true;
      setIsCapturing(true);
      setInteractionMode('processing');

      const photo = await viewfinderRef.current.takePictureAsync({
        quality: 0.7,
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

      // Map the on-screen crosshair rectangle to photo-pixel crop coordinates
      const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
      const crosshairScreenX = (screenWidth - CROSSHAIR_SIZE) / 2;
      const crosshairScreenY = (screenHeight - CROSSHAIR_SIZE) / 2;

      const photoAspect = photo.width / photo.height;
      const screenAspect = screenWidth / screenHeight;

      let scaleX: number, scaleY: number, offsetX = 0, offsetY = 0;

      if (photoAspect > screenAspect) {
        scaleY = photo.height / screenHeight;
        scaleX = scaleY;
        offsetX = (photo.width - screenWidth * scaleX) / 2;
      } else {
        scaleX = photo.width / screenWidth;
        scaleY = scaleX;
        offsetY = (photo.height - screenHeight * scaleY) / 2;
      }

      const cropX = Math.max(0, Math.round(offsetX + crosshairScreenX * scaleX));
      const cropY = Math.max(0, Math.round(offsetY + crosshairScreenY * scaleY));
      const cropSize = Math.round(CROSSHAIR_SIZE * scaleX);

      // Clamp to image bounds
      const finalCropX = Math.min(cropX, photo.width - cropSize);
      const finalCropY = Math.min(cropY, photo.height - cropSize);
      const finalCropSize = Math.min(cropSize, photo.width - finalCropX, photo.height - finalCropY);

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
          { resize: { width: 384, height: 384 } },
        ],
        { base64: true, compress: 0.5, format: ImageManipulator.SaveFormat.JPEG }
      );

      if (!croppedImage.base64) {
        console.error('[VISION] Failed to crop photo');
        setInteractionMode('listening');
        return;
      }

      wsRef.current.send(JSON.stringify({
        type: 'vision.direct_injection',
        image: croppedImage.base64,
        timestamp: now,
      }));
      debugLog('VISION', 'Frame sent to server');

      lastCaptureTimeRef.current = now;
      resetStability();

    } catch (error) {
      console.error('[VISION] Capture error:', error);
      setInteractionMode('listening');
    } finally {
      captureInProgressRef.current = false;
      setIsCapturing(false);
    }
  }, [resetStability]);

  useAnimatedReaction(
    () => isStableSV.value,
    (currentlyStable, previouslyStable) => {
      if (currentlyStable && !previouslyStable) {
        runOnJS(captureAndSendFrame)();
      }
    }
  );

  // ── Audio playback ──

  const initAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      console.log('[AUDIO] Initializing AudioContext');
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      nextStartTimeRef.current = 0;
    } else if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  }, []);

  const scheduleAudioChunk = useCallback(async (base64Delta: string) => {
    if (!audioContextRef.current) initAudioContext();
    const ctx = audioContextRef.current!;

    if (ctx.state === 'suspended') {
      console.log('[AUDIO] Context suspended. Resuming...');
      await ctx.resume();
    }

    try {
      const rawBuffer = Buffer.from(base64Delta, 'base64');
      const int16Array = new Int16Array(
        rawBuffer.buffer,
        rawBuffer.byteOffset,
        rawBuffer.length / 2
      );

      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      const audioBuffer = ctx.createBuffer(1, float32Array.length, SAMPLE_RATE);
      audioBuffer.copyToChannel(float32Array, 0);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      // Schedule after last chunk; catch up on buffer underrun
      const startTime = Math.max(ctx.currentTime, nextStartTimeRef.current);
      source.start(startTime);

      if (!isPlayingRef.current) {
        isPlayingRef.current = true;
        console.log(`[AUDIO] Playback starting - ctx.state: ${ctx.state}, sampleRate: ${ctx.sampleRate}, currentTime: ${ctx.currentTime.toFixed(2)}s, samples: ${float32Array.length}, startTime: ${startTime.toFixed(2)}s, duration: ${audioBuffer.duration.toFixed(3)}s`);
      }

      if (lastFirstAudioReceivedTimeRef.current) {
        const now = Date.now();
        const processingLag = now - lastFirstAudioReceivedTimeRef.current;
        console.log(`[CLIENT] [LATENCY] Stream Started (Processing Lag: ${processingLag}ms)`);
        if (lastSpeechStoppedTimeRef.current) {
          console.log(`[CLIENT] [LATENCY] TOTAL E2E LATENCY: ${now - lastSpeechStoppedTimeRef.current}ms`);
        }
        lastFirstAudioReceivedTimeRef.current = null;
      }

      nextStartTimeRef.current = startTime + audioBuffer.duration;
      pendingSourcesRef.current.push(source);

      const onEndedHandler = () => {
        if ((source as any)._hasEnded) return;
        (source as any)._hasEnded = true;

        const index = pendingSourcesRef.current.indexOf(source);
        if (index > -1) pendingSourcesRef.current.splice(index, 1);

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
    pendingSourcesRef.current.forEach(source => {
      try { source.stop(); } catch { }
    });
    pendingSourcesRef.current = [];
    nextStartTimeRef.current = 0;
    isPlayingRef.current = false;
    consecutiveAboveRef.current = 0;
    bargeInRmsHistoryRef.current = [];
  }, []);

  // ── Microphone permission ──

  const requestMicrophonePermission = useCallback(async (): Promise<boolean> => {
    try {
      if (Platform.OS !== 'android') {
        // iOS: permission is requested automatically by react-native-audio-record
        console.log('[CLIENT] iOS: Mic permission handled by native module');
        return true;
      }
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
    } catch (error) {
      console.error('[CLIENT] Permission error:', error);
      return false;
    }
  }, []);

  // ── Audio recording ──

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

      const rms = calculateRMS(base64Data);

      if (isMutedRef.current) {
        animateVolume(rms, true);
        return;
      }

      // The AI speaks first, giving us a natural window of silence to
      // measure the ambient noise floor before barge-in detection begins.
      if (!isAmbientCalibratedRef.current) {
        if (!isPlayingRef.current) {
          calibrationSamplesRef.current.push(rms);
          if (calibrationSamplesRef.current.length >= CALIBRATION_SAMPLES) {
            const sum = calibrationSamplesRef.current.reduce((a, b) => a + b, 0);
            ambientFloorRef.current = sum / calibrationSamplesRef.current.length;
            isAmbientCalibratedRef.current = true;
            console.log(`[CALIBRATION] Ambient floor: ${ambientFloorRef.current.toFixed(4)} RMS (${CALIBRATION_SAMPLES} samples)`);
            calibrationSamplesRef.current = [];
          }
          animateVolume(rms, true);
          return;
        }
        // AI started speaking before calibration finished -- force-complete
        const samples = calibrationSamplesRef.current;
        if (samples.length >= 3) {
          ambientFloorRef.current = samples.reduce((a, b) => a + b, 0) / samples.length;
        } else {
          ambientFloorRef.current = 0.01;
        }
        isAmbientCalibratedRef.current = true;
        console.log(`[CALIBRATION] Ambient floor (force): ${ambientFloorRef.current.toFixed(4)} RMS (${samples.length} samples)`);
        calibrationSamplesRef.current = [];
        // Fall through to barge-in / normal send
      }

      // Hardware AEC (audioSource 7) strips speaker echo, so RMS here
      // reflects real user speech. Both client-side (optimistic) and
      // server-side (OpenAI VAD) barge-in paths run simultaneously.
      if (isPlayingRef.current) {
        const threshold = Math.max(ambientFloorRef.current * 3, 0.02);
        if (rms > threshold) {
          consecutiveAboveRef.current++;
          bargeInRmsHistoryRef.current.push(rms);
          if (consecutiveAboveRef.current >= BARGE_IN_CONSECUTIVE_FRAMES) {
            console.log(`[BARGE-IN] Local barge-in triggered! RMS history: [${bargeInRmsHistoryRef.current.map(r => r.toFixed(4)).join(', ')}], threshold: ${threshold.toFixed(4)}`);
            consecutiveAboveRef.current = 0;
            bargeInRmsHistoryRef.current = [];

            const audioEndMs = calculatePlayedAudioMs();
            sendTruncationEvent(audioEndMs, 'BARGE-IN');

            stopAudioPlayback();
            setInteractionMode('listening');
            lastResponseItemIdRef.current = null;
            responseStartTimeRef.current = 0;
          }
        } else {
          consecutiveAboveRef.current = 0;
          bargeInRmsHistoryRef.current = [];
        }

        // Send cleaned audio to OpenAI even during playback (for server-side VAD)
        animateVolume(rms, false);
        wsRef.current.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64Data,
        }));
        return;
      }

      animateVolume(rms, false);
      wsRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: base64Data,
      }));
    });

    audioRecordInitializedRef.current = true;
    return true;
  }, [calculateRMS, volumeLevel]);

  const startRecording = useCallback(async () => {
    if (!permissionGranted) return;
    const ready = initAudioRecord();
    if (!ready) return;

    stopAudioPlayback();
    AudioRecord.start();
    console.log('[MIC] AudioRecord.start() called - microphone active');
    setInteractionMode('listening');
  }, [permissionGranted, initAudioRecord, stopAudioPlayback]);

  const stopRecording = useCallback(() => {
    try { AudioRecord.stop(); } catch { }
    volumeLevel.value = 0;
    console.log('[CLIENT] Recording stopped');
  }, [volumeLevel]);

  // ── WebSocket message handler ──

  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      const eventType = data.type || 'unknown';

      // Sample 5% of high-frequency audio deltas for logging
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
          startRecording();
          break;

        case 'session.updated':
          console.log('[CLIENT] Session ready');
          break;

        case 'response.created':
          resetSubtitleState();
          break;

        case 'response.function_call_arguments.done': {
          const toolName = data.name ?? 'unknown';
          let toolArgs: Record<string, string> = {};
          try {
            if (typeof data.arguments === 'string') toolArgs = JSON.parse(data.arguments);
          } catch { /* ignore malformed args */ }
          console.log('[CLIENT] TOOL CALL:', toolName, toolArgs);

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
        }

        case 'response.audio.delta':
          if (data.item_id) {
            lastResponseItemIdRef.current = data.item_id;
          }

          if (interactionModeRef.current !== 'speaking') {
            debugLog('MODE', 'Mode: -> speaking (streaming started)');
            setInteractionMode('speaking');

            if (audioContextRef.current) {
              responseStartTimeRef.current = audioContextRef.current.currentTime;
              debugLog('BARGE-IN', `Response started at AudioContext time: ${responseStartTimeRef.current.toFixed(3)}s`);
            }
          }

          // First-byte latency: time from user speech end to first audio delta
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

        case 'input_audio_buffer.speech_started': {
          console.log('[CLIENT] INTERRUPT - User speaking (server VAD)');

          const audioEndMs = calculatePlayedAudioMs();
          debugLog('BARGE-IN', `Audio played before interrupt: ${audioEndMs}ms`);
          sendTruncationEvent(audioEndMs, 'CLIENT');

          stopAudioPlayback();
          setInteractionMode('listening');
          resetSubtitleState();

          lastResponseItemIdRef.current = null;
          responseStartTimeRef.current = 0;
          break;
        }

        case 'input_audio_buffer.speech_stopped':
          lastSpeechStoppedTimeRef.current = Date.now();
          lastFirstAudioReceivedTimeRef.current = null;
          setInteractionMode('processing');
          break;

        case 'response.cancelled':
          console.log('[CLIENT] Response cancelled (barge-in successful)');
          break;

        case 'conversation.item.truncated':
          debugLog('BARGE-IN', 'Truncation confirmed by OpenAI');
          break;

        case 'vision.received':
          debugLog('VISION', 'Server acknowledged vision frame');
          break;
      }
    } catch (e) {
      console.log('[CLIENT] Non-JSON message received');
    }
  }, [scheduleAudioChunk, stopAudioPlayback, initAudioContext, startRecording]);

  // ── WebSocket connection ──

  const connect = useCallback((config: AgentConfig) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    if (!config?.name || !config?.language) {
      console.error('[CLIENT] Invalid agent config:', config);
      return;
    }

    setCurrentAgentConfig(config);
    currentAgentConfigRef.current = config;
    setAgentName(config.name);
    sessionStartTimeRef.current = Date.now();
    setConnectionStatus('Connecting...');

    // Clear leftover state from any previous session
    resetSubtitleState();
    setSessionGapWords([]);
    setShowVocabPopup(false);

    if (BYPASS_BACKEND) {
      console.log('[CLIENT] BYPASS_BACKEND active. Simulating connection...');
      setTimeout(() => {
        setConnectionStatus('AI Connected');
        setIsConnected(true);
        setInteractionMode('listening');
      }, 1500);
      return;
    }

    try {
      console.log(`[CLIENT] Connecting to: ${RELAY_SERVER_URL}`);
      const ws = new WebSocket(RELAY_SERVER_URL);
      wsRef.current = ws;

      let didConnect = false;

      ws.onopen = () => {
        didConnect = true;
        console.log('[CLIENT] Connected');

        // InCallManager routes audio through the voice call path,
        // enabling hardware AEC which is critical for barge-in.
        try {
          InCallManager.start({ media: 'audio' });
          InCallManager.setSpeakerphoneOn(true);
          console.log('[AEC] InCallManager started - speaker mode ON');
        } catch (e) {
          console.warn('[AEC] Failed to start InCallManager:', e);
        }

        // Reset ambient calibration for the new session
        isAmbientCalibratedRef.current = false;
        calibrationSamplesRef.current = [];
        ambientFloorRef.current = 0;

        // Tell the relay server which agent/language to configure
        ws.send(JSON.stringify({
          type: 'agent.config',
          config: {
            name: config.name,
            language: config.language,
          },
        }));
        debugLog('SESSION', `Sent agent.config for ${config.name}: ${config.language} tutor`);
      };

      ws.onmessage = handleMessage;

      ws.onerror = (e) => {
        console.error('[CLIENT] WebSocket error:', e);
      };

      ws.onclose = (event) => {
        console.log('[CLIENT] Disconnected, code:', event.code, 'reason:', event.reason);

        if (didConnect) {
          setConnectionStatus('Offline');
          setIsConnected(false);
          setInteractionMode('idle');
        } else {
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
        saveCallHistory(updated);
        return updated;
      });
      addAgent(currentAgentConfig);
      debugLog('HISTORY', `Saved session: ${currentAgentConfig.name} (${duration}s)`);
    }

    stopRecording();
    stopAudioPlayback();

    try {
      InCallManager.stop();
      console.log('[AEC] InCallManager stopped');
    } catch (e) {
      console.warn('[AEC] Failed to stop InCallManager:', e);
    }

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

  // ── UI control handlers ──

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

  const handleDeleteItem = useCallback((itemId: string) => {
    setCallHistory(prev => {
      const updated = prev.filter(item => item.id !== itemId);
      saveCallHistory(updated);
      return updated;
    });
  }, []);

  // ── Lifecycle ──

  useEffect(() => {
    const init = async () => {
      const granted = await requestMicrophonePermission();
      setPermissionGranted(granted);

      const storedHistory = await loadCallHistory();

      if (storedHistory.length === 0) {
        // Seed demo data so first-time users see a populated UI
        const placeholderHistory: CallHistoryItem[] = [
          {
            id: 'demo-1',
            agentConfig: { name: 'Mar\u00eda', language: 'Spanish', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 30),
            duration: 245,
          },
          {
            id: 'demo-2',
            agentConfig: { name: 'Pierre', language: 'French', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 60 * 3),
            duration: 180,
          },
          {
            id: 'demo-3',
            agentConfig: { name: 'Yuki', language: 'Japanese', systemPrompt: '' },
            timestamp: new Date(Date.now() - 1000 * 60 * 60 * 24),
            duration: 420,
          },
        ];
        setCallHistory(placeholderHistory);

        const { saveAllGapWords } = await import('./storage');
        await saveAllGapWords({
          'Mar\u00eda': [
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

  const showCallUI = isConnected || connectionStatus === 'Connecting...' || connectionStatus === 'Connection Failed';

  // ── Transition animations ──

  const animState = useSharedValue(0); // 0 = history visible, 1 = call UI visible
  const { height: SCREEN_HEIGHT } = Dimensions.get('window');

  useEffect(() => {
    if (showCallUI) {
      animState.value = withSpring(1, { damping: 20, stiffness: 180, mass: 0.8 });
    } else {
      animState.value = withTiming(0, { duration: 350, easing: Easing.in(Easing.cubic) });
    }
  }, [showCallUI]);

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

  const uiLayerStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: interpolate(animState.value, [0, 0.4, 1], [0, 0, 1], Extrapolation.CLAMP),
    };
  });

  // ── Timed subtitle queue ──

  const advanceSubtitle = useCallback(() => {
    subtitleTimerRef.current = null;
    if (subtitleQueueRef.current.length > 0) {
      const next = subtitleQueueRef.current.shift()!;
      setDisplaySubtitle(next.text);
      isTimedDisplayRef.current = true;
      subtitleTimerRef.current = setTimeout(advanceSubtitle, next.duration);
    } else {
      isTimedDisplayRef.current = false;
      const tail = aiTranscriptRef.current.slice(prevBreakIdxRef.current).trim();
      setDisplaySubtitle(tail);
    }
  }, []);

  useEffect(() => {
    if (!aiTranscript) return;

    const breakPoints = /[.!?\u3002\uFF01\uFF1F]\s/g;
    let m;
    while ((m = breakPoints.exec(aiTranscript)) !== null) {
      const breakEnd = m.index + m[0].length;
      if (breakEnd > prevBreakIdxRef.current) {
        const sentence = aiTranscript.slice(prevBreakIdxRef.current, m.index + 1).trim();
        if (sentence) {
          // ~60ms per char, clamped to 1.2s--4s
          const duration = Math.min(4000, Math.max(1200, sentence.length * 60));
          subtitleQueueRef.current.push({ text: sentence, duration });
        }
        prevBreakIdxRef.current = breakEnd;
      }
    }

    if (!isTimedDisplayRef.current) {
      if (subtitleQueueRef.current.length > 0) {
        const next = subtitleQueueRef.current.shift()!;
        setDisplaySubtitle(next.text);
        isTimedDisplayRef.current = true;
        subtitleTimerRef.current = setTimeout(advanceSubtitle, next.duration);
      } else {
        const tail = aiTranscript.slice(prevBreakIdxRef.current).trim();
        if (tail) setDisplaySubtitle(tail);
      }
    }
  }, [aiTranscript, advanceSubtitle]);

  useEffect(() => {
    return () => { if (subtitleTimerRef.current) clearTimeout(subtitleTimerRef.current); };
  }, []);

  // ── Render ──

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      <Viewfinder
        ref={viewfinderRef}
        isCameraOn={isCameraOn}
        facing={cameraFacing}
      />

      <Animated.View
        style={[
          styles.uiLayer,
          { paddingTop: insets.top, paddingBottom: insets.bottom, zIndex: showCallUI ? 10 : 0 },
          uiLayerStyle
        ]}
        pointerEvents={showCallUI ? 'auto' : 'none'}
      >
        <StatusPill
          status={isConnected ? `Connected to ${agentName}` : connectionStatus}
          isConnected={isConnected}
        />

        <View style={styles.orbContainer}>
          <ActiveOrb
            mode={interactionMode}
            volumeLevel={volumeLevel}
            stabilityProgress={stabilityProgress}
            isStable={isStableSV}
          />
        </View>

        {displaySubtitle.length > 0 && (
          <View style={styles.transcriptContainer}>
            <View style={styles.transcriptBubble}>
              <Text style={styles.transcriptText} numberOfLines={3}>
                {displaySubtitle}
              </Text>
            </View>
          </View>
        )}

        <VocabularyPopup
          words={sessionGapWords}
          isVisible={showVocabPopup}
          onClose={() => setShowVocabPopup(false)}
        />

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

      <Animated.View style={[StyleSheet.absoluteFill, sheetStyle]}>
        <CallHistoryScreen
          onConnect={connect}
          history={callHistory}
          onViewGapWords={(agent) => setSelectedAgentForGapWords(agent)}
          onDeleteItem={handleDeleteItem}
        />
      </Animated.View>

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
