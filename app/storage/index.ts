/**
 * Storage utilities for persisting app data via AsyncStorage
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AgentConfig, CallHistoryItem } from '../components/CallHistoryScreen';

// ============================================================================
// TYPES
// ============================================================================
export interface GapWord {
    native_word: string;   // English word
    target_word: string;   // Translation in target language
    timestamp: number;     // Unix ms
}

export interface StoredCallHistoryItem {
    id: string;
    agentConfig: AgentConfig;
    timestamp: string; // ISO string for serialization
    duration?: number;
}

// ============================================================================
// STORAGE KEYS
// ============================================================================
const KEYS = {
    AGENTS: '@speakoculus/agents',
    CALL_HISTORY: '@speakoculus/callHistory',
    GAP_WORDS: '@speakoculus/gapWords',
} as const;

// ============================================================================
// AGENTS
// ============================================================================
export const loadAgents = async (): Promise<AgentConfig[]> => {
    try {
        const data = await AsyncStorage.getItem(KEYS.AGENTS);
        return data ? JSON.parse(data) : [];
    } catch (error) {
        console.error('[STORAGE] Failed to load agents:', error);
        return [];
    }
};

export const saveAgents = async (agents: AgentConfig[]): Promise<void> => {
    try {
        await AsyncStorage.setItem(KEYS.AGENTS, JSON.stringify(agents));
    } catch (error) {
        console.error('[STORAGE] Failed to save agents:', error);
    }
};

export const addAgent = async (agent: AgentConfig): Promise<void> => {
    const agents = await loadAgents();
    // Check for duplicates by name
    const exists = agents.some(a => a.name === agent.name);
    if (!exists) {
        agents.push(agent);
        await saveAgents(agents);
    }
};

// ============================================================================
// CALL HISTORY
// ============================================================================
export const loadCallHistory = async (): Promise<CallHistoryItem[]> => {
    try {
        const data = await AsyncStorage.getItem(KEYS.CALL_HISTORY);
        if (!data) return [];

        const stored: StoredCallHistoryItem[] = JSON.parse(data);
        // Convert ISO strings back to Date objects
        return stored.map(item => ({
            ...item,
            timestamp: new Date(item.timestamp),
        }));
    } catch (error) {
        console.error('[STORAGE] Failed to load call history:', error);
        return [];
    }
};

export const saveCallHistory = async (history: CallHistoryItem[]): Promise<void> => {
    try {
        // Convert Date objects to ISO strings for serialization
        const stored: StoredCallHistoryItem[] = history.map(item => ({
            ...item,
            timestamp: item.timestamp.toISOString(),
        }));
        await AsyncStorage.setItem(KEYS.CALL_HISTORY, JSON.stringify(stored));
    } catch (error) {
        console.error('[STORAGE] Failed to save call history:', error);
    }
};

export const addCallHistoryItem = async (item: CallHistoryItem): Promise<void> => {
    const history = await loadCallHistory();
    history.unshift(item); // Add to beginning (most recent first)
    await saveCallHistory(history);
};

// ============================================================================
// GAP WORDS
// ============================================================================
export const loadAllGapWords = async (): Promise<Record<string, GapWord[]>> => {
    try {
        const data = await AsyncStorage.getItem(KEYS.GAP_WORDS);
        return data ? JSON.parse(data) : {};
    } catch (error) {
        console.error('[STORAGE] Failed to load gap words:', error);
        return {};
    }
};

export const saveAllGapWords = async (gapWords: Record<string, GapWord[]>): Promise<void> => {
    try {
        await AsyncStorage.setItem(KEYS.GAP_WORDS, JSON.stringify(gapWords));
    } catch (error) {
        console.error('[STORAGE] Failed to save gap words:', error);
    }
};

export const addGapWord = async (agentName: string, word: GapWord): Promise<void> => {
    const allWords = await loadAllGapWords();
    if (!allWords[agentName]) {
        allWords[agentName] = [];
    }
    allWords[agentName].push(word);
    await saveAllGapWords(allWords);
};

export const getGapWordsForAgent = async (agentName: string): Promise<GapWord[]> => {
    const allWords = await loadAllGapWords();
    return allWords[agentName] || [];
};

export const removeGapWord = async (agentName: string, nativeWord: string): Promise<void> => {
    const allWords = await loadAllGapWords();
    if (!allWords[agentName]) return;
    allWords[agentName] = allWords[agentName].filter(
        w => w.native_word.toLowerCase() !== nativeWord.toLowerCase()
    );
    await saveAllGapWords(allWords);
};

// ============================================================================
// CLEAR ALL (for debugging)
// ============================================================================
export const clearAllStorage = async (): Promise<void> => {
    try {
        await AsyncStorage.multiRemove([KEYS.AGENTS, KEYS.CALL_HISTORY, KEYS.GAP_WORDS]);
        console.log('[STORAGE] All data cleared');
    } catch (error) {
        console.error('[STORAGE] Failed to clear storage:', error);
    }
};
