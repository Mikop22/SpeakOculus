import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    Text,
    TextInput,
    StyleSheet,
    TouchableOpacity,
    Dimensions,
    Platform,
    KeyboardAvoidingView,
} from 'react-native';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    withRepeat,
    withSequence,
    Easing,
    FadeIn,
    FadeOut,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Phone } from 'lucide-react-native';
import { THEME } from '../theme';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const LANGUAGES = [
    { id: 'english', label: 'English', flag: '\u{1F1FA}\u{1F1F8}', color: '#4A90D9' },
    { id: 'french', label: 'French', flag: '\u{1F1EB}\u{1F1F7}', color: '#6C5CE7' },
    { id: 'spanish', label: 'Spanish', flag: '\u{1F1EA}\u{1F1F8}', color: '#E17055' },
    { id: 'arabic', label: 'Arabic', flag: '\u{1F1F8}\u{1F1E6}', color: '#00B894' },
    { id: 'japanese', label: 'Japanese', flag: '\u{1F1EF}\u{1F1F5}', color: '#FD79A8' },
];

interface AgentConfig {
    name: string;
    language: string;
}

interface NewAgentSheetProps {
    isVisible: boolean;
    onClose: () => void;
    onStartSession: (config: AgentConfig) => void;
}

export const NewAgentSheet: React.FC<NewAgentSheetProps> = ({
    isVisible,
    onClose,
    onStartSession,
}) => {
    const insets = useSafeAreaInsets();
    const [name, setName] = useState('');
    const [language, setLanguage] = useState('');
    const [mounted, setMounted] = useState(false);
    const inputRef = useRef<TextInput>(null);

    const translateY = useSharedValue(SCREEN_HEIGHT);
    const backdropOpacity = useSharedValue(0);
    const avatarScale = useSharedValue(0);
    const pillsOpacity = useSharedValue(0);
    const pulseScale = useSharedValue(1);

    const trimmedName = name.trim();
    const showAvatar = trimmedName.length > 0;
    const showPills = trimmedName.length >= 2;
    const isFormValid = trimmedName.length > 0 && language.length > 0;
    const selectedLang = LANGUAGES.find(l => l.label === language);

    // Mount/unmount with exit animation
    useEffect(() => {
        if (isVisible) {
            setName('');
            setLanguage('');
            setMounted(true);
            translateY.value = withSpring(0, { damping: 25, stiffness: 300, mass: 0.8 });
            backdropOpacity.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
        } else if (mounted) {
            translateY.value = withTiming(SCREEN_HEIGHT, { duration: 300, easing: Easing.in(Easing.cubic) });
            backdropOpacity.value = withTiming(0, { duration: 200 });
            const timeout = setTimeout(() => {
                setMounted(false);
                avatarScale.value = 0;
                pillsOpacity.value = 0;
                pulseScale.value = 1;
            }, 350);
            return () => clearTimeout(timeout);
        }
    }, [isVisible]);

    // Avatar pop in/out
    useEffect(() => {
        if (!mounted) return;
        avatarScale.value = showAvatar
            ? withTiming(1, { duration: 200, easing: Easing.out(Easing.back(1.4)) })
            : withTiming(0, { duration: 150 });
    }, [showAvatar, mounted]);

    // Pills fade in/out
    useEffect(() => {
        if (!mounted) return;
        pillsOpacity.value = showPills
            ? withTiming(1, { duration: 300 })
            : withTiming(0, { duration: 150 });
    }, [showPills, mounted]);

    // Pulse when form is complete
    useEffect(() => {
        if (isFormValid) {
            pulseScale.value = withRepeat(
                withSequence(
                    withTiming(1.06, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
                    withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
                ),
                -1,
                true,
            );
        } else {
            pulseScale.value = withTiming(1, { duration: 200 });
        }
    }, [isFormValid]);

    const sheetStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: translateY.value }],
    }));

    const backdropStyle = useAnimatedStyle(() => ({
        opacity: backdropOpacity.value,
    }));

    const avatarAnimStyle = useAnimatedStyle(() => ({
        transform: [{ scale: avatarScale.value * pulseScale.value }],
        opacity: avatarScale.value,
    }));

    const pillsAnimStyle = useAnimatedStyle(() => ({
        opacity: pillsOpacity.value,
        transform: [{ translateY: (1 - pillsOpacity.value) * 10 }],
    }));

    const handleStartSession = useCallback(() => {
        if (!isFormValid) return;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        onStartSession({ name: trimmedName, language });
        setName('');
        setLanguage('');
    }, [trimmedName, language, isFormValid, onStartSession]);

    const handleSelectLanguage = useCallback((lang: typeof LANGUAGES[0]) => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setLanguage(prev => prev === lang.label ? '' : lang.label);
    }, []);

    if (!mounted) return null;

    const avatarBg = isFormValid
        ? THEME.colors.accent
        : (selectedLang?.color ?? 'rgba(255, 255, 255, 0.12)');

    return (
        <View style={styles.overlay}>
            {/* Backdrop */}
            <Animated.View style={[styles.backdrop, backdropStyle]}>
                <TouchableOpacity
                    style={StyleSheet.absoluteFill}
                    activeOpacity={1}
                    onPress={onClose}
                />
            </Animated.View>

            {/* Sheet */}
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardView}
            >
                <Animated.View style={[styles.sheetContainer, sheetStyle]}>
                    <BlurView
                        intensity={THEME.blur.intensity}
                        tint={THEME.blur.tint}
                        style={[styles.sheet, { paddingBottom: insets.bottom + 28 }]}
                    >
                        {/* Avatar — becomes the call button when valid */}
                        <Animated.View style={[styles.avatarWrapper, avatarAnimStyle]}>
                            <TouchableOpacity
                                onPress={isFormValid ? handleStartSession : undefined}
                                activeOpacity={isFormValid ? 0.7 : 1}
                                style={[
                                    styles.avatar,
                                    { backgroundColor: avatarBg },
                                    isFormValid && styles.avatarGlow,
                                ]}
                            >
                                {isFormValid ? (
                                    <Phone size={28} color="#FFF" fill="#FFF" />
                                ) : (
                                    <Text style={styles.avatarLetter}>
                                        {trimmedName.charAt(0).toUpperCase()}
                                    </Text>
                                )}
                            </TouchableOpacity>
                        </Animated.View>

                        {/* "Tap to call" hint */}
                        {isFormValid && (
                            <Animated.Text
                                entering={FadeIn.duration(200)}
                                exiting={FadeOut.duration(150)}
                                style={styles.callHint}
                            >
                                Tap to call {trimmedName}
                            </Animated.Text>
                        )}

                        {/* Name input — large, borderless, centered */}
                        <TextInput
                            ref={inputRef}
                            style={styles.nameInput}
                            placeholder="Who should I be?"
                            placeholderTextColor={THEME.colors.textTertiary}
                            value={name}
                            onChangeText={setName}
                            autoCapitalize="words"
                            autoCorrect={false}
                            textAlign="center"
                            selectionColor={THEME.colors.accent}
                        />

                        {/* Language pills — flag only, appear after 2+ chars */}
                        <Animated.View style={[styles.pillsRow, pillsAnimStyle]}>
                            {LANGUAGES.map(lang => {
                                const isSelected = language === lang.label;
                                return (
                                    <TouchableOpacity
                                        key={lang.id}
                                        onPress={() => handleSelectLanguage(lang)}
                                        activeOpacity={0.7}
                                        style={[
                                            styles.pill,
                                            isSelected && {
                                                borderColor: lang.color,
                                                backgroundColor: lang.color + '22',
                                            },
                                        ]}
                                    >
                                        <Text style={styles.pillFlag}>{lang.flag}</Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </Animated.View>
                    </BlurView>
                </Animated.View>
            </KeyboardAvoidingView>
        </View>
    );
};

const styles = StyleSheet.create({
    overlay: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 100,
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
    },
    keyboardView: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    sheetContainer: {
        width: '100%',
    },
    sheet: {
        backgroundColor: 'rgba(28, 28, 30, 0.92)',
        borderTopLeftRadius: 32,
        borderTopRightRadius: 32,
        paddingHorizontal: THEME.spacing.lg,
        paddingTop: 36,
        alignItems: 'center',
        overflow: 'hidden',
    },

    // Avatar
    avatarWrapper: {
        marginBottom: 8,
    },
    avatar: {
        width: 80,
        height: 80,
        borderRadius: 40,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: 'rgba(255, 255, 255, 0.08)',
    },
    avatarGlow: {
        borderColor: 'rgba(52, 199, 89, 0.5)',
        shadowColor: THEME.colors.accent,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 20,
        elevation: 12,
    },
    avatarLetter: {
        fontSize: 32,
        fontWeight: '700',
        color: '#FFFFFF',
        letterSpacing: 0.5,
    },

    // Call hint
    callHint: {
        ...THEME.typography.caption1,
        color: THEME.colors.textSecondary,
        marginTop: 4,
        marginBottom: 4,
    },

    // Name input
    nameInput: {
        ...THEME.typography.title1,
        color: THEME.colors.textPrimary,
        width: '100%',
        paddingVertical: 16,
        paddingHorizontal: THEME.spacing.md,
    },

    // Language pills
    pillsRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 12,
        marginTop: 4,
    },
    pill: {
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        borderWidth: 2,
        borderColor: 'rgba(255, 255, 255, 0.06)',
    },
    pillFlag: {
        fontSize: 22,
    },
});
