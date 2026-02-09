/**
 * useCameraStability.ts
 *
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
  stabilityProgress: SharedValue<number>;  // 0-1, drives UI thread animations
  isStableSV: SharedValue<boolean>;        // true when fully stable
  varianceSV: SharedValue<number>;         // for debug
  resetStability: () => void;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const UPDATE_INTERVAL_MS = 16; // ~60Hz sampling
const WINDOW_SIZE = 30; // 30 samples = ~500ms sliding window
const STABILITY_THRESHOLD = 0.15; // Maximum variance (in G) to be considered stable
const STABLE_DURATION_MS = 1200; // Must be stable for 1.2 seconds before triggering

interface StabilityState {
  isStable: boolean;
  stabilityProgress: number; // 0-1, useful for UI feedback
  variance: number; // Current calculated variance (for debugging)
}

interface UseCameraStabilityOptions {
  enabled?: boolean; // Allow disabling the hook when not needed
  onStabilized?: () => void; // Callback when device becomes stable
}

/**
 * Custom hook that monitors device stability via accelerometer.
 *
 * @param options - Configuration options
 * @returns StabilityState object with isStable, stabilityProgress, and variance
 */
export function useCameraStability(options: UseCameraStabilityOptions = {}): StabilityState {
  const { enabled = true, onStabilized } = options;

  const [state, setState] = useState<StabilityState>({
    isStable: false,
    stabilityProgress: 0,
    variance: 0,
  });

  // Refs for tracking state without causing re-renders
  const samplesRef = useRef<AccelerometerMeasurement[]>([]);
  const stableStartTimeRef = useRef<number | null>(null);
  const wasStableRef = useRef(false);
  const subscriptionRef = useRef<ReturnType<typeof Accelerometer.addListener> | null>(null);

  /**
   * Calculate variance across all three axes from the sample window.
   * Uses the formula: variance = avg(delta^2) where delta = sample - mean
   */
  const calculateVariance = useCallback((samples: AccelerometerMeasurement[]): number => {
    if (samples.length < 2) return 1; // Not enough data, assume unstable

    // Calculate means
    let sumX = 0, sumY = 0, sumZ = 0;
    for (const s of samples) {
      sumX += s.x;
      sumY += s.y;
      sumZ += s.z;
    }
    const meanX = sumX / samples.length;
    const meanY = sumY / samples.length;
    const meanZ = sumZ / samples.length;

    // Calculate variance (sum of squared deviations from mean)
    let varianceSum = 0;
    for (const s of samples) {
      varianceSum += Math.pow(s.x - meanX, 2);
      varianceSum += Math.pow(s.y - meanY, 2);
      varianceSum += Math.pow(s.z - meanZ, 2);
    }

    // Average variance across all dimensions
    return Math.sqrt(varianceSum / (samples.length * 3));
  }, []);

  /**
   * Process new accelerometer data
   */
  const handleAccelerometerData = useCallback((data: AccelerometerMeasurement) => {
    const samples = samplesRef.current;

    // Add new sample to window
    samples.push(data);

    // Maintain sliding window size
    while (samples.length > WINDOW_SIZE) {
      samples.shift();
    }

    // Need at least half the window filled before calculating
    if (samples.length < WINDOW_SIZE / 2) {
      setState(prev => ({
        ...prev,
        variance: 1,
        stabilityProgress: 0,
        isStable: false,
      }));
      return;
    }

    // Calculate current variance
    const variance = calculateVariance(samples);
    const isCurrentlyStable = variance < STABILITY_THRESHOLD;
    const now = Date.now();

    // Track how long we've been stable
    if (isCurrentlyStable) {
      if (stableStartTimeRef.current === null) {
        stableStartTimeRef.current = now;
      }

      const stableDuration = now - stableStartTimeRef.current;
      const progress = Math.min(stableDuration / STABLE_DURATION_MS, 1);
      const isFullyStable = stableDuration >= STABLE_DURATION_MS;

      // Fire callback when transitioning to stable
      if (isFullyStable && !wasStableRef.current) {
        wasStableRef.current = true;
        onStabilized?.();
      }

      setState({
        variance,
        stabilityProgress: progress,
        isStable: isFullyStable,
      });
    } else {
      // Reset stability tracking
      stableStartTimeRef.current = null;
      wasStableRef.current = false;

      setState({
        variance,
        stabilityProgress: 0,
        isStable: false,
      });
    }
  }, [calculateVariance, onStabilized]);

  /**
   * Subscribe to accelerometer updates
   */
  useEffect(() => {
    if (!enabled) {
      // Clean up if disabled
      if (subscriptionRef.current) {
        subscriptionRef.current.remove();
        subscriptionRef.current = null;
      }
      samplesRef.current = [];
      stableStartTimeRef.current = null;
      wasStableRef.current = false;
      setState({
        isStable: false,
        stabilityProgress: 0,
        variance: 0,
      });
      return;
    }

    // Set update interval before subscribing
    Accelerometer.setUpdateInterval(UPDATE_INTERVAL_MS);

    // Subscribe to accelerometer
    subscriptionRef.current = Accelerometer.addListener(handleAccelerometerData);

    console.log('[useCameraStability] Accelerometer subscription started');

    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.remove();
        subscriptionRef.current = null;
        console.log('[useCameraStability] Accelerometer subscription stopped');
      }
      samplesRef.current = [];
      stableStartTimeRef.current = null;
      wasStableRef.current = false;
    };
  }, [enabled, handleAccelerometerData]);

  /**
   * Reset stability state (useful after capture)
   */
  const resetStability = useCallback(() => {
    samplesRef.current = [];
    stableStartTimeRef.current = null;
    wasStableRef.current = false;
    setState({
      isStable: false,
      stabilityProgress: 0,
      variance: 0,
    });
  }, []);

  return {
    ...state,
    // Expose reset function via a different mechanism if needed
    // For now, the hook automatically resets when variance goes high
  };
}

/**
 * Extended version with reset capability exposed.
 * Uses SharedValues instead of React state to avoid 60 re-renders/sec
 * from accelerometer callbacks. All output values are SharedValues that
 * drive UI thread animations with zero React re-renders.
 */
export function useCameraStabilityWithReset(options: UseCameraStabilityOptions = {}): StabilityResultSV {
  const { enabled = true, onStabilized } = options;

  // SharedValues for output - drive UI thread animations with zero re-renders
  const stabilityProgress = useSharedValue(0);
  const isStableSV = useSharedValue(false);
  const varianceSV = useSharedValue(0);

  // Refs for internal tracking (no state, no re-renders)
  const samplesRef = useRef<AccelerometerMeasurement[]>([]);
  const stableStartTimeRef = useRef<number | null>(null);
  const wasStableRef = useRef(false);
  const subscriptionRef = useRef<ReturnType<typeof Accelerometer.addListener> | null>(null);
  const onStabilizedRef = useRef(onStabilized);

  // Keep callback ref up to date without triggering effect re-runs
  useEffect(() => {
    onStabilizedRef.current = onStabilized;
  }, [onStabilized]);

  const calculateVariance = useCallback((samples: AccelerometerMeasurement[]): number => {
    if (samples.length < 2) return 1;

    let sumX = 0, sumY = 0, sumZ = 0;
    for (const s of samples) {
      sumX += s.x;
      sumY += s.y;
      sumZ += s.z;
    }
    const meanX = sumX / samples.length;
    const meanY = sumY / samples.length;
    const meanZ = sumZ / samples.length;

    let varianceSum = 0;
    for (const s of samples) {
      varianceSum += Math.pow(s.x - meanX, 2);
      varianceSum += Math.pow(s.y - meanY, 2);
      varianceSum += Math.pow(s.z - meanZ, 2);
    }

    return Math.sqrt(varianceSum / (samples.length * 3));
  }, []);

  const resetStability = useCallback(() => {
    samplesRef.current = [];
    stableStartTimeRef.current = null;
    wasStableRef.current = false;
    stabilityProgress.value = 0;
    isStableSV.value = false;
    varianceSV.value = 0;
  }, [stabilityProgress, isStableSV, varianceSV]);

  const handleAccelerometerData = useCallback((data: AccelerometerMeasurement) => {
    const samples = samplesRef.current;
    samples.push(data);

    while (samples.length > WINDOW_SIZE) {
      samples.shift();
    }

    if (samples.length < WINDOW_SIZE / 2) {
      varianceSV.value = 1;
      stabilityProgress.value = 0;
      isStableSV.value = false;
      return;
    }

    const variance = calculateVariance(samples);
    const isCurrentlyStable = variance < STABILITY_THRESHOLD;
    const now = Date.now();

    if (isCurrentlyStable) {
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

      varianceSV.value = variance;
      stabilityProgress.value = progress;
      isStableSV.value = isFullyStable;
    } else {
      stableStartTimeRef.current = null;
      wasStableRef.current = false;

      varianceSV.value = variance;
      stabilityProgress.value = 0;
      isStableSV.value = false;
    }
  }, [calculateVariance, stabilityProgress, isStableSV, varianceSV]);

  useEffect(() => {
    if (!enabled) {
      if (subscriptionRef.current) {
        subscriptionRef.current.remove();
        subscriptionRef.current = null;
      }
      resetStability();
      return;
    }

    Accelerometer.setUpdateInterval(UPDATE_INTERVAL_MS);
    subscriptionRef.current = Accelerometer.addListener(handleAccelerometerData);

    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.remove();
        subscriptionRef.current = null;
      }
    };
  }, [enabled, handleAccelerometerData, resetStability]);

  return {
    stabilityProgress,
    isStableSV,
    varianceSV,
    resetStability,
  };
}

export default useCameraStability;
export type { StabilityResultSV as StabilityResultSVType };
