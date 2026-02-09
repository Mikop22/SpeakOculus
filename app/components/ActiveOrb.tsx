import React, { useEffect } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  interpolate,
  interpolateColor,
  withTiming,
  withRepeat,
  withSequence,
  Easing,
  SharedValue,
} from 'react-native-reanimated';

export type OrbMode = 'idle' | 'listening' | 'speaking' | 'processing';

interface ActiveOrbProps {
  mode: OrbMode;
  volumeLevel: SharedValue<number>;
  stabilityProgress?: SharedValue<number>;
  isStable?: SharedValue<boolean>;
}

const ORB_SIZE = 280;
const BORDER_WIDTH = 3;
const CORNER_RADIUS = 40;
const CORNER_SIZE = 24;
const CORNER_INSET = 18;
const CORNER_BORDER = 2.5;

// Numeric mode encoding for worklet-driven interpolation
// 0 = idle, 1 = listening, 2 = speaking, 3 = processing
const MODE_INDEX: Record<OrbMode, number> = {
  idle: 0,
  listening: 1,
  speaking: 2,
  processing: 3,
};

// Color stops for each mode (must match MODE_INDEX order)
const BORDER_COLORS = [
  'rgba(255, 255, 255, 0.2)', // idle
  '#34C759',                   // listening
  '#34C759',                   // speaking
  'rgba(255, 255, 255, 0.5)', // processing
];

const CORNER_COLORS = [
  'rgba(255, 255, 255, 0.15)', // idle
  'rgba(52, 199, 89, 0.6)',    // listening
  'rgba(52, 199, 89, 0.8)',    // speaking
  'rgba(255, 255, 255, 0.4)',  // processing
];

export const ActiveOrb: React.FC<ActiveOrbProps> = ({
  mode,
  volumeLevel,
  stabilityProgress: stabilityProgressProp,
}) => {
  // -----------------------------------------------------------------------
  // MODE AS SHAREDVALUE (drives all color transitions on UI thread)
  // -----------------------------------------------------------------------
  const modeVal = useSharedValue(MODE_INDEX[mode]);

  useEffect(() => {
    modeVal.value = withTiming(MODE_INDEX[mode], {
      duration: 300,
      easing: Easing.out(Easing.cubic),
    });
  }, [mode]);

  // -----------------------------------------------------------------------
  // IDLE BREATHING (continuous subtle scale oscillation)
  // -----------------------------------------------------------------------
  const breathe = useSharedValue(0);

  useEffect(() => {
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 2000, easing: Easing.inOut(Easing.sin) })
      ),
      -1, // infinite
    );
  }, []);

  // -----------------------------------------------------------------------
  // ANIMATED STYLES (all worklets, zero JS thread work)
  // -----------------------------------------------------------------------

  // Box border color + opacity transition
  const borderStyle = useAnimatedStyle(() => {
    'worklet';
    const color = interpolateColor(
      modeVal.value,
      [0, 1, 2, 3],
      BORDER_COLORS,
    );
    const opacity = interpolate(modeVal.value, [0, 0.5, 1, 2, 3], [0.4, 0.7, 1, 1, 0.8]);
    return { borderColor: color, opacity };
  });

  // Corner marker color transition (shared across all 4 corners)
  const cornerStyle = useAnimatedStyle(() => {
    'worklet';
    const color = interpolateColor(
      modeVal.value,
      [0, 1, 2, 3],
      CORNER_COLORS,
    );
    return { borderColor: color };
  });

  // Container breathing (fades out when not idle)
  const containerBreathStyle = useAnimatedStyle(() => {
    'worklet';
    const idleFactor = interpolate(modeVal.value, [0, 0.5], [1, 0], 'clamp');
    const scale = interpolate(breathe.value, [0, 1], [1, 1.02]);
    return {
      transform: [{ scale: 1 + (scale - 1) * idleFactor }],
    };
  });

  // Volume-reactive fill
  const fillStyle = useAnimatedStyle(() => {
    'worklet';
    const activeFactor = interpolate(modeVal.value, [0, 0.8], [0, 1], 'clamp');
    const vol = interpolate(volumeLevel.value, [0, 0.3, 1], [0.02, 0.08, 0.2]);
    return { opacity: vol * activeFactor };
  });

  // Glow halo (always mounted, opacity-driven by mode + volume)
  const glowStyle = useAnimatedStyle(() => {
    'worklet';
    const baseGlow = interpolate(
      modeVal.value,
      [0, 1, 2, 3],
      [0, 0.25, 0.4, 0.1],
    );
    // Pulse with volume when speaking (mode ~2)
    const speakingFactor = interpolate(modeVal.value, [1.5, 2, 2.5], [0, 1, 0], 'clamp');
    const volBoost = volumeLevel.value * 0.25 * speakingFactor;
    const totalOpacity = baseGlow + volBoost;
    return {
      opacity: totalOpacity,
      transform: [{ scale: 1 + volBoost * 0.08 }],
    };
  });

  // Stability progress ring
  const stabilityStyle = useAnimatedStyle(() => {
    'worklet';
    if (!stabilityProgressProp) return { opacity: 0 };
    const p = stabilityProgressProp.value;
    return {
      opacity: interpolate(p, [0, 0.05, 1], [0, 0.35, 0.8]),
      transform: [{ scale: interpolate(p, [0, 1], [1.04, 1.0]) }],
      borderWidth: interpolate(p, [0, 1], [1, 2.5]),
    };
  });

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------
  return (
    <View style={styles.container}>
      {/* Glow halo (behind everything) */}
      <Animated.View style={[styles.glow, glowStyle]} />

      {/* Stability progress ring */}
      <Animated.View style={[styles.stabilityRing, stabilityStyle]} />

      {/* Main crosshair box */}
      <Animated.View style={[styles.box, borderStyle, containerBreathStyle]}>
        {/* Volume-reactive fill */}
        <Animated.View style={[styles.fill, fillStyle]} />

        {/* Corner markers */}
        <Animated.View style={[styles.cornerTL, cornerStyle]} />
        <Animated.View style={[styles.cornerTR, cornerStyle]} />
        <Animated.View style={[styles.cornerBL, cornerStyle]} />
        <Animated.View style={[styles.cornerBR, cornerStyle]} />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: ORB_SIZE + 60,
    height: ORB_SIZE + 60,
    justifyContent: 'center',
    alignItems: 'center',
    pointerEvents: 'none',
  },
  glow: {
    position: 'absolute',
    width: ORB_SIZE + 40,
    height: ORB_SIZE + 40,
    borderRadius: CORNER_RADIUS + 20,
    backgroundColor: 'rgba(52, 199, 89, 0.12)',
    ...(Platform.OS === 'ios'
      ? {
          shadowColor: '#34C759',
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.5,
          shadowRadius: 30,
        }
      : {
          elevation: 8,
        }),
  },
  stabilityRing: {
    position: 'absolute',
    width: ORB_SIZE + 16,
    height: ORB_SIZE + 16,
    borderRadius: CORNER_RADIUS + 8,
    borderColor: 'rgba(48, 213, 200, 0.5)',
    borderWidth: 1,
  },
  box: {
    width: ORB_SIZE,
    height: ORB_SIZE,
    borderRadius: CORNER_RADIUS,
    borderWidth: BORDER_WIDTH,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: CORNER_RADIUS - 2,
    backgroundColor: '#34C759',
  },
  cornerTL: {
    position: 'absolute',
    top: CORNER_INSET,
    left: CORNER_INSET,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderTopWidth: CORNER_BORDER,
    borderLeftWidth: CORNER_BORDER,
    borderTopLeftRadius: 10,
  },
  cornerTR: {
    position: 'absolute',
    top: CORNER_INSET,
    right: CORNER_INSET,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderTopWidth: CORNER_BORDER,
    borderRightWidth: CORNER_BORDER,
    borderTopRightRadius: 10,
  },
  cornerBL: {
    position: 'absolute',
    bottom: CORNER_INSET,
    left: CORNER_INSET,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderBottomWidth: CORNER_BORDER,
    borderLeftWidth: CORNER_BORDER,
    borderBottomLeftRadius: 10,
  },
  cornerBR: {
    position: 'absolute',
    bottom: CORNER_INSET,
    right: CORNER_INSET,
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderBottomWidth: CORNER_BORDER,
    borderRightWidth: CORNER_BORDER,
    borderBottomRightRadius: 10,
  },
});
