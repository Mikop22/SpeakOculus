/**
 * Detects when the user is holding the phone steady using the Accelerometer.
 * Used to trigger automatic vision capture when the device is stable.
 *
 * Algorithm:
 * - Samples accelerometer data at ~60Hz (16ms intervals)
 * - Maintains a sliding window of the last N samples
 * - Calculates variance (delta) across x, y, z axes
 * - Device is considered "stable" when variance < threshold for STABLE_DURATION
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Accelerometer, AccelerometerMeasurement } from 'expo-sensors';
import { useSharedValue, SharedValue } from 'react-native-reanimated';

export interface StabilityResultSV {
  stabilityProgress: SharedValue<number>;
  isStableSV: SharedValue<boolean>;
  varianceSV: SharedValue<number>;
  resetStability: () => void;
}

export interface UseCameraStabilityOptions {
  enabled?: boolean;
  onStabilized?: () => void;
}

interface StabilityState {
  isStable: boolean;
  stabilityProgress: number;
  variance: number;
}

const UPDATE_INTERVAL_MS = 16;        // ~60Hz sampling
const WINDOW_SIZE = 30;               // 30 samples = ~500ms sliding window
const STABILITY_THRESHOLD = 0.15;     // Maximum variance (in G) to be considered stable
const STABLE_DURATION_MS = 1200;      // Must be stable for 1.2s before triggering
const MIN_SAMPLES = WINDOW_SIZE / 2;  // Need half the window filled before calculating

/**
 * Calculate the root-mean-square deviation across all three axes.
 * Returns 1 (unstable) when there are fewer than 2 samples.
 */
function calculateVariance(samples: AccelerometerMeasurement[]): number {
  if (samples.length < 2) return 1;

  let sumX = 0, sumY = 0, sumZ = 0;
  for (const s of samples) {
    sumX += s.x;
    sumY += s.y;
    sumZ += s.z;
  }
  const n = samples.length;
  const meanX = sumX / n;
  const meanY = sumY / n;
  const meanZ = sumZ / n;

  let deviationSum = 0;
  for (const s of samples) {
    const dx = s.x - meanX;
    const dy = s.y - meanY;
    const dz = s.z - meanZ;
    deviationSum += dx * dx + dy * dy + dz * dz;
  }

  return Math.sqrt(deviationSum / (n * 3));
}

/** Push a sample onto the sliding window, trimming excess from the front. */
function pushSample(samples: AccelerometerMeasurement[], data: AccelerometerMeasurement): void {
  samples.push(data);
  if (samples.length > WINDOW_SIZE) {
    samples.shift();
  }
}

/** Clear all internal tracking refs to their initial state. */
function clearTrackingRefs(
  samplesRef: React.MutableRefObject<AccelerometerMeasurement[]>,
  stableStartTimeRef: React.MutableRefObject<number | null>,
  wasStableRef: React.MutableRefObject<boolean>,
): void {
  samplesRef.current = [];
  stableStartTimeRef.current = null;
  wasStableRef.current = false;
}

const INITIAL_STATE: StabilityState = {
  isStable: false,
  stabilityProgress: 0,
  variance: 0,
};

/**
 * Monitors device stability via accelerometer using React state.
 * Re-renders on every accelerometer update (~60Hz). For high-frequency
 * use cases, prefer useCameraStabilityWithReset which uses SharedValues.
 */
export function useCameraStability(options: UseCameraStabilityOptions = {}): StabilityState {
  const { enabled = true, onStabilized } = options;

  const [state, setState] = useState<StabilityState>(INITIAL_STATE);

  const samplesRef = useRef<AccelerometerMeasurement[]>([]);
  const stableStartTimeRef = useRef<number | null>(null);
  const wasStableRef = useRef(false);
  const subscriptionRef = useRef<ReturnType<typeof Accelerometer.addListener> | null>(null);

  const handleAccelerometerData = useCallback((data: AccelerometerMeasurement) => {
    pushSample(samplesRef.current, data);

    if (samplesRef.current.length < MIN_SAMPLES) {
      setState({ variance: 1, stabilityProgress: 0, isStable: false });
      return;
    }

    const variance = calculateVariance(samplesRef.current);
    const isCurrentlyStable = variance < STABILITY_THRESHOLD;
    const now = Date.now();

    if (!isCurrentlyStable) {
      stableStartTimeRef.current = null;
      wasStableRef.current = false;
      setState({ variance, stabilityProgress: 0, isStable: false });
      return;
    }

    if (stableStartTimeRef.current === null) {
      stableStartTimeRef.current = now;
    }

    const stableDuration = now - stableStartTimeRef.current;
    const progress = Math.min(stableDuration / STABLE_DURATION_MS, 1);
    const isFullyStable = stableDuration >= STABLE_DURATION_MS;

    if (isFullyStable && !wasStableRef.current) {
      wasStableRef.current = true;
      onStabilized?.();
    }

    setState({ variance, stabilityProgress: progress, isStable: isFullyStable });
  }, [onStabilized]);

  useEffect(() => {
    if (!enabled) {
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      clearTrackingRefs(samplesRef, stableStartTimeRef, wasStableRef);
      setState(INITIAL_STATE);
      return;
    }

    Accelerometer.setUpdateInterval(UPDATE_INTERVAL_MS);
    subscriptionRef.current = Accelerometer.addListener(handleAccelerometerData);

    return () => {
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      clearTrackingRefs(samplesRef, stableStartTimeRef, wasStableRef);
    };
  }, [enabled, handleAccelerometerData]);

  return state;
}

/**
 * Extended version with reset capability exposed.
 * Uses SharedValues instead of React state to avoid ~60 re-renders/sec
 * from accelerometer callbacks. All output values drive UI thread
 * animations with zero React re-renders.
 */
export function useCameraStabilityWithReset(options: UseCameraStabilityOptions = {}): StabilityResultSV {
  const { enabled = true, onStabilized } = options;

  const stabilityProgress = useSharedValue(0);
  const isStableSV = useSharedValue(false);
  const varianceSV = useSharedValue(0);

  const samplesRef = useRef<AccelerometerMeasurement[]>([]);
  const stableStartTimeRef = useRef<number | null>(null);
  const wasStableRef = useRef(false);
  const subscriptionRef = useRef<ReturnType<typeof Accelerometer.addListener> | null>(null);
  const onStabilizedRef = useRef(onStabilized);

  useEffect(() => {
    onStabilizedRef.current = onStabilized;
  }, [onStabilized]);

  const resetStability = useCallback(() => {
    clearTrackingRefs(samplesRef, stableStartTimeRef, wasStableRef);
    stabilityProgress.value = 0;
    isStableSV.value = false;
    varianceSV.value = 0;
  }, [stabilityProgress, isStableSV, varianceSV]);

  const handleAccelerometerData = useCallback((data: AccelerometerMeasurement) => {
    pushSample(samplesRef.current, data);

    if (samplesRef.current.length < MIN_SAMPLES) {
      varianceSV.value = 1;
      stabilityProgress.value = 0;
      isStableSV.value = false;
      return;
    }

    const variance = calculateVariance(samplesRef.current);
    const isCurrentlyStable = variance < STABILITY_THRESHOLD;
    const now = Date.now();

    varianceSV.value = variance;

    if (!isCurrentlyStable) {
      stableStartTimeRef.current = null;
      wasStableRef.current = false;
      stabilityProgress.value = 0;
      isStableSV.value = false;
      return;
    }

    if (stableStartTimeRef.current === null) {
      stableStartTimeRef.current = now;
    }

    const stableDuration = now - stableStartTimeRef.current;
    const progress = Math.min(stableDuration / STABLE_DURATION_MS, 1);
    const isFullyStable = stableDuration >= STABLE_DURATION_MS;

    if (isFullyStable && !wasStableRef.current) {
      wasStableRef.current = true;
      onStabilizedRef.current?.();
    }

    stabilityProgress.value = progress;
    isStableSV.value = isFullyStable;
  }, [stabilityProgress, isStableSV, varianceSV]);

  useEffect(() => {
    if (!enabled) {
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      resetStability();
      return;
    }

    Accelerometer.setUpdateInterval(UPDATE_INTERVAL_MS);
    subscriptionRef.current = Accelerometer.addListener(handleAccelerometerData);

    return () => {
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
    };
  }, [enabled, handleAccelerometerData, resetStability]);

  return { stabilityProgress, isStableSV, varianceSV, resetStability };
}
