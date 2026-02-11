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
  /** Retained for API compatibility; not used internally. */
  isStable?: SharedValue<boolean>;
}

const ORB_SIZE = 280;
const BORDER_WIDTH = 3;
const CORNER_RADIUS = 40;
const CORNER_SIZE = 24;
const CORNER_INSET = 18;
const CORNER_BORDER = 2.5;

// Numeric encoding for worklet interpolation: idle=0, listening=1, speaking=2, processing=3
const MODE_INDEX: Record<OrbMode, number> = {
  idle: 0,
  listening: 1,
  speaking: 2,
  processing: 3,
};

const MODE_RANGE = [0, 1, 2, 3];

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
  stabilityProgress,
}) => {
  // Animated mode value drives all color transitions on the UI thread
  const modeVal = useSharedValue(MODE_INDEX[mode]);

  useEffect(() => {
    modeVal.value = withTiming(MODE_INDEX[mode], {
      duration: 300,
      easing: Easing.out(Easing.cubic),
    });
  }, [mode]);

  // Continuous idle breathing oscillation
  const breathe = useSharedValue(0);

  useEffect(() => {
    breathe.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 2000, easing: Easing.inOut(Easing.sin) })
      ),
      -1,
    );
  }, []);

  const borderStyle = useAnimatedStyle(() => {
    'worklet';
    const color = interpolateColor(modeVal.value, MODE_RANGE, BORDER_COLORS);
    const opacity = interpolate(modeVal.value, [0, 0.5, 1, 2, 3], [0.4, 0.7, 1, 1, 0.8]);
    return { borderColor: color, opacity };
  });

  const cornerStyle = useAnimatedStyle(() => {
    'worklet';
    return { borderColor: interpolateColor(modeVal.value, MODE_RANGE, CORNER_COLORS) };
  });

  // Breathing scale fades out when not idle
  const breatheStyle = useAnimatedStyle(() => {
    'worklet';
    const idleFactor = interpolate(modeVal.value, [0, 0.5], [1, 0], 'clamp');
    const scale = interpolate(breathe.value, [0, 1], [1, 1.02]);
    return {
      transform: [{ scale: 1 + (scale - 1) * idleFactor }],
    };
  });

  const fillStyle = useAnimatedStyle(() => {
    'worklet';
    const activeFactor = interpolate(modeVal.value, [0, 0.8], [0, 1], 'clamp');
    const vol = interpolate(volumeLevel.value, [0, 0.3, 1], [0.02, 0.08, 0.2]);
    return { opacity: vol * activeFactor };
  });

  const glowStyle = useAnimatedStyle(() => {
    'worklet';
    const baseGlow = interpolate(modeVal.value, MODE_RANGE, [0, 0.25, 0.4, 0.1]);
    const speakingFactor = interpolate(modeVal.value, [1.5, 2, 2.5], [0, 1, 0], 'clamp');
    const volBoost = volumeLevel.value * 0.25 * speakingFactor;
    return {
      opacity: baseGlow + volBoost,
      transform: [{ scale: 1 + volBoost * 0.08 }],
    };
  });

  const stabilityStyle = useAnimatedStyle(() => {
    'worklet';
    if (!stabilityProgress) return { opacity: 0 };
    const p = stabilityProgress.value;
    return {
      opacity: interpolate(p, [0, 0.05, 1], [0, 0.35, 0.8]),
      transform: [{ scale: interpolate(p, [0, 1], [1.04, 1.0]) }],
      borderWidth: interpolate(p, [0, 1], [1, 2.5]),
    };
  });

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.glow, glowStyle]} />
      <Animated.View style={[styles.stabilityRing, stabilityStyle]} />

      <Animated.View style={[styles.box, borderStyle, breatheStyle]}>
        <Animated.View style={[styles.fill, fillStyle]} />

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
