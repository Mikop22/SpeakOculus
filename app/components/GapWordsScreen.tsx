import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    Platform,
    Dimensions,
} from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    withSpring,
    Easing,
} from 'react-native-reanimated';
import { ChevronLeft, BookOpen, Trash2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { THEME } from '../theme';
import { AgentConfig } from './CallHistoryScreen';
import { GapWord, getGapWordsForAgent, removeGapWord } from '../storage';

const SCREEN_WIDTH = Dimensions.get('window').width;

function getInitials(name: string): string {
    return name
        .split(' ')
        .map(word => word.charAt(0).toUpperCase())
        .slice(0, 2)
        .join('');
}

function getAvatarColor(language: string): string {
    const colors: Record<string, string> = {
        spanish: '#FF6B6B',
        french: '#4ECDC4',
        german: '#FFE66D',
        italian: '#95E1D3',
        portuguese: '#FF9F43',
        japanese: '#EE6B9E',
        chinese: '#C44569',
        korean: '#6C5CE7',
        russian: '#00B894',
        arabic: '#FDCB6E',
    };
    return colors[language.toLowerCase()] || '#9DA0A5';
}

function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

interface GapWordsScreenProps {
    agent: AgentConfig;
    onBack: () => void;
}

export const GapWordsScreen: React.FC<GapWordsScreenProps> = ({
    agent,
    onBack,
}) => {
    const insets = useSafeAreaInsets();
    const [gapWords, setGapWords] = useState<GapWord[]>([]);
    const [loading, setLoading] = useState(true);

    const slide = useSharedValue(1);

    useEffect(() => {
        slide.value = withSpring(0, {
            damping: 22,
            stiffness: 250,
            mass: 0.8,
        });
    }, []);

    const slideStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: slide.value * SCREEN_WIDTH }],
    }));

    useEffect(() => {
        const loadWords = async () => {
            const words = await getGapWordsForAgent(agent.name);
            words.sort((a, b) => b.timestamp - a.timestamp);
            setGapWords(words);
            setLoading(false);
        };
        loadWords();
    }, [agent.name]);

    const handleBack = useCallback(() => {
        slide.value = withTiming(1, {
            duration: 250,
            easing: Easing.in(Easing.cubic),
        });
        setTimeout(onBack, 250);
    }, [onBack]);

    const handleDeleteWord = useCallback(async (word: GapWord) => {
        await removeGapWord(agent.name, word.native_word);
        setGapWords(prev => prev.filter(w => w.timestamp !== word.timestamp));
    }, [agent.name]);

    return (
        <Animated.View style={[styles.container, slideStyle]}>
            {Platform.OS !== 'android' ? (
                <BlurView intensity={THEME.blur.intensity} tint={THEME.blur.tint} style={StyleSheet.absoluteFill} />
            ) : (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: THEME.colors.surface }]} />
            )}

            <ScrollView
                contentContainerStyle={[
                    styles.contentContainer,
                    { paddingTop: insets.top, paddingBottom: insets.bottom + 20 }
                ]}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.header}>
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={handleBack}
                        activeOpacity={0.7}
                    >
                        <ChevronLeft size={28} color={THEME.colors.accent} />
                        <Text style={styles.backText}>Back</Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.agentCard}>
                    <View style={[styles.avatar, { backgroundColor: getAvatarColor(agent.language) }]}>
                        <Text style={styles.avatarText}>{getInitials(agent.name)}</Text>
                    </View>
                    <Text style={styles.agentName}>{agent.name}</Text>
                    <Text style={styles.agentLanguage}>{agent.language} Tutor</Text>
                </View>

                <Text style={styles.sectionTitle}>Missed Words</Text>

                {loading && (
                    <View style={styles.emptyState}>
                        <Text style={styles.emptyStateText}>Loading...</Text>
                    </View>
                )}

                {!loading && gapWords.length === 0 && (
                    <View style={styles.emptyState}>
                        <BookOpen size={48} color={THEME.colors.textSecondary} style={{ marginBottom: 16 }} />
                        <Text style={styles.emptyStateTitle}>No Missed Words Yet</Text>
                        <Text style={styles.emptyStateText}>
                            Words you miss during conversations with {agent.name} will appear here.
                        </Text>
                    </View>
                )}

                {!loading && gapWords.length > 0 && (
                    <View style={styles.wordList}>
                        {gapWords.map((word, index) => (
                            <View key={`${word.native_word}-${word.timestamp}`}>
                                <View style={styles.wordItem}>
                                    <View style={styles.wordContent}>
                                        <Text style={styles.targetWord}>{word.target_word}</Text>
                                        <Text style={styles.nativeWord}>{word.native_word}</Text>
                                    </View>
                                    <View style={styles.wordActions}>
                                        <Text style={styles.wordTimestamp}>{formatDate(word.timestamp)}</Text>
                                        <TouchableOpacity
                                            onPress={() => handleDeleteWord(word)}
                                            style={styles.deleteButton}
                                            activeOpacity={0.6}
                                        >
                                            <Trash2 size={18} color="#FF453A" />
                                        </TouchableOpacity>
                                    </View>
                                </View>
                                {index < gapWords.length - 1 && <View style={styles.separator} />}
                            </View>
                        ))}
                    </View>
                )}
            </ScrollView>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 25,
        backgroundColor: '#000000',
    },
    contentContainer: {
        paddingHorizontal: THEME.spacing.md,
    },
    header: {
        height: 44,
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 20,
    },
    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: -8,
    },
    backText: {
        ...THEME.typography.body,
        color: THEME.colors.accent,
    },
    agentCard: {
        alignItems: 'center',
        marginBottom: 32,
    },
    avatar: {
        width: 80,
        height: 80,
        borderRadius: 40,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 12,
    },
    avatarText: {
        ...THEME.typography.largeTitle,
        color: '#FFF',
        fontSize: 28,
    },
    agentName: {
        ...THEME.typography.title2,
        color: THEME.colors.textPrimary,
        marginBottom: 4,
    },
    agentLanguage: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
    },
    sectionTitle: {
        ...THEME.typography.title3,
        color: THEME.colors.textPrimary,
        marginBottom: 16,
    },
    wordList: {
        backgroundColor: THEME.colors.surfaceHighlight,
        borderRadius: THEME.borderRadius.md,
        overflow: 'hidden',
    },
    wordItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
    },
    wordContent: {
        flex: 1,
    },
    targetWord: {
        ...THEME.typography.headline,
        color: THEME.colors.textPrimary,
        marginBottom: 2,
    },
    nativeWord: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
    },
    wordActions: {
        alignItems: 'flex-end',
        gap: 8,
    },
    wordTimestamp: {
        ...THEME.typography.caption1,
        color: THEME.colors.textSecondary,
    },
    deleteButton: {
        padding: 4,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: '#38383A',
        marginLeft: 16,
    },
    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 60,
        paddingHorizontal: 40,
    },
    emptyStateTitle: {
        ...THEME.typography.title3,
        color: THEME.colors.textPrimary,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyStateText: {
        ...THEME.typography.body,
        color: THEME.colors.textSecondary,
        textAlign: 'center',
    },
});
