/**
 * Storage utilities for persisting app data via AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AgentConfig, CallHistoryItem } from '../components/CallHistoryScreen';

export interface GapWord {
  native_word: string;
  target_word: string;
  timestamp: number;
}

export interface StoredCallHistoryItem {
  id: string;
  agentConfig: AgentConfig;
  timestamp: string;
  duration?: number;
}

const KEYS = {
  AGENTS: '@speakoculus/agents',
  CALL_HISTORY: '@speakoculus/callHistory',
  GAP_WORDS: '@speakoculus/gapWords',
} as const;

export async function loadAgents(): Promise<AgentConfig[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.AGENTS);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('[STORAGE] Failed to load agents:', error);
    return [];
  }
}

export async function saveAgents(agents: AgentConfig[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.AGENTS, JSON.stringify(agents));
  } catch (error) {
    console.error('[STORAGE] Failed to save agents:', error);
  }
}

export async function addAgent(agent: AgentConfig): Promise<void> {
  const agents = await loadAgents();
  const exists = agents.some(a => a.name === agent.name);
  if (!exists) {
    agents.push(agent);
    await saveAgents(agents);
  }
}

export async function loadCallHistory(): Promise<CallHistoryItem[]> {
  try {
    const data = await AsyncStorage.getItem(KEYS.CALL_HISTORY);
    if (!data) return [];

    const stored: StoredCallHistoryItem[] = JSON.parse(data);
    return stored.map(item => ({
      ...item,
      timestamp: new Date(item.timestamp),
    }));
  } catch (error) {
    console.error('[STORAGE] Failed to load call history:', error);
    return [];
  }
}

export async function saveCallHistory(history: CallHistoryItem[]): Promise<void> {
  try {
    const stored: StoredCallHistoryItem[] = history.map(item => ({
      ...item,
      timestamp: item.timestamp.toISOString(),
    }));
    await AsyncStorage.setItem(KEYS.CALL_HISTORY, JSON.stringify(stored));
  } catch (error) {
    console.error('[STORAGE] Failed to save call history:', error);
  }
}

export async function addCallHistoryItem(item: CallHistoryItem): Promise<void> {
  const history = await loadCallHistory();
  history.unshift(item);
  await saveCallHistory(history);
}

export async function loadAllGapWords(): Promise<Record<string, GapWord[]>> {
  try {
    const data = await AsyncStorage.getItem(KEYS.GAP_WORDS);
    return data ? JSON.parse(data) : {};
  } catch (error) {
    console.error('[STORAGE] Failed to load gap words:', error);
    return {};
  }
}

export async function saveAllGapWords(gapWords: Record<string, GapWord[]>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEYS.GAP_WORDS, JSON.stringify(gapWords));
  } catch (error) {
    console.error('[STORAGE] Failed to save gap words:', error);
  }
}

export async function addGapWord(agentName: string, word: GapWord): Promise<void> {
  const allWords = await loadAllGapWords();
  (allWords[agentName] ??= []).push(word);
  await saveAllGapWords(allWords);
}

export async function getGapWordsForAgent(agentName: string): Promise<GapWord[]> {
  const allWords = await loadAllGapWords();
  return allWords[agentName] ?? [];
}

export async function removeGapWord(agentName: string, nativeWord: string): Promise<void> {
  const allWords = await loadAllGapWords();
  if (!allWords[agentName]) return;
  allWords[agentName] = allWords[agentName].filter(
    w => w.native_word.toLowerCase() !== nativeWord.toLowerCase()
  );
  await saveAllGapWords(allWords);
}

export async function clearAllStorage(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([KEYS.AGENTS, KEYS.CALL_HISTORY, KEYS.GAP_WORDS]);
    console.log('[STORAGE] All data cleared');
  } catch (error) {
    console.error('[STORAGE] Failed to clear storage:', error);
  }
}
