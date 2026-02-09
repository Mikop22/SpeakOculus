import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { THEME } from '../theme';
import { GapWord } from '../storage';

interface VocabularyPopupProps {
    words: GapWord[];
    isVisible: boolean;
    onClose: () => void;
}

export const VocabularyPopup: React.FC<VocabularyPopupProps> = ({
    words,
    isVisible,
    onClose,
}) => {
    if (!isVisible) return null;

    return (
        <Animated.View
            entering={FadeIn.duration(150)}
            exiting={FadeOut.duration(100)}
            style={styles.container}
        >
            {/* Tap-outside backdrop */}
            <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={onClose}
            />

            {/* Card */}
            <View style={styles.card}>
                <BlurView
                    intensity={90}
                    tint="dark"
                    style={styles.cardBlur}
                >
                    <Text style={styles.title}>Missed Words</Text>

                    {words.length === 0 ? (
                        <Text style={styles.emptyText}>
                            None yet — keep talking!
                        </Text>
                    ) : (
                        <ScrollView
                            style={styles.list}
                            showsVerticalScrollIndicator={false}
                            bounces={words.length > 5}
                        >
                            {words.map((word, i) => (
                                <View
                                    key={`${word.native_word}-${word.timestamp}`}
                                    style={[
                                        styles.row,
                                        i < words.length - 1 && styles.rowBorder,
                                    ]}
                                >
                                    <Text style={styles.targetWord}>{word.target_word}</Text>
                                    <Text style={styles.arrow}>→</Text>
                                    <Text style={styles.nativeWord}>{word.native_word}</Text>
                                </View>
                            ))}
                        </ScrollView>
                    )}
                </BlurView>
            </View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
        paddingBottom: 200,
        paddingHorizontal: 24,
        zIndex: 50,
    },
    card: {
        borderRadius: 20,
        overflow: 'hidden',
        maxHeight: 280,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius: 24,
        elevation: 20,
    },
    cardBlur: {
        backgroundColor: 'rgba(30, 30, 30, 0.92)',
        padding: 16,
        overflow: 'hidden',
    },
    title: {
        ...THEME.typography.headline,
        color: THEME.colors.textPrimary,
        marginBottom: 12,
    },
    emptyText: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textTertiary,
        textAlign: 'center',
        paddingVertical: 20,
    },
    list: {
        flexGrow: 0,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        gap: 8,
    },
    rowBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(255, 255, 255, 0.08)',
    },
    targetWord: {
        ...THEME.typography.body,
        color: THEME.colors.accent,
        fontWeight: '600',
        flex: 1,
    },
    arrow: {
        ...THEME.typography.body,
        color: THEME.colors.textTertiary,
    },
    nativeWord: {
        ...THEME.typography.body,
        color: THEME.colors.textSecondary,
        flex: 1,
        textAlign: 'right',
    },
});
