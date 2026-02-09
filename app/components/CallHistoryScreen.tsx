import React, { useState, useCallback, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    interpolate,
} from 'react-native-reanimated';
import { Link, Video, Info, MinusCircle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { THEME } from '../theme';
import { NewAgentSheet } from './NewAgentSheet';

// ============================================================================
// TYPES
// ============================================================================
export interface AgentConfig {
    name: string;
    language: string;
    systemPrompt: string;
}

export interface CallHistoryItem {
    id: string;
    agentConfig: AgentConfig;
    timestamp: Date;
    duration?: number; // in seconds
}

interface CallHistoryScreenProps {
    onConnect: (config: AgentConfig) => void;
    onViewGapWords: (agent: AgentConfig) => void;
    onDeleteItem: (itemId: string) => void;
    history?: CallHistoryItem[];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
const formatTime = (date: Date): string => {
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
    });
};

const formatDuration = (seconds?: number): string => {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const getInitials = (name: string): string => {
    return name
        .split(' ')
        .map(word => word.charAt(0).toUpperCase())
        .slice(0, 2)
        .join('');
};

const groupHistoryByDate = (history: CallHistoryItem[]): Map<string, CallHistoryItem[]> => {
    const grouped = new Map<string, CallHistoryItem[]>();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    history.forEach(item => {
        const itemDate = new Date(item.timestamp);
        itemDate.setHours(0, 0, 0, 0);

        let key: string;
        if (itemDate.getTime() === today.getTime()) {
            key = 'TODAY';
        } else if (itemDate.getTime() === yesterday.getTime()) {
            key = 'YESTERDAY';
        } else {
            key = itemDate.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
            }).toUpperCase();
        }

        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key)!.push(item);
    });

    return grouped;
};

// ============================================================================
// GENERATE SYSTEM PROMPT
// ============================================================================
export const generateSystemPrompt = (name: string, language: string): string => {
    return `You are ${name}, a helpful ${language} tutor. Speak in ${language} and correct my mistakes gently. Be encouraging, patient, and adapt to my skill level. Start conversations naturally and help me practice real-world scenarios.`;
};

// ============================================================================
// CALL ROW COMPONENT
// ============================================================================
interface CallRowProps {
    item: CallHistoryItem;
    isEditMode: boolean;
    onRedial: (item: CallHistoryItem) => void;
    onDelete: (id: string) => void;
    onViewGapWords: (agent: AgentConfig) => void;
    isLast: boolean;
}

const CallRow: React.FC<CallRowProps> = ({
    item,
    isEditMode,
    onRedial,
    onDelete,
    onViewGapWords,
    isLast,
}) => {
    const avatarColor = getAvatarColor(item.agentConfig.language);
    const editProgress = useSharedValue(isEditMode ? 1 : 0);

    useEffect(() => {
        editProgress.value = withTiming(isEditMode ? 1 : 0, { duration: 250 });
    }, [isEditMode]);

    const deleteStyle = useAnimatedStyle(() => ({
        width: interpolate(editProgress.value, [0, 1], [0, 30]),
        marginRight: interpolate(editProgress.value, [0, 1], [0, 8]),
        opacity: editProgress.value,
        overflow: 'hidden' as const,
    }));

    const handleDelete = () => {
        onDelete(item.id);
    };

    return (
        <View>
            <TouchableOpacity
                style={styles.callItem}
                onPress={() => !isEditMode && onRedial(item)}
                activeOpacity={0.7}
            >
                {/* Delete button - always mounted, animated in/out */}
                <Animated.View style={deleteStyle} pointerEvents={isEditMode ? 'auto' : 'none'}>
                    <TouchableOpacity
                        onPress={handleDelete}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                        <MinusCircle size={22} color="#FFF" fill={THEME.colors.destructive} />
                    </TouchableOpacity>
                </Animated.View>

                {/* Avatar */}
                <View style={styles.avatarContainer}>
                    <View style={[styles.avatarPlaceholder, { backgroundColor: avatarColor }]}>
                        <Text style={styles.avatarInitials}>
                            {getInitials(item.agentConfig.name)}
                        </Text>
                    </View>
                </View>

                {/* Details */}
                <View style={styles.callDetails}>
                    <Text style={styles.callerName}>{item.agentConfig.name}</Text>
                    <View style={styles.callTypeContainer}>
                        <Video size={12} color={THEME.colors.textSecondary} style={{ marginRight: 4 }} />
                        <Text style={styles.callSubtitle}>
                            {item.agentConfig.language} Tutor
                        </Text>
                    </View>
                </View>

                {/* Meta */}
                <View style={styles.callMeta}>
                    <Text style={styles.timeText}>{formatTime(item.timestamp)}</Text>
                    <TouchableOpacity
                        style={styles.infoButton}
                        onPress={() => {
                            onViewGapWords(item.agentConfig);
                        }}
                        activeOpacity={0.7}
                    >
                        <Info size={18} color={THEME.colors.textSecondary} />
                    </TouchableOpacity>
                </View>
            </TouchableOpacity>

            {/* Thin separator line (skip last item) */}
            {!isLast && <View style={styles.separator} />}
        </View>
    );
};

// ============================================================================
// COMPONENT
// ============================================================================
export const CallHistoryScreen: React.FC<CallHistoryScreenProps> = ({
    onConnect,
    onViewGapWords,
    onDeleteItem,
    history = [],
}) => {
    const insets = useSafeAreaInsets();
    const [isNewAgentSheetVisible, setIsNewAgentSheetVisible] = useState(false);
    const [isEditMode, setIsEditMode] = useState(false);

    // Handle creating a new agent and starting a session
    const handleStartSession = useCallback((config: { name: string; language: string }) => {
        const agentConfig: AgentConfig = {
            name: config.name,
            language: config.language,
            systemPrompt: generateSystemPrompt(config.name, config.language),
        };

        setIsNewAgentSheetVisible(false);
        onConnect(agentConfig);
    }, [onConnect]);

    // Handle redialing a previous agent
    const handleRedial = useCallback((item: CallHistoryItem) => {
        onConnect(item.agentConfig);
    }, [onConnect]);

    // Handle viewing gap words for an agent
    const handleViewGapWords = useCallback((agent: AgentConfig) => {
        onViewGapWords(agent);
    }, [onViewGapWords]);

    // Open new agent sheet
    const handleNewAgentPress = useCallback(() => {
        setIsNewAgentSheetVisible(true);
    }, []);

    // Toggle edit mode
    const handleToggleEditMode = useCallback(() => {
        setIsEditMode(prev => !prev);
    }, []);

    // Delete a call history item
    const handleDelete = useCallback((itemId: string) => {
        onDeleteItem(itemId);
    }, [onDeleteItem]);

    // Group history items by date
    const groupedHistory = groupHistoryByDate(history);

    return (
        <View style={styles.container}>
            {/* Blurred camera background (like FaceTime) */}
            {Platform.OS !== 'android' ? (
                <BlurView intensity={20} tint="dark" style={StyleSheet.absoluteFill} />
            ) : (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0, 0, 0, 0.85)' }]} />
            )}

            <ScrollView
                contentContainerStyle={[
                    styles.contentContainer,
                    { paddingTop: insets.top, paddingBottom: insets.bottom + 20 }
                ]}
                showsVerticalScrollIndicator={false}
            >
                {/* Header */}
                <View style={styles.header}>
                    <TouchableOpacity onPress={handleToggleEditMode} activeOpacity={0.7}>
                        <Text style={[styles.editText, isEditMode && styles.editTextActive]}>
                            {isEditMode ? 'Done' : 'Edit'}
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* Title */}
                <Text style={styles.pageTitle}>FaceTime</Text>

                {/* Action Buttons */}
                <View style={styles.actionButtonsContainer}>
                    <TouchableOpacity style={styles.actionButtonLeft} activeOpacity={0.7}>
                        <Link color="#FFF" size={24} style={{ marginBottom: 8 }} />
                        <Text style={styles.actionButtonText}>Create Link</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.actionButtonRight}
                        onPress={handleNewAgentPress}
                        activeOpacity={0.7}
                    >
                        <Video color="#FFF" size={24} fill="#FFF" style={{ marginBottom: 8 }} />
                        <Text style={styles.actionButtonText}>New Agent</Text>
                    </TouchableOpacity>
                </View>

                {/* Call History List */}
                {Array.from(groupedHistory.entries()).map(([dateKey, items]) => (
                    <View key={dateKey}>
                        {/* Section Header */}
                        <View style={styles.sectionHeaderContainer}>
                            <Text style={styles.sectionHeader}>{dateKey}</Text>
                        </View>

                        {/* History Items */}
                        {items.map((item, index) => (
                            <CallRow
                                key={item.id}
                                item={item}
                                isEditMode={isEditMode}
                                onRedial={handleRedial}
                                onDelete={handleDelete}
                                onViewGapWords={handleViewGapWords}
                                isLast={index === items.length - 1}
                            />
                        ))}

                        {/* Bottom separator after group */}
                        <View style={styles.groupSeparator} />
                    </View>
                ))}

                {/* Empty State */}
                {history.length === 0 && (
                    <View style={styles.emptyState}>
                        <Video size={48} color={THEME.colors.textSecondary} style={{ marginBottom: 16 }} />
                        <Text style={styles.emptyStateTitle}>No Recent Sessions</Text>
                        <Text style={styles.emptyStateSubtitle}>
                            Tap "New Agent" to create your first language tutor
                        </Text>
                    </View>
                )}
            </ScrollView>

            {/* New Agent Sheet */}
            <NewAgentSheet
                isVisible={isNewAgentSheetVisible}
                onClose={() => setIsNewAgentSheetVisible(false)}
                onStartSession={handleStartSession}
            />
        </View>
    );
};

// ============================================================================
// AVATAR COLOR HELPER
// ============================================================================
const getAvatarColor = (language: string): string => {
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
};

// ============================================================================
// STYLES
// ============================================================================
const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        zIndex: 20,
    },
    contentContainer: {
        paddingHorizontal: THEME.spacing.md,
    },
    header: {
        marginBottom: 10,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        height: 44,
    },
    editText: {
        ...THEME.typography.body,
        color: THEME.colors.accent,
    },
    editTextActive: {
        fontWeight: '600',
    },
    pageTitle: {
        ...THEME.typography.largeTitle,
        fontSize: 32,
        color: THEME.colors.textPrimary,
        marginBottom: 20,
    },
    actionButtonsContainer: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 30,
    },
    actionButtonLeft: {
        flex: 1,
        backgroundColor: THEME.colors.surfaceHighlight,
        borderRadius: THEME.borderRadius.md,
        padding: 16,
        height: 80,
        justifyContent: 'center',
    },
    actionButtonRight: {
        flex: 1,
        backgroundColor: THEME.colors.accent,
        borderRadius: THEME.borderRadius.md,
        padding: 16,
        height: 80,
        justifyContent: 'center',
    },
    actionButtonText: {
        ...THEME.typography.subheadline,
        fontWeight: '600',
        color: '#FFF',
    },
    sectionHeaderContainer: {
        marginBottom: 10,
        marginLeft: 4,
    },
    sectionHeader: {
        ...THEME.typography.footnote,
        fontWeight: '600',
        color: THEME.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    callItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 4,
    },
    avatarContainer: {
        marginRight: 12,
    },
    avatarPlaceholder: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: '#9DA0A5',
        alignItems: 'center',
        justifyContent: 'center',
    },
    avatarInitials: {
        ...THEME.typography.headline,
        color: '#FFF',
    },
    callDetails: {
        flex: 1,
    },
    callerName: {
        ...THEME.typography.headline,
        color: THEME.colors.textPrimary,
        marginBottom: 2,
    },
    callSubtitle: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
    },
    callTypeContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    callMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    timeText: {
        ...THEME.typography.subheadline,
        color: THEME.colors.textSecondary,
    },
    infoButton: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        marginLeft: 64,
    },
    groupSeparator: {
        height: 20,
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
    emptyStateSubtitle: {
        ...THEME.typography.body,
        color: THEME.colors.textSecondary,
        textAlign: 'center',
    },
});
