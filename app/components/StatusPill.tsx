import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  interpolate,
  Easing,
} from 'react-native-reanimated';
import { THEME } from '../theme';

interface StatusPillProps {
  status: string;
  isConnected?: boolean;
}

export const StatusPill = ({ status, isConnected = false }: StatusPillProps) => {
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (isConnected) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(0.35, { duration: 1000, easing: Easing.inOut(Easing.sin) }),
          withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.sin) })
        ),
        -1,
      );
    } else {
      pulse.value = withTiming(1, { duration: 200 });
    }
  }, [isConnected]);

  const indicatorStyle = useAnimatedStyle(() => {
    'worklet';
    return {
      opacity: pulse.value,
      transform: [{ scale: interpolate(pulse.value, [0.35, 1], [0.85, 1]) }],
    };
  });

  return (
    <View style={styles.container}>
      <BlurView
        intensity={THEME.blur.intensity}
        tint={THEME.blur.tint}
        style={styles.blur}
      >
        {isConnected && <Animated.View style={[styles.indicator, indicatorStyle]} />}
        <Text style={styles.text}>{status}</Text>
      </BlurView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderRadius: THEME.borderRadius.pill,
    alignSelf: 'center',
    marginTop: THEME.spacing.xl,
  },
  blur: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: THEME.spacing.md,
    backgroundColor: THEME.colors.surface,
  },
  indicator: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: THEME.colors.accent,
    marginRight: THEME.spacing.sm,
  },
  text: {
    ...THEME.typography.subheadline,
    fontWeight: '600',
    color: THEME.colors.textPrimary,
  },
});
