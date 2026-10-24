/**
 * Translation Module
 * Handles translation functionality for input and output panes
 */

import { translateStructured, sendChatMessage, streamSendChatMessage, streamTranslateStructured, parseTag } from './openrouter';
import { getPreference, savePreference, listSessions, saveSession, loadSession, deleteSession as storageDeleteSession, getOrCreateDefaultSession, saveSessionTranslation, listSessionTranslationTimestamps, loadSessionTranslationsByTimestamp, deleteSessionTranslation, loadSessionTranslation } from './storage';
import { DEBUG_TRANSLATIONS, DEBUG_SESSIONS } from './debug';
import * as ui from './ui';
import { LANGUAGES } from './languages';
import {
    INPUT_SYSTEM_PROMPT,
    OUTPUT_SYSTEM_PROMPT,
    INPUT_INSTRUCTIONS,
    OUTPUT_INSTRUCTIONS,
    LITERAL_RETRANSLATION_PROMPT,
    OUTPUT_LITERAL_RETRANSLATION_PROMPT,
    QUESTION_SYSTEM_PROMPT,
    WORD_DEFINITIONS_PROMPT,
    INTERPRETATION_PROMPT,
    INTERPRETATION_FOLLOWUP_PROMPT,
    QUICK_QUESTION_DRAFT_PROMPT,
    QUICK_QUESTION_MESSAGE_PROMPT,
    QUICK_QUESTION_TRANSLATION_PROMPT,
    QUICK_QUESTION_NOTE_PROMPT,
    TIMESTAMP_NOTE
} from './prompts';
import { renderMarkdown, normalizeForMarkdown } from './markdown';
import { readLocalFile, writeLocalFile, deleteLocalFile, getDeviceId } from './opfs';
import type { Translation, TranslationEntry, TranslationWordItem, WordItem, PunctItem, NewlineItem } from './types/translation';
import type { StreamingAbortHandle, StreamCallbacks, StreamUsage } from './types/api';
import type { Config } from './types/config';
import type { TranslationTag } from './types/translationTag';
import type { TranslationSession, ReasoningLevel } from './types/session';
import { formatTimestamp, formatTimestampWithOffset, extractStructuredResult, stripTranslationTags, parseWordDefinitions, ensureEntries, stripIfNeeded } from './core/translation';
import { getDayStart, groupTimestampsByDay, selectTimestampsInDays } from './historyWindow';
import { scheduleStreamRender, cancelStreamRender } from './streamRender';
import { Modal } from 'bootstrap';

/**
 * Generates a UUID for translation IDs
 * @returns {string} UUID v4 string
 */
function generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Application configuration (injected from main.ts)
 */
let config: Config | null = null;

/**
 * Current session ID
 * @type {string}
 */
let currentSessionId: string = 'default';

/**
 * Current session's literal model ID
 * @type {string | null}
 */
let currentLiteralModel: string | null = null;
/**
 * Currently active interpretation model from the active session
 * @type {string | null}
 */
let currentInterpretationModel: string | null = null;

/** Debounce delay for auto-saving drafts (ms) */
const DRAFT_SAVE_DEBOUNCE_MS = 2000;

/** Prevents multiple quick question modals from stacking */
let quickQuestionModalOpen = false;

/** Prevents multiple context-note modals from stacking */
let contextNoteModalOpen = false;

/** Caches the first draft quick question text across modal dismissals */
let cachedDraftQuickQuestion: string | null = null;

/** Caches the first question asked about a translation across modal dismissals */
let cachedTranslationQuickQuestion: string | null = null;

/** Timeout handle for draft auto-save debounce */
let draftSaveTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * In-memory translation array - source of truth for translations
 * @type {Translation[]}
 */
let allTranslations: Translation[] = [];

/**
 * Number of active days loaded into the UI at a time.
 * Must be at least as large as the largest context window (HISTORY_CONTEXT_DAYS)
 * so that the context builders always see their whole window in allTranslations.
 * Note that context-only days count towards the page but not towards the context
 * window, so a page can contain fewer than HISTORY_CONTEXT_DAYS content days.
 * Accepted because note-only days are rare in practice.
 */
const HISTORY_DAYS_PER_PAGE = 20;

/** Extra viewport margin (px) that triggers loading the next page of history */
const HISTORY_SCROLL_MARGIN = 200;

/** All translation timestamps in the current session, newest first */
let sessionTranslationTimestamps: number[] = [];

/** Distinct active days (local midnight) in the current session, newest first */
let sessionActiveDays: number[] = [];

/** Day starts whose translations are currently loaded and rendered */
let loadedHistoryDays = new Set<number>();

/** Guards against overlapping "load older history" calls */
let isLoadingOlderHistory = false;

/** Observer that loads older history when the sentinel scrolls into view */
let historyScrollObserver: IntersectionObserver | null = null;

/**
 * Maps of model IDs to names for display
 * @type {Map<string, string>}
 */
let modelNameMap: Map<string, string> = new Map();

/**
 * Temporary model override (not persisted)
 * @type {string | null}
 */
let modelOverride: string | null = null;
let reasoningOverride: ReasoningLevel | null = null;

/**
 * Captured DOM element references for a translation item.
 * All references are queried once during element creation and reused.
 * Never re-query the DOM for these elements after initial capture.
 */
interface TranslationDomRefs {
    element: HTMLElement;
    sourceEl: HTMLElement | null;
    targetEl: HTMLElement | null;
    thinkingEl: HTMLElement | null;
    thinkingContentEl: HTMLElement | null;
    literalEl: HTMLElement | null;
    explanationEl: HTMLElement | null;
    nuancesEl: HTMLElement | null;
    interpretationEl: HTMLElement | null;
    interpretationMarkdownEl: HTMLElement | null;
    interpretationRawEl: HTMLElement | null;
    interpretationThinkingEl: HTMLElement | null;
    interpretationThinkingContentEl: HTMLElement | null;
    interpretationFollowupEl: HTMLElement | null;
    interpretationFollowupHistoryEl: HTMLElement | null;
    interpretationFollowupThinkingEl: HTMLElement | null;
    interpretationFollowupThinkingContentEl: HTMLElement | null;
    interpretationFollowupInputEl: HTMLTextAreaElement | null;
    interpretationFollowupAskBtn: HTMLButtonElement | null;
    spinnerEl: HTMLElement | null;
    errorEl: HTMLElement | null;
    errorMessageEl: HTMLElement | null;
    promptEl: HTMLElement | null;
    modelNameEl: HTMLElement | null;
    charCountEl: HTMLElement | null;
    sectionsArea: HTMLElement | null;
    toggleSectionsBtn: HTMLButtonElement | null;
    toggleAnswerBtn: HTMLButtonElement | null;
    retryBtn: HTMLButtonElement | null;
    regenerateTranslationBtn: HTMLButtonElement | null;
    regenerateLiteralBtn: HTMLButtonElement | null;
    regenerateInterpretationBtn: HTMLButtonElement | null;
    regenerateAnswerBtn: HTMLButtonElement | null;
    stopGenerationBtn: HTMLButtonElement | null;
    copySourceBtn: HTMLButtonElement | null;
    copyTargetBtn: HTMLButtonElement | null;
    copyAnswerBtn: HTMLButtonElement | null;
    saveAnswerBtn: HTMLButtonElement | null;
    retranslationTabsEl: HTMLElement | null;
    wordsTab: HTMLElement | null;
    wordsContent: HTMLElement | null;
    editArea: HTMLElement | null;
    editSource: HTMLTextAreaElement | null;
    editIntent: HTMLTextAreaElement | null;
    retranslateBtn: HTMLButtonElement | null;
    addContextBtn: HTMLButtonElement | null;
    editToggleBtn: HTMLButtonElement | null;
    quickQuestionBtn: HTMLButtonElement | null;
    includeInContextToggle: HTMLInputElement | null;
}

/**
 * Map from Translation objects to their captured DOM references.
 * @type {WeakMap<Translation, TranslationDomRefs>}
 */
const domRefsMap: WeakMap<Translation, TranslationDomRefs> = new WeakMap();

/**
 * Ephemeral streaming state for an in-progress streaming generation.
 * Not persisted — only exists while the stream is active.
 */
interface StreamingState {
    abort: () => void;
    accumulatedText: string;
    accumulatedReasoning: string;
    lastRenderedBreakIndex: number;
    translationComplete: boolean;
    sectionsComplete: boolean;
    milestoneSaved: number;
    backgroundTasksTriggered: boolean;
}

/**
 * Map from streaming Translation objects to their ephemeral streaming state.
 * @type {WeakMap<Translation, StreamingState>}
 */
const streamingStateMap: WeakMap<Translation, StreamingState> = new WeakMap();

/**
 * Extracts only the TRANSLATION portion of text for display during streaming.
 * Once </translation> is seen, the translation is complete and non-translation
 * content (explanation, nuances) should not be shown in the target area.
 * @param {string} text - Raw accumulated streaming text
 * @returns {{ displayText: string; isComplete: boolean }}
 */
function extractTranslationForDisplay(text: string): { displayText: string; isComplete: boolean } {
    const openIdx = text.indexOf('<translation>');
    const closeIdx = text.indexOf('</translation>');

    if (openIdx !== -1 && closeIdx !== -1) {
        return {
            displayText: text.substring(openIdx + '<translation>'.length, closeIdx),
            isComplete: true
        };
    } else if (openIdx !== -1) {
        return {
            displayText: text.substring(openIdx + '<translation>'.length),
            isComplete: false
        };
    } else {
        return {
            displayText: text.replace(/<\/?[^>]+>/g, ''),
            isComplete: false
        };
    }
}

/**
 * Ephemeral streaming state for literal retranslation streaming.
 * Tracks the abort handle and accumulated text for the literal back-translation stream.
 * Literal streaming is simpler than main streaming: no reasoning, no XML tags, plain text only.
 */
interface LiteralStreamingState {
    abort: () => void;
    accumulatedText: string;
}

/**
 * Map from Translation objects to their literal retranslation streaming state.
 * Separate from streamingStateMap because literal streaming runs concurrently
 * as a background task after the main translation completes.
 * @type {WeakMap<Translation, LiteralStreamingState>}
 */
const literalStreamingStateMap: WeakMap<Translation, LiteralStreamingState> = new WeakMap();

/**
 * Map from Translation objects to their interpretation streaming abort handles.
 * Interpretation runs as a background task after the main translation completes,
 * so it needs separate tracking from the main stream.
 * @type {WeakMap<Translation, () => void>}
 */
const interpretationAbortMap: WeakMap<Translation, () => void> = new WeakMap();

/**
 * Map from Translation objects to their in-flight interpretation follow-up abort handles.
 * Follow-ups are ephemeral: the handle only exists while an answer is streaming.
 * @type {WeakMap<Translation, () => void>}
 */
const interpretationFollowupAbortMap: WeakMap<Translation, () => void> = new WeakMap();

/**
 * Ephemeral streaming state for interpretation streaming.
 * Interpretation output is plain markdown (no XML tags), so only the accumulated
 * text and the offset already painted as markdown need tracking.
 */
interface InterpretationStreamingState {
    accumulatedText: string;
    /** Offset of the accumulated text already rendered as markdown. */
    renderedUpTo: number;
    /** True once the pane has been painted at least once for this stream. */
    hasPainted: boolean;
}

/**
 * Map from Translation objects to their interpretation streaming state.
 * Used both for incremental rendering and as the stream's render-scheduler key.
 * @type {WeakMap<Translation, InterpretationStreamingState>}
 */
const interpretationStreamingStateMap: WeakMap<Translation, InterpretationStreamingState> = new WeakMap();

/**
 * Sets the model override dropdown with available models
 * @param {Array<{id: string; name: string; pricing?: {prompt: string; completion: string}; providerName?: string}>} models - Array of model objects
 * @returns {void}
 */
export function setModelOverrideOptions(models: Array<{id: string; name: string; pricing?: {prompt: string; completion: string}; providerName?: string}>): void {
    const overrideSelect = document.getElementById('model-override') as HTMLSelectElement | null;

    if (!overrideSelect) return;
    overrideSelect.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Default LLM';
    overrideSelect.appendChild(defaultOption);

    for (const model of models) {
        const option = document.createElement('option');
        option.value = model.id;
        if (model.pricing) {
            const promptCost = (parseFloat(model.pricing.prompt) * 1_000_000).toFixed(2);
            const completionCost = (parseFloat(model.pricing.completion) * 1_000_000).toFixed(2);
            const providerPart = model.providerName ? ' by ' + model.providerName : '';
            option.textContent = `${model.name}${providerPart} ($${promptCost}/$${completionCost})`;
        } else {
            option.textContent = model.name;
        }
        overrideSelect.appendChild(option);
    }
}

/**
 * Sets the application config reference
 * @param {Config} appConfig - Application configuration object
 * @returns {void}
 */
export function setConfig(appConfig: Config): void {
    config = appConfig;
}

/**
 * Sets the model name map for display purposes
 * @param {Array<{id: string; name: string}>} models - Array of model objects
 * @returns {void}
 */
export function setModelNameMap(models: Array<{id: string; name: string}>): void {
    modelNameMap = new Map();
    for (const model of models) {
        modelNameMap.set(model.id, model.name);
    }
}

/**
 * Gets the display name for a model ID
 * @param {string} modelId - Model ID
 * @returns {string} Model display name
 */
export function getModelName(modelId: string): string {
    return modelNameMap.get(modelId) ?? modelId;
}

/**
 * Gets the model to use for translation, checking override, session, and config in order
 * @param {TranslationSession | null} session - The current translation session
 * @returns {string | null} The model ID to use
 */
function getTranslationModelToUse(session: TranslationSession | null): string | null {
    if (modelOverride) return modelOverride;
    if (session?.model) return session.model;
    return config?.selectedModel ?? null;
}

/**
 * Gets the translation reasoning level to use
 * @param {TranslationSession | null} session - The current translation session
 * @returns {ReasoningLevel} Reasoning level to use
 */
function getTranslationReasoningToUse(session: TranslationSession | null): ReasoningLevel {
    if (reasoningOverride != null) return reasoningOverride;
    if (session?.reasoning) return session.reasoning;
    return config?.defaultReasoning ?? 'none';
}

/**
 * Gets the literal retranslation model to use
 * @param {TranslationSession | null} session - The current translation session
 * @returns {string | null} The model ID to use, or null if disabled
 */
function getLiteralModelToUse(session: TranslationSession | null): string | null {
    if (session?.literalModel) return session.literalModel;
    return config?.defaultLiteralModel ?? null;
}

/**
 * Gets the interpretation model to use
 * @param {TranslationSession | null} session - The current translation session
 * @returns {string | null} The model ID to use, or null if disabled
 */
function getInterpretationModelToUse(session: TranslationSession | null): string | null {
    if (session?.interpretationModel) return session.interpretationModel;
    return config?.defaultInterpretationModel ?? null;
}

/**
 * Gets the interpretation reasoning level to use
 * @param {TranslationSession | null} session - The current translation session
 * @returns {ReasoningLevel} Reasoning level to use
 */
function getInterpretationReasoningToUse(session: TranslationSession | null): ReasoningLevel {
    if (session?.interpretationReasoning) return session.interpretationReasoning;
    return config?.defaultInterpretationReasoning ?? 'none';
}

/**
 * Gets the quick question model to use
 * @param {TranslationSession | null} session - The current translation session
 * @returns {string | null} The model ID to use
 */
function getQuickQuestionModelToUse(session: TranslationSession | null): string | null {
    if (session?.quickQuestionModel) return session.quickQuestionModel;
    if (config?.quickQuestionModel) return config.quickQuestionModel;
    if (session?.model) return session.model;
    return config?.selectedModel ?? null;
}

/**
 * Gets the quick question reasoning level to use
 * @param {TranslationSession | null} session - The current translation session
 * @returns {ReasoningLevel} Reasoning level to use
 */
function getQuickQuestionReasoningToUse(session: TranslationSession | null): ReasoningLevel {
    if (session?.quickQuestionReasoning) return session.quickQuestionReasoning;
    return config?.defaultQuickQuestionReasoning ?? 'none';
}

/**
 * Gets the model to use for question messages
 * @param {TranslationSession | null} session - The current translation session
 * @returns {string | null} The model ID to use
 */
function getQuestionModelToUse(session: TranslationSession | null): string | null {
    if (modelOverride) return modelOverride;
    if (session?.questionModel) return session.questionModel;
    if (config?.defaultQuestionModel) return config.defaultQuestionModel;
    if (session?.model) return session.model;
    return config?.selectedModel ?? null;
}

/**
 * Gets the reasoning level to use for question messages
 * @param {TranslationSession | null} session - The current translation session
 * @returns {ReasoningLevel} Reasoning level to use
 */
function getQuestionReasoningToUse(session: TranslationSession | null): ReasoningLevel {
    if (reasoningOverride != null) return reasoningOverride;
    if (session?.questionReasoning) return session.questionReasoning;
    return config?.defaultQuestionReasoning ?? 'none';
}

/**
 * Gets the word definitions model to use
 * @param {TranslationSession | null} session - The current translation session
 * @returns {string | null} The model ID to use
 */
function getWordDefModelToUse(session: TranslationSession | null): string | null {
    if (session?.wordDefModel) return session.wordDefModel;
    if (config?.defaultWordDefModel) return config.defaultWordDefModel;
    if (session?.model) return session.model;
    return config?.selectedModel ?? null;
}

/**
 * Gets the word definitions reasoning level to use
 * @param {TranslationSession | null} session - The current translation session
 * @returns {ReasoningLevel} The reasoning level to use
 */
function getWordDefReasoningToUse(session: TranslationSession | null): ReasoningLevel {
    if (session?.wordDefReasoning) return session.wordDefReasoning;
    return config?.defaultWordDefReasoning ?? 'none';
}

/**
 * Gets the current session ID
 * @returns {string} Current session ID
 */
export function getCurrentSessionId(): string {
    return currentSessionId;
}

/**
 * Reads the current session's explicitly chosen model, if any
 * @returns {Promise<string | null>} Session model id, or null when none is set
 */
export async function getCurrentSessionModel(): Promise<string | null> {
    const session = await loadSession(currentSessionId);
    return session?.model ?? null;
}

/**
 * Loads all sessions from storage
 * @returns {Promise<TranslationSession[]>} Array of sessions
 */
export async function loadSessionsList(): Promise<TranslationSession[]> {
    return await listSessions();
}

/**
 * Switches to a different session
 * @param {string} sessionId - Session ID to switch to
 * @returns {Promise<void>}
 */
export async function setCurrentSession(sessionId: string): Promise<void> {
    if (DEBUG_SESSIONS) {
        console.log(`[setCurrentSession] Switching to session ${sessionId}`);
    }

    const session = await loadSession(sessionId);
    if (!session) {
        if (DEBUG_SESSIONS) {
            console.error(`[setCurrentSession] Session ${sessionId} not found`);
        }
        return;
    }

    currentSessionId = sessionId;
    cachedDraftQuickQuestion = null;
    cachedTranslationQuickQuestion = null;
    currentLiteralModel = getLiteralModelToUse(session);
    currentInterpretationModel = getInterpretationModelToUse(session);
    await savePreference('currentSession', sessionId);

    allTranslations = [];
    clearTranslationContainers();
    await resetHistoryWindow(sessionId);

    if (config) {
        if (session.model) {
            config.selectedModel = session.model;
        }
    }

    updateSessionSelector(sessionId);
    await loadDrafts(sessionId);

    if (DEBUG_SESSIONS) {
        console.log(`[setCurrentSession] Switched to session ${sessionId}: ${session.name}`);
    }
}

/**
 * Resets the history window for a session and loads its first page.
 * Enumerates the session's translation timestamps (a directory listing, no file
 * reads), groups them into active days, then loads the most recent page.
 * @param {string} sessionId - Session ID to load
 * @returns {Promise<void>}
 */
async function resetHistoryWindow(sessionId: string): Promise<void> {
    sessionTranslationTimestamps = await listSessionTranslationTimestamps(sessionId);
    sessionActiveDays = groupTimestampsByDay(sessionTranslationTimestamps);
    loadedHistoryDays = new Set<number>();
    await loadNextHistoryPage();
}

/**
 * Loads and renders the next page of active days, appending older history below
 * the already-rendered items. Does nothing when every day is loaded or when a
 * load is already in flight.
 * @returns {Promise<boolean>} True when a page was loaded, false when there was nothing to do
 */
async function loadNextHistoryPage(): Promise<boolean> {
    if (isLoadingOlderHistory) return false;

    const remainingDays = sessionActiveDays.filter(function(day: number): boolean {
        return !loadedHistoryDays.has(day);
    });
    if (remainingDays.length === 0) return false;

    isLoadingOlderHistory = true;
    try {
        const sessionId = currentSessionId;
        const days = remainingDays.slice(0, HISTORY_DAYS_PER_PAGE);
        const timestamps = selectTimestampsInDays(sessionTranslationTimestamps, days);
        const loaded = await loadSessionTranslationsByTimestamp(sessionId, timestamps);

        // The session may have been switched while the files were loading
        if (sessionId !== currentSessionId) return false;

        for (const translation of loaded) {
            ensureEntries(translation);
        }
        repairInterruptedTranslations(loaded);

        const knownIds = new Set(allTranslations.map(function(t) { return t.id; }));
        const additions = loaded.filter(function(t) { return !knownIds.has(t.id); });
        allTranslations = allTranslations.concat(additions)
            .sort(function(a, b) { return b.timestamp - a.timestamp; });

        const container = document.getElementById('translations-container');
        if (container) {
            // Newer first, appended: the container runs newest at the top
            const newestFirst = [...additions].sort(function(a, b) { return b.timestamp - a.timestamp; });
            for (const translation of newestFirst) {
                renderTranslationItem(container, translation, 'bottom');
            }
        }

        for (const day of days) {
            loadedHistoryDays.add(day);
        }
        return true;
    } finally {
        isLoadingOlderHistory = false;
    }
}

/**
 * Reports whether any active day has yet to be loaded
 * @returns {boolean} True when older history remains to be loaded
 */
function hasRemainingHistoryDays(): boolean {
    return sessionActiveDays.some(function(day: number): boolean {
        return !loadedHistoryDays.has(day);
    });
}

/**
 * Repairs translations left mid-flight by a crash or reload
 * @param {Translation[]} translations - Translations to repair
 * @returns {void}
 */
function repairInterruptedTranslations(translations: Translation[]): void {
    for (const t of translations) {
        const entry = t.entries[t.activeEntryIndex ?? 0];
        let needsSave = false;
        if (entry) {
            if (t.status === 'streaming' || t.status === 'pending') {
                t.status = 'error';
                t.error = 'Generation was interrupted.';
                needsSave = true;
            }
            if (entry.literalPending) {
                entry.literalPending = false;
                needsSave = true;
            }
            if (entry.wordPending) {
                entry.wordPending = false;
                needsSave = true;
            }
            if (entry.interpretationPending) {
                entry.interpretationPending = false;
                needsSave = true;
            }
            if (needsSave) {
                syncTopLevelFromActive(t);
                saveSessionTranslation(currentSessionId, t).catch(function(e: unknown) {
                    console.error('[repairInterruptedTranslations] Failed to save fixed translation:', e);
                });
            }
        }
    }
}

/**
 * Loads further history pages while the sentinel remains on screen.
 * An IntersectionObserver only fires when the sentinel crosses into view, so a
 * page too short to push the sentinel off screen must be followed up manually.
 * @returns {Promise<void>}
 */
async function fillHistoryViewport(): Promise<void> {
    const sentinel = document.getElementById('history-load-sentinel');
    if (!sentinel) return;

    while (hasRemainingHistoryDays()) {
        const top = sentinel.getBoundingClientRect().top;
        if (top > window.innerHeight + HISTORY_SCROLL_MARGIN) return;
        const loadedPage = await loadNextHistoryPage();
        if (!loadedPage) return;
    }
}

/**
 * Wires the sentinel that loads older history as the user scrolls down
 * @returns {void}
 */
export function setupHistoryAutoLoad(): void {
    const sentinel = document.getElementById('history-load-sentinel');
    if (!sentinel || historyScrollObserver) return;

    historyScrollObserver = new IntersectionObserver(function(entries: IntersectionObserverEntry[]): void {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            fillHistoryViewport().catch(function(e: unknown) {
                console.error('[setupHistoryAutoLoad] Failed to load older history:', e);
            });
        }
    }, { rootMargin: HISTORY_SCROLL_MARGIN + 'px' });

    historyScrollObserver.observe(sentinel);
}

/**
 * Creates a new session
 * @returns {Promise<string>} New session ID
 */
export async function createSession(name?: string): Promise<string> {
    if (DEBUG_SESSIONS) {
        console.log('[createSession] Creating new session');
    }

    const now = Date.now();

    const deviceId = await getDeviceId();
    const newSession: TranslationSession = {
        id: generateUuid(),
        deviceId: deviceId,
        name: name ?? "New Conversation",
        model: config?.defaultModel ?? config?.selectedModel ?? null,
        theirLanguage: 'english',
        myLanguage: config?.defaultMyLanguage ?? 'english',
        background: "",
        reasoning: null,
        literalModel: null,
        interpretationModel: null,
        interpretationReasoning: undefined,
        questionModel: null,
        questionReasoning: undefined,
        wordDefModel: null,
        wordDefReasoning: undefined,
        createdAt: now
    };

    await saveSession(newSession);

    if (DEBUG_SESSIONS) {
        console.log(`[createSession] Created session ${newSession.id}: ${newSession.name}`);
    }

    await setCurrentSession(newSession.id);

    return newSession.id;
}

/**
 * Deletes a session
 * @param {string} sessionId - Session ID to delete
 * @returns {Promise<boolean>} True if deleted
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
    if (DEBUG_SESSIONS) {
        console.log(`[deleteSession] Deleting session ${sessionId}`);
    }

    const result = await storageDeleteSession(sessionId);

    if (result && currentSessionId === sessionId) {
        await setCurrentSession('default');
    }

    return result;
}

/**
 * Renames a session
 * @param {string} sessionId - Session ID
 * @param {string} newName - New name
 * @returns {Promise<void>}
 */
export async function renameSession(sessionId: string, newName: string): Promise<void> {
    if (DEBUG_SESSIONS) {
        console.log(`[renameSession] Renaming session ${sessionId} to ${newName}`);
    }

    const session = await loadSession(sessionId);
    if (!session) {
        return;
    }

    session.name = newName;
    await saveSession(session);

    if (DEBUG_SESSIONS) {
        console.log(`[renameSession] Renamed session ${sessionId} to ${newName}`);
    }
}

/**
 * Saves the current session state
 * @returns {Promise<void>}
 */
export async function saveCurrentSession(): Promise<void> {
    if (DEBUG_SESSIONS) {
        console.log(`[saveCurrentSession] Saving current session state`);
    }

    const session = await loadSession(currentSessionId);
    if (!session) {
        return;
    }

    await saveSession(session);
}

/**
 * Saves the background for the current session
 * @param {string} background - Background text
 * @returns {Promise<void>}
 */
export async function saveBackground(background: string): Promise<void> {
    const session = await loadSession(currentSessionId);
    if (!session) {
        return;
    }

    session.background = background;
    await saveSession(session);
}

/**
 * Gets the background for the current session
 * @returns {Promise<string>} Background text or empty string
 */
export async function getBackground(): Promise<string> {
    const session = await loadSession(currentSessionId);
    let background = '';

    if (session?.selectedContextIds && session.selectedContextIds.length > 0) {
        const defsStr = await getPreference('contextDefinitions');
        if (defsStr) {
            try {
                const defs = JSON.parse(defsStr) as Array<{id: string; name: string; content: string}>;
                for (const ctxId of session.selectedContextIds) {
                    const ctx = defs.find(function(d) { return d.id === ctxId; });
                    if (ctx) {
                        background += ctx.content + '\n\n';
                    }
                }
            } catch {
                // Invalid context definitions — ignore
            }
        }
    }

    background += session?.background ?? '';
    return background;
}

/**
 * Clears the translation container in the DOM
 * @returns {void}
 */
function clearTranslationContainers(): void {
    const container = document.getElementById('translations-container');
    if (container) {
        container.innerHTML = '';
    }
}

/**
 * Updates the session selector dropdown to show the current session
 * @param {string} sessionId - Current session ID
 * @returns {void}
 */
function updateSessionSelector(sessionId: string): void {
    const selector = document.getElementById('session-selector') as HTMLSelectElement | null;
    if (selector) {
        selector.value = sessionId;
    }
}

/**
 * Initializes the default session on startup
 * @returns {Promise<void>}
 */
export async function initializeDefaultSession(): Promise<void> {
    if (DEBUG_SESSIONS) {
        console.log('[initializeDefaultSession] Initializing default session');
    }

    const defaultSession = await getOrCreateDefaultSession(
        config?.selectedModel ?? null,
        'english'
    );

    currentSessionId = defaultSession.id;

    if (DEBUG_SESSIONS) {
        console.log(`[initializeDefaultSession] Default session: ${defaultSession.id}: ${defaultSession.name}`);
    }
}



/**
 * Controls which conversation history is included in a user message
 */
type HistorySectionOptions = {
    /** Number of most recent days with activity to include */
    activeDayCount: number;
    /** Whether to include question/answer pairs */
    includeQuestions: boolean;
    /**
     * Which rendering of each message to include.
     * 'sourceAndTranslation' includes both sides of every message;
     * 'recipientView' includes only the text the other party actually received.
     */
    contentMode?: 'sourceAndTranslation' | 'recipientView';
    /** Timestamps to leave out of <history> (the item being interpreted) */
    excludeTimestamps?: ReadonlySet<number>;
};

/** Active days of history included in translation, question and quick question messages */
const HISTORY_CONTEXT_DAYS = 7;

/** Active days of history included in interpretation messages (kept in step with translation context) */
const INTERPRETATION_CONTEXT_DAYS = 7;

/**
 * Builds the history section for the user message from the most recent active days.
 * In 'recipientView' mode only the text the other party actually received is included:
 * the foreign source of messages they sent, and the foreign translation of messages
 * the user sent. Question/answer pairs are only included when the item is marked
 * includeInContext. Items whose timestamps are excluded are left out entirely, including
 * their contribution to the active-day window.
 * @param {HistorySectionOptions} options - Which history to include
 * @returns {Promise<string>} History section or empty string
 */
async function buildHistorySection(options: HistorySectionOptions): Promise<string> {
    const includeQuestions = options.includeQuestions;
    const recipientView = options.contentMode === 'recipientView';
    const excludedTimestamps = options.excludeTimestamps;

    const complete = allTranslations.filter(function(t) {
        return t.status === 'complete' && !excludedTimestamps?.has(t.timestamp);
    });

    // Only conversation content starts or extends the window. Context notes must
    // not consume one of the counted days; they are still included when they fall
    // after the window's start, so a back-dated note reaches retroactively.
    const contentItems = complete.filter(function(t) { return t.pill !== 'context'; });
    const contentDays = groupTimestampsByDay(contentItems.map(function(t) { return t.timestamp; }));
    const windowDays = contentDays.slice(0, options.activeDayCount);

    if (windowDays.length === 0) {
        return "";
    }

    const cutoff = windowDays[windowDays.length - 1];
    const translationsWithinDays = complete
        .filter(function(t) { return t.timestamp >= cutoff; })
        .sort(function(a, b) { return a.timestamp - b.timestamp; });

    // Load session tags for stripping from output translations
    let outputTags: TranslationTag[] = [];
    try {
        const session = await loadSession(currentSessionId);
        if (session?.translationTags) outputTags = session.translationTags;
    } catch {}

    let history = "<history>\n";
    for (const t of translationsWithinDays) {
        ensureEntries(t);
        const entry = t.entries[t.activeEntryIndex ?? 0];
        if (!entry) continue;
        const ts = formatTimestamp(t.timestamp);
        if (t.pill === 'input') {
            history += `<them ts="${ts}">${entry.source}</them>\n`;
            if (!recipientView) {
                history += `<them ts="${ts}">${stripIfNeeded(entry.translation, 'output', outputTags)}</them>\n`;
            }
        } else if (t.pill === 'output') {
            if (recipientView) {
                history += `<me ts="${ts}">${stripIfNeeded(entry.translation, 'output', outputTags)}</me>\n`;
            } else {
                history += `<me ts="${ts}">${entry.source}</me>\n`;
                history += `<me ts="${ts}">${stripIfNeeded(entry.translation, 'output', outputTags)}</me>\n`;
            }
        } else if (t.pill === 'question' && includeQuestions && t.includeInContext === true) {
            history += `<already_answered ts="${ts}">${entry.source}</already_answered>\n`;
            history += `<agentanswer ts="${ts}">${stripIfNeeded(entry.translation, 'question', outputTags)}</agentanswer>\n`;
        } else if (t.pill === 'context') {
            // Context notes are always included; they are background the user
            // supplied deliberately, not something the other party said.
            history += `<note ts="${ts}">${entry.source}</note>\n`;
        }
    }
    history += "</history>";
    return history;
}

/**
 * Gets the short model name without the provider prefix
 * E.g., "Google: Gemini Flash" → "Gemini Flash"
 * @param {string} fullName - Full model name with provider prefix
 * @returns {string} Short model name
 */
function getModelShortName(fullName: string): string {
    const idx = fullName.indexOf(': ');
    return idx >= 0 ? fullName.substring(idx + 2) : fullName;
}

/**
 * Syncs top-level fields from the active entry (for saving with backward compat)
 * @param {Translation} translation - Translation to sync
 * @returns {void}
 */
function syncTopLevelFromActive(translation: Translation): void {
    const entry = translation.entries?.[translation.activeEntryIndex ?? 0];
    if (!entry) return;
    (translation as any).source = entry.source;
    (translation as any).intent = entry.intent;
    (translation as any).model = entry.model;
    (translation as any).modelName = entry.modelName;
    (translation as any).prompt = entry.prompt;
    (translation as any).promptContent = entry.promptContent;
    (translation as any).translation = entry.translation;
    (translation as any).explanation = entry.explanation;
    (translation as any).nuances = entry.nuances;
    (translation as any).reasoning = entry.reasoning;
    (translation as any).reasoningDetails = entry.reasoningDetails;
    (translation as any).literalRetranslation = entry.literalRetranslation;
    (translation as any).literalPending = entry.literalPending;
    (translation as any).wordDefinitions = entry.wordDefinitions;
    (translation as any).wordData = entry.wordData;
    (translation as any).wordPending = entry.wordPending;
    (translation as any).interpretation = entry.interpretation;
    (translation as any).interpretationPending = entry.interpretationPending;
}

/**
 * Switches the active translation entry and re-renders the UI
 * @param {string} translationId - ID of the translation
 * @param {number} entryIndex - Index of the entry to activate
 * @returns {Promise<void>}
 */
export async function switchTranslationEntry(translationId: string, entryIndex: number): Promise<void> {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });
    if (!translation || !translation.entries || entryIndex < 0 || entryIndex >= translation.entries.length) {
        return;
    }
    translation.activeEntryIndex = entryIndex;
    syncTopLevelFromActive(translation);
    const refs = domRefsMap.get(translation);
    if (refs) {
        updateTranslationItemContent(translation, refs);
    }
    saveSessionTranslation(currentSessionId, translation);
}

/**
 * Fills the language placeholders in an interpretation-family system prompt.
 * @param {TranslationSession | null} session - Active session, or null if unavailable
 * @param {string} [template] - Prompt template containing [LANGUAGE] and [TARGET_LANGUAGE]
 * @returns {string} Prompt with the language names substituted
 */
function buildInterpretationSystemPrompt(
    session: TranslationSession | null,
    template: string = INTERPRETATION_PROMPT
): string {
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'the source language';
    const theirLang = LANGUAGES.find(function(l) { return l.id === session?.theirLanguage; });
    const theirLangName = theirLang?.name ?? session?.theirLanguage ?? 'the target language';

    return template
        .replace(/\[LANGUAGE\]/g, myLangName)
        .replace(/\[TARGET_LANGUAGE\]/g, theirLangName);
}

/**
 * Builds the shared context blocks for an interpretation or an interpretation follow-up.
 * The follow-up rebuilds this at ask time so it always reflects the current conversation.
 * @param {Translation} translation - Translation being interpreted
 * @returns {Promise<{ sections: string; myLanguageName: string }>} Context blocks and the user's language name
 */
async function buildInterpretationContext(
    translation: Translation
): Promise<{ sections: string; myLanguageName: string }> {
    const background = await getBackground();
    const session = await loadSession(currentSessionId);
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';

    let sections = "";

    if (background.trim()) {
        sections += `<background>${background}</background>\n\n`;
    }

    const history = await buildHistorySection({
        activeDayCount: INTERPRETATION_CONTEXT_DAYS,
        includeQuestions: false,
        contentMode: 'recipientView',
        excludeTimestamps: new Set([translation.timestamp])
    });
    if (history) {
        sections += history + "\n\n";
    }

    const entry = translation.entries?.[translation.activeEntryIndex ?? 0];
    const translationText = entry?.translation ?? (translation as any).translation ?? '';
    sections += `<current_time val="${formatTimestampWithOffset(Date.now())}"/>\n`;
    sections += `(${TIMESTAMP_NOTE})\n\n`;
    sections += `<interpret>${translationText}</interpret>\n\n`;

    if (DEBUG_TRANSLATIONS) {
        console.log('[interpretation] context:\n' + sections);
    }

    return { sections, myLanguageName: myLangName };
}

/**
 * Builds the user message for interpretation
 * @param {Translation} translation - Translation to interpret
 * @returns {Promise<string>} Formatted message
 */
async function buildInterpretationMessage(translation: Translation): Promise<string> {
    const context = await buildInterpretationContext(translation);
    return context.sections
        + `<instructions>Explain how the listener will understand this message — both text and subtext — given the conversation so far and their linguistic and cultural context. Write your explanation in ${context.myLanguageName}.</instructions>`;
}

/**
 * Builds the user message for a follow-up question about an interpretation.
 * Reuses the interpretation's context, then adds the interpretation itself.
 * @param {Translation} translation - Translation the interpretation was made for
 * @param {string} interpretationText - Interpretation the user is asking about
 * @param {Array<{question: string, answer: string}>} previousQA - Earlier Q&A in this follow-up chain
 * @param {string} questionText - The user's current question
 * @returns {Promise<string>} Formatted message
 */
async function buildInterpretationFollowupMessage(
    translation: Translation,
    interpretationText: string,
    previousQA: Array<{question: string, answer: string}>,
    questionText: string
): Promise<string> {
    const context = await buildInterpretationContext(translation);

    let message = context.sections;
    message += `<interpretation>${interpretationText}</interpretation>\n\n`;

    if (previousQA.length > 0) {
        message += "<previous_qa>\n";
        for (const qa of previousQA) {
            message += `Q: ${qa.question}\nA: ${qa.answer}\n\n`;
        }
        message += "</previous_qa>\n\n";
    }

    message += `<current_question>${questionText}</current_question>\n\n`;
    message += `<instructions>Answer in ${context.myLanguageName}.</instructions>`;

    return message;
}

/**
 * Sets up the translate buttons for both panes
 * @returns {void}
 */
export function setupTranslateButtons(): void {
    const translateBtn = document.getElementById("translate-btn");
    const askBtn = document.getElementById("ask-btn");
    const inputBtn = document.getElementById("input-btn");
    const contextBtn = document.getElementById("context-btn");

    if (translateBtn) {
        translateBtn.addEventListener('click', function() {
            translate('output');
        });
    }

    if (askBtn) {
        askBtn.addEventListener('click', function() {
            askQuestion();
        });
    }

    if (inputBtn) {
        inputBtn.addEventListener('click', function() {
            translate('input');
        });
    }

    if (contextBtn) {
        contextBtn.addEventListener('click', function() {
            void showContextNoteModal();
        });
    }

    const quickQuestionBtn = document.getElementById('quick-question-btn');
    if (quickQuestionBtn) {
        quickQuestionBtn.addEventListener('click', function() {
            if (quickQuestionModalOpen) return;
            showQuickQuestionModal(cachedDraftQuickQuestion
                ? { prefillQuestion: cachedDraftQuickQuestion }
                : undefined
            );
        });
    }

    const overrideSelect = document.getElementById('model-override') as HTMLSelectElement | null;

    if (overrideSelect) {
        overrideSelect.addEventListener('change', function() {
            modelOverride = overrideSelect.value || null;
        });
    }

    const reasoningOverrideSelect = document.getElementById('reasoning-override') as HTMLSelectElement | null;
    if (reasoningOverrideSelect) {
        reasoningOverrideSelect.addEventListener('change', function() {
            reasoningOverride = (reasoningOverrideSelect.value || null) as ReasoningLevel | null;
        });
    }

    updateButtonStates();
}

/**
 * Saves the current source textarea and intent textarea contents to OPFS drafts
 * under the current session's path.
 * Called by the debounced auto-save handler.
 * @returns {Promise<void>}
 */
async function saveDrafts(): Promise<void> {
    const sourceEl = document.getElementById('source-textarea') as HTMLTextAreaElement | null;
    const intentEl = document.getElementById('intent-textarea') as HTMLTextAreaElement | null;
    const sourceValue = sourceEl?.value ?? '';
    const intentValue = intentEl?.value ?? '';
    try {
        await writeLocalFile('drafts/' + currentSessionId + '/source', sourceValue);
        if (intentEl) {
            await writeLocalFile('drafts/' + currentSessionId + '/intent', intentValue);
        }
    } catch (e) {
        console.error('[saveDrafts] Error saving draft:', e);
    }
}

/**
 * Loads draft text from OPFS for the given session (or current session) and
 * populates the textareas. Clears textareas first to ensure no stale content.
 * @param {string} [sessionId] - Session ID to load drafts for (defaults to current)
 * @returns {Promise<void>}
 */
export async function loadDrafts(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId ?? currentSessionId;
    const sourcePath = 'drafts/' + targetSessionId + '/source';
    const intentPath = 'drafts/' + targetSessionId + '/intent';

    const sourceEl = document.getElementById('source-textarea') as HTMLTextAreaElement | null;
    const intentEl = document.getElementById('intent-textarea') as HTMLTextAreaElement | null;

    // Clear textareas first
    if (sourceEl) sourceEl.value = '';
    if (intentEl) intentEl.value = '';

    try {
        const sourceDraft = await readLocalFile(sourcePath);
        const intentDraft = await readLocalFile(intentPath);
        if (sourceEl && sourceDraft !== null && sourceDraft.length > 0) {
            sourceEl.value = sourceDraft;
        }
        if (intentEl && intentDraft !== null && intentDraft.length > 0) {
            intentEl.value = intentDraft;
        }
    } catch (e) {
        console.error('[loadDrafts] Error loading drafts:', e);
    }
}

/**
 * Deletes draft files for the given session (or current session) from OPFS.
 * Called when a translation is successfully persisted to OPFS.
 * @param {string} [sessionId] - Session ID to clear drafts for (defaults to current)
 * @returns {Promise<void>}
 */
export async function clearDrafts(sessionId?: string): Promise<void> {
    const targetSessionId = sessionId ?? currentSessionId;
    try {
        await deleteLocalFile('drafts/' + targetSessionId + '/source');
        await deleteLocalFile('drafts/' + targetSessionId + '/intent').catch(function() {});
    } catch (e) {
        console.error('[clearDrafts] Error clearing drafts:', e);
    }
}

/**
 * Attaches input event listeners to the source and intent textareas
 * that auto-save their contents to OPFS with a debounce.
 * Should be called once on app startup after the textareas exist.
 * @returns {void}
 */
export function setupDraftAutoSave(): void {
    const sourceEl = document.getElementById('source-textarea') as HTMLTextAreaElement | null;
    const intentEl = document.getElementById('intent-textarea') as HTMLTextAreaElement | null;

    function scheduleSave(): void {
        if (draftSaveTimeout !== null) {
            clearTimeout(draftSaveTimeout);
        }
        draftSaveTimeout = setTimeout(function() {
            draftSaveTimeout = null;
            saveDrafts();
        }, DRAFT_SAVE_DEBOUNCE_MS);
    }

    if (sourceEl) {
        sourceEl.addEventListener('input', scheduleSave);
    }
    if (intentEl) {
        intentEl.addEventListener('input', scheduleSave);
    }
}

/**
 * Sets up keyboard handlers for the source textarea: Alt+Enter asks a question,
 * Enter and Shift+Enter insert a newline (default textarea behavior).
 * @returns {void}
 */
export function setupTextareaKeyHandlers(): void {
    const sourceTextarea = document.getElementById('source-textarea') as HTMLTextAreaElement | null;

    if (sourceTextarea) {
        sourceTextarea.addEventListener('keydown', function(event: KeyboardEvent): void {
            if (event.key === 'Enter' && event.altKey) {
                event.preventDefault();
                askQuestion();
            }
        });

        initTagPopup();

        sourceTextarea.addEventListener('mouseup', async function() {
            const start = sourceTextarea.selectionStart;
            const end = sourceTextarea.selectionEnd;
            const text = sourceTextarea.value.substring(start, end).trim();
            if (!text || !tagPopupElement) {
                hideTagPopup();
                return;
            }

            const session = await loadSession(currentSessionId);
            const tags = session?.translationTags ?? [];
            if (tags.length === 0) {
                hideTagPopup();
                return;
            }

            showTagPopup(sourceTextarea, tags);
        });

        sourceTextarea.addEventListener('blur', function() {
            setTimeout(hideTagPopup, 200);
        });
    }
}

/**
 * Updates button enabled/disabled states based on model selection
 * @returns {void}
 */
export function updateButtonStates(): void {
    const translateBtn = document.getElementById("translate-btn") as HTMLButtonElement | null;
    const askBtn = document.getElementById("ask-btn") as HTMLButtonElement | null;
    const inputBtn = document.getElementById("input-btn") as HTMLButtonElement | null;
    const contextBtn = document.getElementById("context-btn") as HTMLButtonElement | null;

    const hasModel = config !== null && config.selectedModel !== null;

    if (translateBtn) {
        translateBtn.disabled = !hasModel;
    }

    if (askBtn) {
        askBtn.disabled = !hasModel;
    }

    if (inputBtn) {
        inputBtn.disabled = !hasModel;
    }

    // Context notes never reach the LLM, so they need no model
    if (contextBtn) {
        contextBtn.disabled = false;
    }
}

/**
 * Builds the complete user message for structured translation
 * @param {'input' | 'output'} pill - Which pane
 * @param {string} sourceText - Text to translate
 * @param {string} instructions - Instruction text (language or prompt instructions)
 * @returns {Promise<string>} Complete user message
 */
async function buildUserMessage(pill: 'input' | 'output' | 'question', sourceText: string, instructions: string): Promise<string> {
    const background = await getBackground();

    let message = "";

    if (background.trim()) {
        message += `<background>${background}</background>\n\n`;
    }

    const history = await buildHistorySection({
        activeDayCount: HISTORY_CONTEXT_DAYS,
        includeQuestions: pill !== 'input'
    });
    if (history) {
        message += history + "\n\n";
    }

    message += `<current_time val="${formatTimestampWithOffset(Date.now())}"/>\n`;
    message += `(${TIMESTAMP_NOTE})\n\n`;
    message += `<translate>${sourceText}</translate>\n\n`;
    message += `<instructions>${instructions}</instructions>`;

    return message;
}

/**
 * Guards against concurrent calls to translate() and askQuestion().
 * Prevents spurious "Please enter text to translate" errors caused by
 * duplicate event firings where the second call finds an empty textarea.
 * @type {boolean}
 */
let isTranslatingOrAsking = false;

/**
 * Performs translation for the specified mode using streaming
 * @param {'input' | 'output'} mode - Which mode to translate
 * @returns {Promise<void>}
 */
export async function translate(mode: 'input' | 'output'): Promise<void> {
    if (isTranslatingOrAsking) return;
    cachedDraftQuickQuestion = null;
    isTranslatingOrAsking = true;
    try {
        if (!config) {
            ui.displayError("Please select a model first");
            return;
        }

        if (!config.openRouterApiKey) {
            ui.displayError("Please enter your API key first");
            return;
        }

        const textarea = document.getElementById('source-textarea') as HTMLTextAreaElement | null;
        if (!textarea) {
            return;
        }

        const sourceText = textarea.value.trim();
        if (!sourceText) {
            ui.displayError("Please enter text to translate");
            return;
        }

        const intentTextarea = document.getElementById('intent-textarea') as HTMLTextAreaElement | null;
        const intent = mode === 'output' ? (intentTextarea?.value.trim() ?? '') : '';

        textarea.value = '';
        if (intentTextarea) {
            intentTextarea.value = '';
        }

        const session = await loadSession(currentSessionId);
        const effectiveModel = getTranslationModelToUse(session);
        if (!effectiveModel) {
            ui.displayError("Please select a model first");
            return;
        }
        const reasoningLevel = getTranslationReasoningToUse(session);
        currentLiteralModel = getLiteralModelToUse(session);
        const theirLang = LANGUAGES.find(function(l) { return l.id === session?.theirLanguage; });
        const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
        const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';

        const promptName = mode === 'input'
            ? (session?.interlocutorName ?? theirLang?.name ?? 'Foreign')
            : 'Me';

        const deviceId = await getDeviceId();

        const translation: Translation = {
            id: generateUuid(),
            deviceId: deviceId,
            pill: mode,
            entries: [{
                source: sourceText,
                intent: intent,
                model: effectiveModel ?? '',
                modelName: getModelName(effectiveModel ?? ''),
                prompt: promptName,
                promptContent: '',
                translation: '',
                explanation: '',
                nuances: '',
                reasoning: '',
                reasoningDetails: '',
                literalRetranslation: undefined,
                literalPending: false,
                wordDefinitions: undefined,
                wordData: undefined,
                wordPending: false,
                interpretation: undefined,
                interpretationPending: false
            }],
            activeEntryIndex: 0,
            timestamp: Date.now(),
            status: 'streaming',
            error: null
        };

        allTranslations.push(translation);
        const container = document.getElementById('translations-container');
        if (container) {
            renderTranslationItem(container, translation);
        }

        const systemPrompt = mode === 'input' ? INPUT_SYSTEM_PROMPT : OUTPUT_SYSTEM_PROMPT;
        console.log(`[translate] Starting streaming translation with model: ${effectiveModel}, mode: ${mode}`);

        await handleTranslateStreaming(
            translation,
            mode,
            systemPrompt,
            effectiveModel,
            reasoningLevel,
            { clearDraftsOnDone: true }
        );
    } finally {
        isTranslatingOrAsking = false;
    }
}

/**
 * Builds the user message for question answering
 * @param {string} questionText - The user's question
 * @returns {Promise<string>} Complete user message
 */
async function buildQuestionMessage(questionText: string, myLanguage?: string): Promise<string> {
    const background = await getBackground();

    let message = "";

    if (background.trim()) {
        message += `<background>${background}</background>\n\n`;
    }

    const history = await buildHistorySection({
        activeDayCount: HISTORY_CONTEXT_DAYS,
        includeQuestions: true
    });
    if (history) {
        message += history + "\n\n";
    }

    message += `<current_time val="${formatTimestampWithOffset(Date.now())}"/>\n`;
    message += `(${TIMESTAMP_NOTE})\n\n`;
    message += `<question>${questionText}</question>\n\n`;
    const langInstruction = myLanguage ? ` Write your answer in ${myLanguage}.` : '';
    message += `<instructions>Answer the user's question clearly and helpfully.${langInstruction}</instructions>`;

    return message;
}

/**
 * Answers a question about the conversation
 * @returns {Promise<void>}
 */
export async function askQuestion(): Promise<void> {
    if (isTranslatingOrAsking) return;
    isTranslatingOrAsking = true;
    try {
        if (!config) {
            ui.displayError("Please select a model first");
            return;
        }

        if (!config.openRouterApiKey) {
            ui.displayError("Please enter your API key first");
            return;
        }

        const textarea = document.getElementById('source-textarea') as HTMLTextAreaElement | null;
        if (!textarea) {
            return;
        }

        const questionText = textarea.value.trim();
        if (!questionText) {
            ui.displayError("Please enter a question");
            return;
        }

        textarea.value = '';

        const session = await loadSession(currentSessionId);
        const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
        const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';
        const userMessage = await buildQuestionMessage(questionText, myLangName);

        const effectiveModel = getQuestionModelToUse(session);
        if (!effectiveModel) {
            ui.displayError("Please select a model first");
            return;
        }
        const reasoningLevel = getQuestionReasoningToUse(session);
        console.log(`[askQuestion] Asking question with model: ${effectiveModel}, chars: ${questionText.length}`);

        const deviceId = await getDeviceId();
        const translation: Translation = {
            id: generateUuid(),
            deviceId: deviceId,
            pill: 'question',
            includeInContext: false,
            entries: [{
                source: questionText,
                intent: '',
                model: effectiveModel ?? '',
                modelName: getModelName(effectiveModel ?? ''),
                prompt: 'Question',
                promptContent: QUESTION_SYSTEM_PROMPT,
                translation: '',
                explanation: '',
                nuances: '',
                reasoning: '',
                reasoningDetails: '',
                literalRetranslation: undefined,
                literalPending: false,
                wordDefinitions: undefined,
                wordData: undefined,
                wordPending: false,
                interpretation: undefined,
                interpretationPending: false
            }],
            activeEntryIndex: 0,
            timestamp: Date.now(),
            status: 'streaming',
            error: null
        };

        allTranslations.push(translation);
        renderAllTranslations();

        await handleQuestionStreaming(
            translation,
            userMessage,
            effectiveModel,
            reasoningLevel,
            true
        );
    } finally {
        isTranslatingOrAsking = false;
    }
}

/**
 * Formats a timestamp as the value expected by an `<input type="datetime-local">`.
 * @param {number} timestamp - Milliseconds since the epoch
 * @returns {string} Local date and time in YYYY-MM-DDTHH:mm form
 */
function formatDateTimeLocalValue(timestamp: number): string {
    const date = new Date(timestamp);
    const pad = function(value: number): string { return String(value).padStart(2, '0'); };
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Opens the browser's native picker for a date/time input when it is available.
 * `showPicker` requires user activation, so this must run from a click handler.
 * @param {HTMLInputElement} input - Date/time input to open
 * @returns {void}
 */
function openNativePicker(input: HTMLInputElement): void {
    const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
    if (typeof pickerInput.showPicker === 'function') {
        try {
            pickerInput.showPicker();
            return;
        } catch {
            // Unsupported or blocked — fall back to focusing the field
        }
    }
    input.focus();
}

/**
 * Restricts the context-note time picker to the range that is rendered in order.
 * A note dated before the oldest loaded day could not be placed chronologically
 * without disturbing the pages fetched afterwards. A seeded time may legitimately
 * sit just before that day, so it lowers the bound.
 * @param {HTMLInputElement} input - Date/time input to constrain
 * @param {number} [extraMinimum] - Optional earliest time to allow
 * @returns {void}
 */
function updateContextTimestampBounds(input: HTMLInputElement, extraMinimum?: number): void {
    const oldestLoadedDay = loadedHistoryDays.size > 0
        ? Math.min(...Array.from(loadedHistoryDays))
        : Number.NEGATIVE_INFINITY;
    const minimum = extraMinimum === undefined
        ? oldestLoadedDay
        : Math.min(oldestLoadedDay, extraMinimum);

    if (!Number.isFinite(minimum)) {
        input.removeAttribute('min');
        return;
    }
    input.min = formatDateTimeLocalValue(minimum);
}

/**
 * Returns the first millisecond at or after a requested time that is not already
 * used by another item. The timestamp doubles as the storage file name, so a
 * collision would overwrite an existing message.
 * @param {number} timestamp - Requested timestamp
 * @returns {number} Unused timestamp
 */
function ensureUniqueContextTimestamp(timestamp: number): number {
    let candidate = timestamp;
    while (sessionTranslationTimestamps.includes(candidate)) {
        candidate += 1;
    }
    return candidate;
}

/**
 * Resolves the timestamp a context note should use.
 * @param {string} rawValue - Current value of the datetime-local input
 * @param {string} seededValue - Value the input was seeded with
 * @param {number} untouchedTimestamp - Time to use when the field was left alone
 * @param {number} minimumTimestamp - Earliest time that may be used
 * @returns {number} Validated, unused timestamp
 * @throws {Error} When the value is invalid, in the future, or before the minimum
 */
function resolveContextNoteTimestamp(
    rawValue: string,
    seededValue: string,
    untouchedTimestamp: number,
    minimumTimestamp: number
): number {
    // An untouched field keeps full precision; an explicit edit is truncated to
    // the minute by the input itself.
    const timestamp = rawValue && rawValue !== seededValue
        ? new Date(rawValue).getTime()
        : untouchedTimestamp;

    if (!Number.isFinite(timestamp)) {
        throw new Error('Please choose a valid time');
    }
    if (timestamp > Date.now()) {
        throw new Error('A context note cannot be dated in the future');
    }
    if (timestamp < minimumTimestamp) {
        throw new Error('That time is older than the loaded history. Scroll down to load more first.');
    }

    return ensureUniqueContextTimestamp(timestamp);
}

/**
 * Adds a context note to the current session without invoking an LLM.
 * The note becomes part of the conversation history used by every later request.
 * @param {string} text - Note text
 * @param {number} timestamp - When the note takes effect; must already be validated and unique
 * @returns {Promise<void>}
 * @throws {Error} If the note cannot be persisted
 */
async function addContextNote(text: string, timestamp: number): Promise<void> {
    // Reserve the timestamp before awaiting anything: callers check uniqueness
    // synchronously, so waiting here would let a concurrent add pick the same
    // millisecond and overwrite this note's file.
    if (!sessionTranslationTimestamps.includes(timestamp)) {
        sessionTranslationTimestamps.push(timestamp);
        sessionTranslationTimestamps.sort(function(a, b) { return b - a; });
        sessionActiveDays = groupTimestampsByDay(sessionTranslationTimestamps);
    }
    loadedHistoryDays.add(getDayStart(timestamp));

    const deviceId = await getDeviceId();

    const translation: Translation = {
        id: generateUuid(),
        deviceId: deviceId,
        pill: 'context',
        entries: [{
            source: text,
            intent: '',
            model: '',
            modelName: '',
            prompt: 'Context',
            promptContent: '',
            translation: '',
            explanation: '',
            nuances: '',
            reasoning: '',
            reasoningDetails: '',
            literalRetranslation: undefined,
            literalPending: false,
            wordDefinitions: undefined,
            wordData: undefined,
            wordPending: false,
            interpretation: undefined,
            interpretationPending: false
        }],
        activeEntryIndex: 0,
        timestamp: timestamp,
        status: 'complete',
        error: null
    };

    allTranslations = allTranslations.concat([translation])
        .sort(function(a, b) { return b.timestamp - a.timestamp; });

    const container = document.getElementById('translations-container');
    if (container) {
        renderTranslationItem(container, translation, 'chronological');
    }

    await saveSessionTranslation(currentSessionId, translation);
}

/**
 * Opens the modal used to add a context note, optionally back-dated.
 * The modal keeps its own draft and never touches the composition or intent
 * boxes, which belong to normal entry.
 * @param {number} [seedTimestamp] - Time to seed the picker with; defaults to now
 * @returns {Promise<void>}
 */
async function showContextNoteModal(seedTimestamp?: number): Promise<void> {
    if (!currentSessionId) {
        ui.displayError('Please select a conversation first');
        return;
    }
    if (contextNoteModalOpen) return;

    const template = document.getElementById('context-note-modal-template') as HTMLTemplateElement | null;
    if (!template) return;

    contextNoteModalOpen = true;

    const clone = template.content.cloneNode(true) as DocumentFragment;
    const modalEl = clone.firstElementChild as HTMLElement;
    document.body.appendChild(clone);

    const textInput = modalEl.querySelector('#context-note-text') as HTMLTextAreaElement | null;
    const timestampInput = modalEl.querySelector('#context-note-timestamp') as HTMLInputElement | null;
    const pickBtn = modalEl.querySelector('#context-note-pick-btn') as HTMLButtonElement | null;
    const nowBtn = modalEl.querySelector('#context-note-now-btn') as HTMLButtonElement | null;
    const addBtn = modalEl.querySelector('#context-note-add-btn') as HTMLButtonElement | null;

    const draftPath = 'drafts/' + currentSessionId + '/context';

    // Restore this modal's own draft; it is independent of the composition box
    const savedDraft = await readLocalFile(draftPath);
    if (textInput && savedDraft && savedDraft.trim()) {
        textInput.value = savedDraft;
    }

    let draftSaveTimeout: number | null = null;
    let noteSubmitted = false;

    /**
     * Writes the modal textarea to its draft file, removing the file when empty.
     * @returns {void}
     */
    function saveContextDraft(): void {
        const value = textInput?.value ?? '';
        const write = value.trim()
            ? writeLocalFile(draftPath, value)
            : deleteLocalFile(draftPath);
        write.catch(function(error: unknown) {
            console.error('[context] Failed to save context draft:', error);
        });
    }

    /**
     * Debounces the context draft save while the user types.
     * @returns {void}
     */
    function scheduleDraftSave(): void {
        if (draftSaveTimeout !== null) {
            clearTimeout(draftSaveTimeout);
        }
        draftSaveTimeout = window.setTimeout(function() {
            draftSaveTimeout = null;
            saveContextDraft();
        }, DRAFT_SAVE_DEBOUNCE_MS);
    }

    if (textInput) {
        textInput.addEventListener('input', scheduleDraftSave);
    }

    const seededTimestamp = seedTimestamp ?? Date.now();
    const seededTimestampValue = formatDateTimeLocalValue(seededTimestamp);
    if (timestampInput) {
        timestampInput.value = seededTimestampValue;
        updateContextTimestampBounds(timestampInput, seedTimestamp);
    }

    const modal = new Modal(modalEl);

    modalEl.addEventListener('shown.bs.modal', function() {
        textInput?.focus();
    });

    if (pickBtn && timestampInput) {
        pickBtn.addEventListener('click', function() {
            openNativePicker(timestampInput);
        });
    }

    if (nowBtn && timestampInput) {
        nowBtn.addEventListener('click', function() {
            timestampInput.value = formatDateTimeLocalValue(Date.now());
        });
    }

    if (addBtn) {
        addBtn.addEventListener('click', function() {
            const text = textInput?.value.trim() ?? '';
            if (!text) {
                ui.displayError('Please enter the context text');
                return;
            }

            // A seeded time was chosen deliberately (just before a message editing
            // session), so an untouched field must not fall back to now.
            const oldestLoadedDay = loadedHistoryDays.size > 0
                ? Math.min(...Array.from(loadedHistoryDays))
                : Number.NEGATIVE_INFINITY;
            const minimumTimestamp = seedTimestamp === undefined
                ? oldestLoadedDay
                : Math.min(oldestLoadedDay, seedTimestamp);

            let timestamp: number;
            try {
                timestamp = resolveContextNoteTimestamp(
                    timestampInput?.value ?? '',
                    seededTimestampValue,
                    seedTimestamp ?? Date.now(),
                    minimumTimestamp
                );
            } catch (error) {
                ui.displayError((error as Error).message);
                return;
            }

            // The note consumes the draft: stop the pending save so the close
            // handler cannot recreate the file we are about to delete.
            if (draftSaveTimeout !== null) {
                clearTimeout(draftSaveTimeout);
                draftSaveTimeout = null;
            }
            noteSubmitted = true;
            addBtn.disabled = true;

            modal.hide();

            addContextNote(text, timestamp).then(function() {
                deleteLocalFile(draftPath).catch(function(error: unknown) {
                    console.error('[context] Failed to clear context draft:', error);
                });
            }).catch(function(error: unknown) {
                console.error('[context] Failed to add note:', error);
                ui.displayError('Failed to save the context note');
                // Keep the text as a draft so the user does not lose it
                noteSubmitted = false;
                writeLocalFile(draftPath, text).catch(function() {});
            });
        });
    }

    modalEl.addEventListener('hidden.bs.modal', function() {
        if (draftSaveTimeout !== null) {
            clearTimeout(draftSaveTimeout);
            draftSaveTimeout = null;
        }
        // Cancelling keeps the draft; flush anything typed in the last debounce window
        if (!noteSubmitted) {
            saveContextDraft();
        }
        contextNoteModalOpen = false;
        modalEl.remove();
    });

    modal.show();
}

/**
 * Saves an edit to a context note in place.
 * The timestamp is deliberately unchanged: editing a note must not move it in the
 * conversation, unlike editing a message (which implies it was re-sent).
 * @param {string} translationId - ID of the context note to update
 * @returns {void}
 */
function saveContextEdit(translationId: string): void {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });
    if (!translation || translation.pill !== 'context') return;

    const refs = domRefsMap.get(translation);
    if (!refs) return;

    const newText = refs.editSource?.value.trim() ?? '';
    if (!newText) {
        ui.displayError('Context text cannot be empty');
        return;
    }

    ensureEntries(translation);
    const entry = translation.entries[translation.activeEntryIndex ?? 0];
    if (!entry) return;

    entry.source = newText;
    if (refs.editArea) refs.editArea.style.display = 'none';
    updateTranslationItem(translation);
    saveSessionTranslation(currentSessionId, translation);
}

/**
 * Refreshes the account balance display
 * @returns {Promise<void>}
 */
async function refreshBalance(): Promise<void> {
    if (!config || !config!.openRouterApiKey!) {
        return;
    }

    try {
        const { fetchBalance } = await import('./openrouter');
        const balanceInfo = await fetchBalance(config!.openRouterApiKey!);
        ui.updateBalanceDisplay("$" + (balanceInfo.totalCredits - balanceInfo.totalUsage).toFixed(2));
    } catch (error) {
        console.error("Failed to refresh balance:", error);
    }
}

/**
 * Sets up toggle visibility for explanation/nuances sections using captured DOM refs
 * @param {TranslationDomRefs} refs - Captured DOM references for the translation item
 * @param {Translation} translation - The translation object
 * @returns {void}
 */
function setupToggleHandler(refs: TranslationDomRefs, translation: Translation): void {
    if (refs.toggleSectionsBtn && refs.sectionsArea) {
        refs.toggleSectionsBtn.addEventListener('click', function() {
            const isCollapsed = refs.sectionsArea!.classList.contains('translation-sections-collapsed');
            if (isCollapsed) {
                refs.sectionsArea!.classList.remove('translation-sections-collapsed');
                refs.toggleSectionsBtn!.textContent = '▲';
                translation.sectionsCollapsed = false;
            } else {
                refs.sectionsArea!.classList.add('translation-sections-collapsed');
                refs.toggleSectionsBtn!.textContent = '▼';
                translation.sectionsCollapsed = true;
            }
            saveSessionTranslation(currentSessionId, translation);
        });
    }

    if (refs.toggleAnswerBtn && refs.targetEl) {
        refs.toggleAnswerBtn.addEventListener('click', function() {
            const isCollapsed = refs.targetEl!.classList.contains('answer-collapsed');
            if (isCollapsed) {
                refs.targetEl!.classList.remove('answer-collapsed');
                refs.toggleAnswerBtn!.textContent = '▲';
                translation.answerCollapsed = false;
                // Show side-toolbar buttons when expanding, if translation is complete with content
                const entryTranslation2 = translation.entries[translation.activeEntryIndex ?? 0]?.translation ?? '';
                if (translation.status === 'complete' && /\S/.test(entryTranslation2)) {
                    if (refs.regenerateAnswerBtn) refs.regenerateAnswerBtn.style.display = 'inline-block';
                    if (refs.copyAnswerBtn) refs.copyAnswerBtn.style.display = 'inline-block';
                    if (refs.saveAnswerBtn) refs.saveAnswerBtn.style.display = 'inline-block';
                }
            } else {
                refs.targetEl!.classList.add('answer-collapsed');
                refs.toggleAnswerBtn!.textContent = '▼';
                translation.answerCollapsed = true;
                // Hide side-toolbar buttons when collapsing
                if (refs.regenerateAnswerBtn) refs.regenerateAnswerBtn.style.display = 'none';
                if (refs.copyAnswerBtn) refs.copyAnswerBtn.style.display = 'none';
                if (refs.saveAnswerBtn) refs.saveAnswerBtn.style.display = 'none';
            }
            saveSessionTranslation(currentSessionId, translation);
        });
    }
}

/**
 * Maps a pill type to the ID of the template that renders it.
 * @param {Translation['pill']} pill - Pill type of the item
 * @returns {string} Template element ID
 */
function getItemTemplateId(pill: Translation['pill']): string {
    if (pill === 'question') return 'question-item-template';
    if (pill === 'input') return 'input-item-template';
    if (pill === 'context') return 'context-item-template';
    return 'translation-item-template';
}

/**
 * Inserts an item at its chronological slot in the rendered list.
 * The container runs newest at the top, so the item goes before the first older
 * item, or is appended when it is the oldest rendered item.
 * @param {HTMLElement} container - Container holding the rendered items
 * @param {HTMLElement} element - Item element being inserted
 * @param {Translation} translation - Translation the element renders
 * @returns {void}
 */
function insertItemChronologically(container: HTMLElement, element: HTMLElement, translation: Translation): void {
    const index = allTranslations.findIndex(function(t) { return t.id === translation.id; });
    const nextOlder = index >= 0 ? allTranslations[index + 1] : undefined;
    const anchor = nextOlder ? document.getElementById('translation-' + nextOlder.id) : null;
    if (anchor) {
        container.insertBefore(element, anchor);
    } else {
        container.appendChild(element);
    }
}

/**
 * Renders a single translation item, creating or updating DOM element.
 * Captures all dynamic child element references once during creation and stores them
 * in domRefsMap for efficient subsequent updates.
 * @param {HTMLElement} container - Container element
 * @param {Translation} translation - Translation object
 * @param {'top' | 'bottom' | 'chronological'} [insertPosition='top'] - Where a newly created item is inserted
 * @returns {void}
 */
function renderTranslationItem(container: HTMLElement, translation: Translation, insertPosition: 'top' | 'bottom' | 'chronological' = 'top'): void {
    const elementId = 'translation-' + translation.id;
    let element = document.getElementById(elementId);

    if (element) {
        const existingRefs = domRefsMap.get(translation);
        if (!existingRefs) {
            element.remove();
            element = null;
        }
    }

    if (!element) {
        const templateId = getItemTemplateId(translation.pill);
        const template = document.getElementById(templateId) as HTMLTemplateElement | null;
        if (!template) {
            return;
        }

        const clone = template.content.cloneNode(true) as DocumentFragment;
        element = clone.firstElementChild as HTMLElement;
        element.id = elementId;
        element.dataset.pill = translation.pill;

        // Make pane and tab IDs unique per translation item
        const literalPane = element.querySelector('#literal-pane');
        const explanationPane = element.querySelector('#explanation-pane');
        const nuancesPane = element.querySelector('#nuances-pane');
        const wordsPane = element.querySelector('#words-pane');
        const interpretationPane = element.querySelector('#interpretation-pane');
        const literalTab = element.querySelector('#literal-tab');
        const explanationTab = element.querySelector('#explanation-tab');
        const nuancesTab = element.querySelector('#nuances-tab');
        const wordsTab = element.querySelector('#words-tab');
        const interpretationTab = element.querySelector('#interpretation-tab');

        if (literalPane) literalPane.id = 'literal-pane-' + translation.id;
        if (explanationPane) explanationPane.id = 'explanation-pane-' + translation.id;
        if (nuancesPane) nuancesPane.id = 'nuances-pane-' + translation.id;
        if (wordsPane) wordsPane.id = 'words-pane-' + translation.id;
        if (interpretationPane) interpretationPane.id = 'interpretation-pane-' + translation.id;
        if (literalTab) {
            literalTab.id = 'literal-tab-' + translation.id;
            literalTab.setAttribute('data-bs-target', '#literal-pane-' + translation.id);
        }
        if (explanationTab) {
            explanationTab.id = 'explanation-tab-' + translation.id;
            explanationTab.setAttribute('data-bs-target', '#explanation-pane-' + translation.id);
        }
        if (nuancesTab) {
            nuancesTab.id = 'nuances-tab-' + translation.id;
            nuancesTab.setAttribute('data-bs-target', '#nuances-pane-' + translation.id);
        }
        if (wordsTab) {
            wordsTab.id = 'words-tab-' + translation.id;
            wordsTab.setAttribute('data-bs-target', '#words-pane-' + translation.id);
            wordsTab.setAttribute('aria-controls', 'words-pane-' + translation.id);
        }
        if (interpretationTab) {
            interpretationTab.id = 'interpretation-tab-' + translation.id;
            interpretationTab.setAttribute('data-bs-target', '#interpretation-pane-' + translation.id);
            interpretationTab.setAttribute('aria-controls', 'interpretation-pane-' + translation.id);
        }

        // Capture all dynamic child element references once
        /** @type {TranslationDomRefs} */
        const refs: TranslationDomRefs = {
            element: element,
            sourceEl: element.querySelector('.translation-source') as HTMLElement | null,
            targetEl: element.querySelector('.translation-target') as HTMLElement | null,
            thinkingEl: element.querySelector('.translation-thinking') as HTMLElement | null,
            thinkingContentEl: element.querySelector('.thinking-content') as HTMLElement | null,
            literalEl: element.querySelector('.translation-literal') as HTMLElement | null,
            explanationEl: element.querySelector('.translation-explanation') as HTMLElement | null,
            nuancesEl: element.querySelector('.translation-nuances') as HTMLElement | null,
            interpretationEl: element.querySelector('.translation-interpretation') as HTMLElement | null,
            interpretationMarkdownEl: element.querySelector('.interpretation-markdown') as HTMLElement | null,
            interpretationRawEl: element.querySelector('.interpretation-raw') as HTMLElement | null,
            interpretationThinkingEl: interpretationPane?.querySelector('.translation-thinking') as HTMLElement | null,
            interpretationThinkingContentEl: interpretationPane?.querySelector('.thinking-content') as HTMLElement | null,
            interpretationFollowupEl: element.querySelector('.interpretation-followup') as HTMLElement | null,
            interpretationFollowupHistoryEl: element.querySelector('.interpretation-followup-history') as HTMLElement | null,
            interpretationFollowupThinkingEl: element.querySelector('.interpretation-followup-thinking') as HTMLElement | null,
            interpretationFollowupThinkingContentEl: element.querySelector('.interpretation-followup-thinking-content') as HTMLElement | null,
            interpretationFollowupInputEl: element.querySelector('.interpretation-followup-input') as HTMLTextAreaElement | null,
            interpretationFollowupAskBtn: element.querySelector('.interpretation-followup-ask-btn') as HTMLButtonElement | null,
            spinnerEl: element.querySelector('.translation-spinner') as HTMLElement | null,
            errorEl: element.querySelector('.translation-error') as HTMLElement | null,
            errorMessageEl: element.querySelector('.error-message') as HTMLElement | null,
            promptEl: element.querySelector('.translation-prompt') as HTMLElement | null,
            modelNameEl: element.querySelector('.translation-model-name') as HTMLElement | null,
            charCountEl: element.querySelector('.translation-char-count') as HTMLElement | null,
            sectionsArea: element.querySelector('.translation-sections-area') as HTMLElement | null,
            toggleSectionsBtn: element.querySelector('.toggle-sections-btn') as HTMLButtonElement | null,
            toggleAnswerBtn: element.querySelector('.toggle-answer-btn') as HTMLButtonElement | null,
            retryBtn: element.querySelector('.retry-btn') as HTMLButtonElement | null,
            regenerateTranslationBtn: element.querySelector('.regenerate-translation-btn') as HTMLButtonElement | null,
            regenerateLiteralBtn: element.querySelector('.regenerate-literal-btn') as HTMLButtonElement | null,
            regenerateInterpretationBtn: element.querySelector('.regenerate-interpretation-btn') as HTMLButtonElement | null,
            regenerateAnswerBtn: element.querySelector('.regenerate-answer-btn') as HTMLButtonElement | null,
            stopGenerationBtn: element.querySelector('.stop-generation-btn') as HTMLButtonElement | null,
            copySourceBtn: element.querySelector('.copy-source-btn') as HTMLButtonElement | null,
            copyTargetBtn: element.querySelector('.copy-target-btn') as HTMLButtonElement | null,
            copyAnswerBtn: element.querySelector('.copy-answer-btn') as HTMLButtonElement | null,
            saveAnswerBtn: element.querySelector('.save-answer-btn') as HTMLButtonElement | null,
            retranslationTabsEl: element.querySelector('.retranslation-tabs') as HTMLElement | null,
            wordsTab: element.querySelector('#words-tab-' + translation.id) as HTMLElement | null,
            wordsContent: element.querySelector('.translation-words') as HTMLElement | null,
            editArea: element.querySelector('.translation-edit-area') as HTMLElement | null,
            editSource: element.querySelector('.translation-edit-source') as HTMLTextAreaElement | null,
            editIntent: element.querySelector('.translation-edit-intent') as HTMLTextAreaElement | null,
            retranslateBtn: element.querySelector('.retranslate-btn') as HTMLButtonElement | null,
            addContextBtn: element.querySelector('.add-context-from-edit-btn') as HTMLButtonElement | null,
            editToggleBtn: element.querySelector('.edit-toggle-btn') as HTMLButtonElement | null,
            quickQuestionBtn: element.querySelector('.quick-question-btn') as HTMLButtonElement | null,
            includeInContextToggle: element.querySelector('.include-in-context-toggle') as HTMLInputElement | null
        };
        domRefsMap.set(translation, refs);

        // Wire retry button
        if (refs.retryBtn) {
            const translationId = translation.id;
            refs.retryBtn.addEventListener('click', function() {
                retryTranslation(translationId);
            });
        }

        // Wire delete button
        const deleteBtn = element.querySelector('.delete-translation-btn') as HTMLButtonElement | null;
        if (deleteBtn) {
            const translationId = translation.id;
            deleteBtn.addEventListener('click', function() {
                deleteTranslation(translationId);
            });
        }

        // Wire save button for context note edits
        const saveContextBtn = element.querySelector('.save-context-btn') as HTMLButtonElement | null;
        if (saveContextBtn) {
            const translationId = translation.id;
            saveContextBtn.addEventListener('click', function() {
                saveContextEdit(translationId);
            });
        }

        // Wire copy source button
        if (refs.copySourceBtn) {
            const translationId = translation.id;
            refs.copySourceBtn.addEventListener('click', function() {
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const src = t.entries?.[t.activeEntryIndex ?? 0]?.source ?? (t as any).source ?? '';
                navigator.clipboard.writeText(src).catch(function() {
                    console.log('Failed to copy source text');
                });
            });
        }

        // Wire copy target button
        if (refs.copyTargetBtn) {
            const translationId = translation.id;
            refs.copyTargetBtn.addEventListener('click', function() {
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const txt = t.entries?.[t.activeEntryIndex ?? 0]?.translation ?? (t as any).translation ?? '';
                navigator.clipboard.writeText(txt).catch(function() {
                    console.log('Failed to copy translation text');
                });
            });
        }

        // Wire copy answer button
        if (refs.copyAnswerBtn) {
            const translationId = translation.id;
            refs.copyAnswerBtn.addEventListener('click', function() {
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const txt = t.entries?.[t.activeEntryIndex ?? 0]?.translation ?? (t as any).translation ?? '';
                navigator.clipboard.writeText(txt).catch(function() {
                    console.log('Failed to copy answer text');
                });
            });
        }

        // Wire save answer button
        if (refs.saveAnswerBtn) {
            const translationId = translation.id;
            refs.saveAnswerBtn.addEventListener('click', function() {
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const txt = t.entries?.[t.activeEntryIndex ?? 0]?.translation ?? (t as any).translation ?? '';
                if (!txt) return;
                const blob = new Blob([txt], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'answer.md';
                a.click();
                URL.revokeObjectURL(url);
            });
        }

        // Wire retranslate button
        if (refs.retranslateBtn) {
            refs.retranslateBtn.addEventListener('click', function() {
                const newSource = refs.editSource?.value.trim() ?? '';
                if (!newSource) {
                    ui.displayError("Source text cannot be empty");
                    return;
                }
                if (refs.editArea) refs.editArea.style.display = 'none';
                if (translation.pill === 'question') {
                    ensureEntries(translation);
                    const entry = translation.entries[translation.activeEntryIndex ?? 0];
                    if (entry) entry.source = newSource;
                    retryTranslation(translation.id);
                } else {
                    const newIntent = refs.editIntent?.value.trim() ?? '';
                    retranslateFromEdit(translation.id, newSource, newIntent);
                }
            });
        }

        // Wire add-context button in the edit area: seeds the note just before this message
        if (refs.addContextBtn) {
            const seedTimestamp = translation.timestamp - 1000;
            refs.addContextBtn.addEventListener('click', function() {
                if (refs.editArea) refs.editArea.style.display = 'none';
                void showContextNoteModal(seedTimestamp);
            });
        }

        // Wire edit toggle button
        if (refs.editToggleBtn && refs.editArea) {
            refs.editToggleBtn.addEventListener('click', function() {
                ensureEntries(translation);
                const activeEntry = translation.entries[translation.activeEntryIndex ?? 0];
                if (refs.editSource) refs.editSource.value = activeEntry?.source ?? (translation as any).source ?? '';
                if (refs.editIntent) refs.editIntent.value = activeEntry?.intent ?? (translation as any).intent ?? '';
                if (refs.editArea!.style.display === 'none') {
                    refs.editArea!.style.display = 'block';
                } else {
                    refs.editArea!.style.display = 'none';
                }
            });
        }

        // Wire quick question button on input items
        if (refs.quickQuestionBtn && translation.pill === 'input') {
            const translationId = translation.id;
            refs.quickQuestionBtn.addEventListener('click', function() {
                if (quickQuestionModalOpen) return;
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const entry = t.entries[t.activeEntryIndex ?? 0];
                const sourceText = entry?.source ?? (t as any).source ?? '';
                showQuickQuestionModal({
                    kind: 'sourceMessage',
                    sourceText: sourceText,
                    systemPrompt: QUICK_QUESTION_MESSAGE_PROMPT,
                    placeholderQuestion: 'What are the nuances of this message?'
                });
            });
        }

        // Wire quick question button on output (translation) items
        if (refs.quickQuestionBtn && translation.pill === 'output') {
            const translationId = translation.id;
            refs.quickQuestionBtn.addEventListener('click', function() {
                if (quickQuestionModalOpen) return;
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const entry = t.entries[t.activeEntryIndex ?? 0];
                const sourceText = entry?.source ?? (t as any).source ?? '';
                const targetText = entry?.translation ?? (t as any).translation ?? '';
                showQuickQuestionModal({
                    kind: 'translation',
                    sourceText: sourceText,
                    intentText: entry.intent ?? '',
                    translationText: targetText,
                    systemPrompt: QUICK_QUESTION_TRANSLATION_PROMPT,
                    placeholderQuestion: 'What are the nuances of this message?',
                    prefillQuestion: cachedTranslationQuickQuestion ?? undefined
                });
            });
        }

        // Wire quick question button on context notes
        if (refs.quickQuestionBtn && translation.pill === 'context') {
            const translationId = translation.id;
            refs.quickQuestionBtn.addEventListener('click', function() {
                if (quickQuestionModalOpen) return;
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const entry = t.entries[t.activeEntryIndex ?? 0];
                const noteText = entry?.source ?? (t as any).source ?? '';
                showQuickQuestionModal({
                    kind: 'contextNote',
                    sourceText: noteText,
                    systemPrompt: QUICK_QUESTION_NOTE_PROMPT,
                    placeholderQuestion: 'What implications does this have?'
                });
            });
        }

        // Wire the inline interpretation follow-up
        const followupInput = refs.interpretationFollowupInputEl;
        const followupAskBtn = refs.interpretationFollowupAskBtn;
        if (followupAskBtn && followupInput) {
            const followupChain: Array<{question: string; answer: string}> = [];
            followupAskBtn.addEventListener('click', function() {
                const questionText = followupInput.value.trim() || followupInput.placeholder || 'Tell me more.';
                void askInterpretationFollowup(translation, questionText, followupChain);
            });
        }

        // Wire regenerate translation button
        if (refs.regenerateTranslationBtn) {
            const translationId = translation.id;
            refs.regenerateTranslationBtn.addEventListener('click', function() {
                regenerateTranslationById(translationId);
            });
        }

        // Wire regenerate literal button
        if (refs.regenerateLiteralBtn) {
            const translationId = translation.id;
            refs.regenerateLiteralBtn.addEventListener('click', function() {
                regenerateIndependentSections(translationId);
            });
        }

        // Wire regenerate interpretation button
        if (refs.regenerateInterpretationBtn) {
            const translationId = translation.id;
            refs.regenerateInterpretationBtn.addEventListener('click', function() {
                regenerateInterpretation(translationId);
            });
        }

        // Wire regenerate answer button
        if (refs.regenerateAnswerBtn) {
            const translationId = translation.id;
            refs.regenerateAnswerBtn.addEventListener('click', function() {
                retryTranslation(translationId);
            });
        }

        // Wire stop generation button
        if (refs.stopGenerationBtn) {
            const translationId = translation.id;
            refs.stopGenerationBtn.addEventListener('click', function() {
                stopGeneration(translationId);
            });
        }

        setupToggleHandler(refs, translation);

        // Wire include-in-context toggle for questions
        if (translation.pill === 'question' && refs.includeInContextToggle) {
            refs.includeInContextToggle.checked = translation.includeInContext === true;
            refs.includeInContextToggle.addEventListener('change', function() {
                translation.includeInContext = refs.includeInContextToggle!.checked;
                saveSessionTranslation(currentSessionId, translation);
            });
        }

        // Initially hide retranslation tabs
        if (refs.retranslationTabsEl) {
            refs.retranslationTabsEl.style.display = 'none';
        }

        if (insertPosition === 'bottom') {
            container.appendChild(element);
        } else if (insertPosition === 'chronological') {
            insertItemChronologically(container, element, translation);
        } else {
            container.insertBefore(element, container.firstChild);
        }
    }

    const refs = domRefsMap.get(translation);
    if (!refs) return;

    // Wire words tab click handler (runs once when element is first added to DOM)
    if (refs.wordsTab && refs.wordsContent && !element.dataset.wordsHandler) {
        refs.wordsTab.addEventListener('click', function() {
            ensureEntries(translation);
            console.log('[WordsTab] Clicked, wordData:', translation.entries?.[translation.activeEntryIndex ?? 0]?.wordData?.length, 'wordPending:', translation.entries?.[translation.activeEntryIndex ?? 0]?.wordPending);
            renderWordContent(refs.wordsContent!, translation);
        });
        element.dataset.wordsHandler = 'true';
    }

    updateTranslationItemContent(translation, refs);
}

/**
 * Looks up the captured DOM refs for a translation and updates the item's DOM.
 * This is the public wrapper that auto-resolves refs from the domRefsMap.
 * @param {Translation} translation - Translation object with updated data
 * @returns {void}
 */
function updateTranslationItem(translation: Translation): void {
    const refs = domRefsMap.get(translation);
    if (refs) {
        updateTranslationItemContent(translation, refs);
    }
}

/**
 * Updates an existing translation item's dynamic fields in the DOM using captured DOM refs.
 * Does NOT create elements - use renderTranslationItem for that.
 * For streaming state, use setupStreamingDisplay/computeStreamingDisplay/paintStreamingContent/teardownStreamingDisplay instead.
 * @param {Translation} translation - Translation object with updated data
 * @param {TranslationDomRefs} refs - Captured DOM references for this translation item
 * @returns {void}
 */
function updateTranslationItemContent(translation: Translation, refs: TranslationDomRefs): void {
    refs.element.dataset.pill = translation.pill;

    ensureEntries(translation);
    const entry = translation.entries[translation.activeEntryIndex ?? 0];

    const entrySource = entry?.source ?? (translation as any).source ?? '';
    const entryTranslation = entry?.translation ?? (translation as any).translation ?? '';
    const entryExplanation = entry?.explanation ?? (translation as any).explanation ?? '';
    const entryNuances = entry?.nuances ?? (translation as any).nuances ?? '';
    const literalEntry = (translation.pill === 'input' && translation.entries.length > 0)
        ? translation.entries[0]
        : entry;
    const entryLiteralRetranslation = literalEntry?.literalRetranslation;
    const entryLiteralPending = literalEntry?.literalPending ?? false;
    const entryInterpretation = entry?.interpretation;
    const entryInterpretationPending = entry?.interpretationPending ?? false;
    const entryPrompt = entry?.prompt ?? (translation as any).prompt ?? '';
    const entryModelName = entry?.modelName ?? (translation as any).modelName ?? '';
    const entryWordData = literalEntry?.wordData ?? (translation as any).wordData;
    const entryWordPending = literalEntry?.wordPending ?? false;

    if (refs.sourceEl) {
        refs.sourceEl.innerHTML = renderMarkdown(normalizeForMarkdown(entrySource));
    }
    if (refs.promptEl) {
        refs.promptEl.textContent = entryPrompt;
    }
    if (refs.modelNameEl) {
        refs.modelNameEl.textContent = entryModelName;
    }

    // Build retranslation tabs (entries > 1)
    if (refs.retranslationTabsEl) {
        refs.retranslationTabsEl.innerHTML = '';
        if (translation.entries.length <= 1) {
            refs.retranslationTabsEl.style.display = 'none';
        } else {
            refs.retranslationTabsEl.style.display = '';
            const idx = translation.activeEntryIndex ?? 0;
            const ul = document.createElement('ul');
            ul.className = 'nav nav-tabs';
            ul.role = 'tablist';
            for (let i = 0; i < translation.entries.length; i++) {
                const li = document.createElement('li');
                li.className = 'nav-item';
                li.role = 'presentation';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'nav-link' + (i === idx ? ' active' : '');
                btn.role = 'tab';
                btn.textContent = getModelShortName(translation.entries[i].modelName);
                const translationId = translation.id;
                const entryIndex = i;
                btn.addEventListener('click', function() {
                    switchTranslationEntry(translationId, entryIndex);
                });
                li.appendChild(btn);
                ul.appendChild(li);
            }
            refs.retranslationTabsEl.appendChild(ul);
        }
    }

    if (translation.status === 'pending') {
        if (refs.spinnerEl) refs.spinnerEl.style.display = 'block';
        if (refs.errorEl) refs.errorEl.style.display = 'none';
        if (refs.targetEl) refs.targetEl.innerHTML = '';
        if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
        if (refs.regenerateAnswerBtn) refs.regenerateAnswerBtn.style.display = 'none';
        if (refs.copyAnswerBtn) refs.copyAnswerBtn.style.display = 'none';
        if (refs.saveAnswerBtn) refs.saveAnswerBtn.style.display = 'none';
        if (refs.stopGenerationBtn) refs.stopGenerationBtn.style.display = 'none';
        if (refs.charCountEl) {
            refs.charCountEl.textContent = `(${entrySource.length}/—)`;
        }
    } else if (translation.status === 'streaming') {
        if (refs.spinnerEl) refs.spinnerEl.style.display = 'none';
        if (refs.errorEl) refs.errorEl.style.display = 'none';
        if (refs.stopGenerationBtn) refs.stopGenerationBtn.style.display = 'inline-block';
        if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
        if (refs.regenerateAnswerBtn) refs.regenerateAnswerBtn.style.display = 'none';
        if (refs.copyAnswerBtn) refs.copyAnswerBtn.style.display = 'none';
        if (refs.saveAnswerBtn) refs.saveAnswerBtn.style.display = 'none';
        if (refs.charCountEl) {
            refs.charCountEl.textContent = `(${entrySource.length}/—)`;
        }

        // Update auxiliary sections during streaming so background task results appear
        if (refs.literalEl) {
            const literalStreamState = literalStreamingStateMap.get(translation);
            if (literalStreamState) {
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
            } else if (entryLiteralPending) {
                refs.literalEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Retranslating...</span>';
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
            } else if (entryLiteralRetranslation) {
                refs.literalEl.innerHTML = renderMarkdown(entryLiteralRetranslation);
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
            } else {
                refs.literalEl.innerHTML = '';
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
            }
        }
        if (refs.explanationEl) {
            refs.explanationEl.innerHTML = entryExplanation ? renderMarkdown(entryExplanation) : '';
        }
        if (refs.nuancesEl) {
            refs.nuancesEl.innerHTML = entryNuances ? renderMarkdown(entryNuances) : '';
        }
        if (refs.interpretationEl) {
            if (entryInterpretationPending && !entryInterpretation) {
                paintInterpretationHtml(translation, refs, INTERPRETATION_SPINNER_HTML);
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = 'none';
            } else if (entryInterpretation) {
                paintInterpretationHtml(translation, refs, renderMarkdown(entryInterpretation));
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            } else {
                paintInterpretationHtml(translation, refs, '');
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            }
        }
        if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
        if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = 'none';
        if (refs.sectionsArea && refs.toggleSectionsBtn) {
            if (translation.sectionsCollapsed) {
                refs.sectionsArea.classList.add('translation-sections-collapsed');
                refs.toggleSectionsBtn.textContent = '▼';
            } else {
                refs.sectionsArea.classList.remove('translation-sections-collapsed');
                refs.toggleSectionsBtn.textContent = '▲';
            }
        }
    } else if (translation.status === 'error') {
        if (refs.spinnerEl) refs.spinnerEl.style.display = 'none';
        if (refs.targetEl) refs.targetEl.innerHTML = '';
        if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
        if (refs.regenerateAnswerBtn) refs.regenerateAnswerBtn.style.display = translation.pill === 'question' ? 'inline-block' : 'none';
        if (refs.copyAnswerBtn) refs.copyAnswerBtn.style.display = translation.pill === 'question' ? 'inline-block' : 'none';
        if (refs.saveAnswerBtn) refs.saveAnswerBtn.style.display = translation.pill === 'question' ? 'inline-block' : 'none';
        if (refs.stopGenerationBtn) refs.stopGenerationBtn.style.display = 'none';
        if (refs.charCountEl) {
            refs.charCountEl.textContent = `(${entrySource.length}/—)`;
        }
        if (refs.errorEl) {
            refs.errorEl.style.display = 'block';
            if (refs.errorMessageEl) {
                refs.errorMessageEl.textContent = translation.error ?? "Translation failed";
            }
        }
    } else {
        // 'complete' status
        if (refs.spinnerEl) refs.spinnerEl.style.display = 'none';
        if (refs.errorEl) refs.errorEl.style.display = 'none';
        if (refs.stopGenerationBtn) refs.stopGenerationBtn.style.display = 'none';
        if (refs.targetEl) {
            if (!/\S/.test(entryTranslation)) {
                refs.targetEl.innerHTML = '';
                if (refs.errorEl) {
                    refs.errorEl.style.display = 'block';
                    if (refs.errorMessageEl) refs.errorMessageEl.textContent = 'Translation returned empty content. Try again.';
                }
                if (refs.charCountEl) refs.charCountEl.textContent = `(${entrySource.length}/0)`;
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
            } else if (translation.pill === 'question') {
                refs.targetEl.innerHTML = renderMarkdown(entryTranslation);
                if (refs.regenerateAnswerBtn) refs.regenerateAnswerBtn.style.display = 'inline-block';
                if (refs.copyAnswerBtn) refs.copyAnswerBtn.style.display = 'inline-block';
                if (refs.saveAnswerBtn) refs.saveAnswerBtn.style.display = 'inline-block';
                if (translation.answerCollapsed) {
                    refs.targetEl.classList.add('answer-collapsed');
                    if (refs.toggleAnswerBtn) refs.toggleAnswerBtn.textContent = '▼';
                    if (refs.regenerateAnswerBtn) refs.regenerateAnswerBtn.style.display = 'none';
                    if (refs.copyAnswerBtn) refs.copyAnswerBtn.style.display = 'none';
                    if (refs.saveAnswerBtn) refs.saveAnswerBtn.style.display = 'none';
                } else {
                    refs.targetEl.classList.remove('answer-collapsed');
                    if (refs.toggleAnswerBtn) refs.toggleAnswerBtn.textContent = '▲';
                }
            } else {
                refs.targetEl.innerHTML = renderMarkdown(normalizeForMarkdown(entryTranslation));
            }
        }
        if (refs.charCountEl) {
            refs.charCountEl.textContent = `(${entrySource.length}/${entryTranslation.length})`;
        }

        if (refs.literalEl) {
            const literalStreamState = literalStreamingStateMap.get(translation);
            if (literalStreamState) {
                // Literal streaming is active; DOM is managed by streaming callbacks
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
            } else if (entryLiteralPending) {
                refs.literalEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Retranslating...</span>';
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
            } else if (entryLiteralRetranslation) {
                refs.literalEl.innerHTML = renderMarkdown(entryLiteralRetranslation);
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
            } else {
                refs.literalEl.innerHTML = '';
                if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
            }
        }
        if (refs.explanationEl) {
            refs.explanationEl.innerHTML = entryExplanation ? renderMarkdown(entryExplanation) : '';
        }
        if (refs.nuancesEl) {
            refs.nuancesEl.innerHTML = entryNuances ? renderMarkdown(entryNuances) : '';
        }

        if (refs.interpretationEl) {
            if (entryInterpretationPending && !entryInterpretation) {
                paintInterpretationHtml(translation, refs, INTERPRETATION_SPINNER_HTML);
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = 'none';
            } else if (entryInterpretation) {
                paintInterpretationHtml(translation, refs, renderMarkdown(entryInterpretation));
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            } else {
                paintInterpretationHtml(translation, refs, '');
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            }
        }

        if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
        if (refs.regenerateInterpretationBtn && !entryInterpretationPending) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';

        if (refs.sectionsArea && refs.toggleSectionsBtn) {
            if (translation.sectionsCollapsed) {
                refs.sectionsArea.classList.add('translation-sections-collapsed');
                refs.toggleSectionsBtn.textContent = '▼';
            } else {
                refs.sectionsArea.classList.remove('translation-sections-collapsed');
                refs.toggleSectionsBtn.textContent = '▲';
            }
        }
    }

    if (refs.wordsTab) {
        const wordsPane = refs.element.querySelector('#words-pane-' + translation.id) as HTMLElement | null;
        if (wordsPane && refs.wordsContent && wordsPane.classList.contains('active')) {
            refs.wordsContent.innerHTML = '';
            renderWordContent(refs.wordsContent, translation);
        }
    }

    updateInterpretationFollowupContent(translation, refs, entryInterpretation, entryInterpretationPending);
}

/**
 * Renders all translations in the single pane, sorted by timestamp descending
 * @returns {void}
 */
export function renderAllTranslations(): void {
    const container = document.getElementById('translations-container');
    if (!container) {
        return;
    }

    const sorted = [...allTranslations].sort(function(a, b) { return b.timestamp - a.timestamp; });
    const neededIds = new Set(sorted.map(function(t) { return 'translation-' + t.id; }));

    const existing = container.querySelectorAll('.translation-item');
    existing.forEach(function(el) {
        if (!neededIds.has(el.id)) {
            el.remove();
        }
    });

    const oldestFirst = [...sorted].reverse();
    for (const translation of oldestFirst) {
        renderTranslationItem(container, translation);
    }
}

/**
 * Renders translations for the specified pane (legacy, redirects to renderAllTranslations)
 * @param {'input' | 'output'} _pill - Ignored
 * @returns {void}
 */
export function renderTranslations(_pill: 'input' | 'output'): void {
    renderAllTranslations();
}

/**
 * Retries a failed translation
 * @param {string} translationId - ID of translation to retry
 * @returns {Promise<void>}
 */
export async function retryTranslation(translationId: string): Promise<void> {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });

    if (!translation) {
        return;
    }

    // Only messages and questions have an LLM flow to retry
    if (translation.pill !== 'input' && translation.pill !== 'output' && translation.pill !== 'question') {
        return;
    }

    // Abort any existing stream for this translation
    const existingStreamState = streamingStateMap.get(translation);
    if (existingStreamState) {
        existingStreamState.abort();
        streamingStateMap.delete(translation);
    }

    ensureEntries(translation);
    const activeIdx = translation.activeEntryIndex ?? 0;
    const entry = translation.entries[activeIdx];
    if (!entry) return;

    translation.status = 'streaming';
    translation.error = null;
    translation.entries[activeIdx].wordDefinitions = undefined;
    translation.entries[activeIdx].wordData = undefined;
    translation.entries[activeIdx].wordPending = false;
    renderAllTranslations();

    const session = await loadSession(currentSessionId);
    const effectiveModel = getTranslationModelToUse(session);
    if (!config || !effectiveModel || !config!.openRouterApiKey!) {
        ui.displayError("Cannot retry: no model selected or no API key");
        return;
    }

    const reasoningLevel = getTranslationReasoningToUse(session);

    if (translation.pill === 'question') {
        const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
        const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';
        const questionModel = getQuestionModelToUse(session);
        const questionReasoning = getQuestionReasoningToUse(session);
        if (!questionModel) {
            ui.displayError('No model configured for question');
            return;
        }
        console.log(`[retryTranslation] Re-asking question with model: ${questionModel}, chars: ${entry.source.length}`);
        const userMessage = await buildQuestionMessage(entry.source, myLangName);

        // Delegate to question streaming handler
        await handleQuestionStreaming(translation, userMessage, questionModel, questionReasoning);
        return;
    }

    console.log(`[retryTranslation] Retrying translation with model: ${effectiveModel}, mode: ${translation.pill}`);

    const systemPrompt = translation.pill === 'input' ? INPUT_SYSTEM_PROMPT : OUTPUT_SYSTEM_PROMPT;

    // Delegate to streaming handler with timestamp rename and no background tasks
    await handleTranslateStreaming(
        translation,
        translation.pill,
        systemPrompt,
        effectiveModel,
        reasoningLevel,
        {
            oldTimestampToDelete: translation.timestamp,
            skipBackgroundTasks: true
        }
    );
}

/**
 * Deletes a translation from the session history
 * @param {string} translationId - ID of translation to delete
 * @returns {Promise<void>}
 */
export async function deleteTranslation(translationId: string): Promise<void> {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });
    if (!translation) return;

    const element = document.getElementById('translation-' + translationId);
    if (element) element.remove();

    const idx = allTranslations.indexOf(translation);
    if (idx !== -1) allTranslations.splice(idx, 1);

    const timestampIdx = sessionTranslationTimestamps.indexOf(translation.timestamp);
    if (timestampIdx !== -1) sessionTranslationTimestamps.splice(timestampIdx, 1);

    await deleteSessionTranslation(currentSessionId, translation.timestamp);

    // A deleted item may have been the only one on its day
    sessionActiveDays = groupTimestampsByDay(sessionTranslationTimestamps);
}

/**
 * Regenerates a translation for input mode (updates existing in place)
 * @param {string} translationId - ID of translation to regenerate
 * @returns {Promise<void>}
 */
async function regenerateTranslationById(translationId: string): Promise<void> {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });
    if (!translation || translation.pill !== 'input') {
        return;
    }

    // Abort any existing stream
    const existingStreamState = streamingStateMap.get(translation);
    if (existingStreamState) {
        existingStreamState.abort();
        streamingStateMap.delete(translation);
    }

    ensureEntries(translation);
    const activeIdx = translation.activeEntryIndex ?? 0;
    const currentEntry = translation.entries[activeIdx];
    if (!currentEntry) return;

    // Create the new entry entry with current source and intent
    const newEntry: TranslationEntry = {
        source: currentEntry.source,
        intent: currentEntry.intent,
        model: currentEntry.model,
        modelName: currentEntry.modelName,
        prompt: currentEntry.prompt,
        promptContent: currentEntry.promptContent,
        translation: '',
        explanation: '',
        nuances: '',
        reasoning: '',
        reasoningDetails: '',
        literalRetranslation: undefined,
        literalPending: false,
        wordDefinitions: undefined,
        wordData: undefined,
        wordPending: false,
        interpretation: undefined,
        interpretationPending: false
    };
    translation.entries.push(newEntry);
    translation.activeEntryIndex = translation.entries.length - 1;
    translation.status = 'streaming';
    translation.error = null;
    renderAllTranslations();

    const session = await loadSession(currentSessionId);
    const effectiveModel = getTranslationModelToUse(session);
    if (!config || !effectiveModel || !config!.openRouterApiKey!) {
        ui.displayError("Cannot regenerate: no model selected or no API key");
        return;
    }
    const reasoningLevel = getTranslationReasoningToUse(session);

    const systemPrompt = INPUT_SYSTEM_PROMPT;

    console.log(`[regenerateTranslationById] Regenerating with model: ${effectiveModel}`);

    // Delegate to streaming handler with timestamp rename and no background tasks
    await handleTranslateStreaming(
        translation,
        'input',
        systemPrompt,
        effectiveModel,
        reasoningLevel,
        {
            oldTimestampToDelete: translation.timestamp,
            skipBackgroundTasks: true
        }
    );
}

/**
 * Retranslates an existing translation with edited source and/or intent
 * @param {string} translationId - ID of translation to retranslate
 * @param {string} newSource - New source text
 * @param {string} newIntent - New intent text
 * @returns {Promise<void>}
 */
export async function retranslateFromEdit(translationId: string, newSource: string, newIntent: string): Promise<void> {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });

    if (!translation) {
        return;
    }

    // Abort any existing stream
    const existingStreamState = streamingStateMap.get(translation);
    if (existingStreamState) {
        existingStreamState.abort();
        streamingStateMap.delete(translation);
    }

    const session = await loadSession(currentSessionId);
    const effectiveModel = getTranslationModelToUse(session);
    if (!config || !effectiveModel || !config!.openRouterApiKey!) {
        ui.displayError("Cannot retranslate: no model selected or no API key");
        return;
    }

    const reasoningLevel = getTranslationReasoningToUse(session);
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';
    const theirLang = LANGUAGES.find(function(l) { return l.id === session?.theirLanguage; });
    const promptName = translation.pill === 'input'
        ? session?.interlocutorName ?? theirLang?.name ?? 'Foreign'
        : 'Me';

    translation.status = 'streaming';
    translation.error = null;
    translation.entries = [{
        source: newSource,
        intent: newIntent,
        model: effectiveModel ?? '',
        modelName: getModelName(effectiveModel ?? ''),
        prompt: promptName,
        promptContent: translation.entries?.[translation.activeEntryIndex ?? 0]?.promptContent ?? '',
        translation: '',
        explanation: '',
        nuances: '',
        reasoning: '',
        reasoningDetails: '',
        literalRetranslation: undefined,
        literalPending: false,
        wordDefinitions: undefined,
        wordData: undefined,
        wordPending: false,
        interpretation: undefined,
        interpretationPending: false
    }];
    translation.activeEntryIndex = 0;
    syncTopLevelFromActive(translation);
    renderAllTranslations();

    if (translation.pill !== 'input' && translation.pill !== 'output') {
        console.error('[retranslateFromEdit] Cannot retranslate this item type');
        return;
    }
    const mode = translation.pill;
    console.log(`[retranslateFromEdit] Starting streaming translation with model: ${effectiveModel}, mode: ${mode}`);

    const systemPrompt = mode === 'input' ? INPUT_SYSTEM_PROMPT : OUTPUT_SYSTEM_PROMPT;

    // Delegate to streaming handler with timestamp rename and background tasks
    await handleTranslateStreaming(
        translation,
        mode,
        systemPrompt,
        effectiveModel,
        reasoningLevel,
        {
            oldTimestampToDelete: translation.timestamp,
            skipBackgroundTasks: false
        }
    );
}

/**
 * Regenerates the interpretation for a completed output translation
 * @param {string} translationId - ID of translation to regenerate interpretation for
 * @returns {Promise<void>}
 */
export async function regenerateInterpretation(translationId: string): Promise<void> {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });

    if (!translation) {
        return;
    }

    if (translation.status !== 'complete') {
        return;
    }

    const session = await loadSession(currentSessionId);
    if (!getInterpretationModelToUse(session)) {
        console.error('[regenerateInterpretation] No interpretation model configured');
        return;
    }

    if (!config || !config.openRouterApiKey) {
        console.error('[regenerateInterpretation] No API key');
        return;
    }

    ensureEntries(translation);
    const activeIdx = translation.activeEntryIndex ?? 0;
    const entry = translation.entries[activeIdx];
    if (!entry) return;

    abortExistingInterpretation(translation);
    startInterpretationStreaming(translation);
    entry.interpretationPending = true;
    entry.interpretation = undefined;
    updateTranslationItem(translation);

    const message = await buildInterpretationMessage(translation);
    const interpModel = getInterpretationModelToUse(session)!;
    console.log('[regenerateInterpretation] Starting interpretation with model:', interpModel);
    const abortHandle = streamSendChatMessage(
        config!.openRouterApiKey!,
        message,
        buildInterpretationSystemPrompt(session),
        interpModel,
        {
            onChunk: function(text: string, reasoning: string): void {
                entry.interpretation = text;
                const iRefs = domRefsMap.get(translation);
                if (!iRefs) return;
                if (reasoning && iRefs.interpretationThinkingEl && iRefs.interpretationThinkingContentEl) {
                    iRefs.interpretationThinkingEl.style.display = '';
                    iRefs.interpretationThinkingContentEl.textContent = reasoning;
                }
                if (iRefs.regenerateInterpretationBtn) {
                    iRefs.regenerateInterpretationBtn.style.display = 'none';
                }
                const streamState = interpretationStreamingStateMap.get(translation);
                if (!streamState) return;
                streamState.accumulatedText = text;
                scheduleStreamRender(streamState, function(): void {
                    renderInterpretationStreaming(translation);
                });
            },
            onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                interpretationAbortMap.delete(translation);
                stopInterpretationStreaming(translation);
                entry.interpretation = fullText;
                entry.interpretationPending = false;
                const iRefs = domRefsMap.get(translation);
                if (iRefs?.interpretationThinkingEl) {
                    iRefs.interpretationThinkingEl.style.display = 'none';
                }
                if (usage && entry) {
                    entry.usage = {
                        promptTokens: usage.prompt_tokens,
                        completionTokens: usage.completion_tokens,
                        totalTokens: usage.total_tokens
                    };
                }
                if (generationId && entry) {
                    entry.generationId = generationId;
                }
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
            },
            onError: function(error: Error): void {
                interpretationAbortMap.delete(translation);
                stopInterpretationStreaming(translation);
                console.error('[regenerateInterpretation] Error:', error);
                entry.interpretationPending = false;
                entry.interpretation = undefined;
                const iRefs = domRefsMap.get(translation);
                if (iRefs?.interpretationThinkingEl) {
                    iRefs.interpretationThinkingEl.style.display = 'none';
                }
                updateTranslationItem(translation);
            }
        },
        getInterpretationReasoningToUse(session),
        config!.temperature
    );
    interpretationAbortMap.set(translation, abortHandle.abort);
}

/**
 * Regenerates all independently-sourced tab content for the active entry:
 * literal retranslation, word definitions, and interpretation.
 * These are the auxiliary sections that run as separate API calls
 * after the main translation completes.
 * @param {string} translationId - ID of the completed translation
 * @returns {Promise<void>}
 */
export async function regenerateIndependentSections(translationId: string): Promise<void> {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });

    if (!translation) {
        return;
    }

    const session = await loadSession(currentSessionId);
    if (!session) {
        console.error('[regenerateLiteral] No session found');
        return;
    }
    const effectiveModel = getTranslationModelToUse(session);
    if (!config || !config!.openRouterApiKey!) {
        console.error('[regenerateLiteral] No API key');
        return;
    }

    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';
    const literalPrompt = translation.pill === 'input'
        ? LITERAL_RETRANSLATION_PROMPT
        : OUTPUT_LITERAL_RETRANSLATION_PROMPT;
    const literalSystemPrompt = literalPrompt.replace(/\[LANGUAGE\]/g, myLangName);

    ensureEntries(translation);
    const activeIdx = translation.activeEntryIndex ?? 0;
    const entry = translation.entries[activeIdx];
    if (!entry) return;

    const literalUserMessage = translation.pill === 'input'
        ? entry.source
        : entry.translation;
    console.log('[regenerateLiteral] Starting literal retranslation with model:', session?.literalModel);
    console.log('[regenerateLiteral] Input text (' + translation.pill + '):', literalUserMessage.substring(0, 200));

    entry.literalPending = true;
    entry.literalRetranslation = undefined;
    updateTranslationItem(translation);

    /** @type {Promise<void>[]} */
    const tasks: Promise<void>[] = [];

    if (getLiteralModelToUse(session)) {
        const literalModel = getLiteralModelToUse(session)!;
        console.log('[regenerateLiteral] Starting literal retranslation streaming with model:', literalModel);
        handleLiteralRetranslationStreaming(
            translation,
            literalUserMessage,
            literalModel,
            myLangName,
            translation.pill === 'input' ? 'input' : 'output'
        );
    }

    const wordDefModel = getWordDefModelToUse(session);
    if (wordDefModel && entry.translation) {
        entry.wordPending = true;
        entry.wordDefinitions = undefined;
        entry.wordData = undefined;
        tasks.push((async () => {
            try {
                console.log('[wordDefinitions] Starting word definitions with model:', wordDefModel);
                const wordText = translation.pill === 'input'
                    ? entry.source
                    : entry.translation;
                const { xml: wordXml } = await fetchWordDefinitions(wordDefModel, getWordDefReasoningToUse(session), wordText, myLangName);
                entry.wordDefinitions = wordXml;

                entry.wordData = parseWordDefinitions(wordXml);
                console.log('[wordDefinitions] Parsed', entry.wordData.length, 'word items');
                entry.wordPending = false;
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
                const wordElement = document.getElementById('translation-' + translation.id);
                const wordContent = (wordElement as HTMLElement | null)?.querySelector('.translation-words') as HTMLElement | null | undefined;
                if (wordContent) {
                    wordContent.innerHTML = '';
                    renderWordContent(wordContent, translation);
                }
            } catch (wordDefError) {
                console.error('[wordDefinitions] Failed:', wordDefError);
                entry.wordPending = false;
                updateTranslationItem(translation);
            }
        })());
    }

    const interpModel = getInterpretationModelToUse(session);
    if (interpModel && entry.translation) {
        abortExistingInterpretation(translation);
        startInterpretationStreaming(translation);
        entry.interpretationPending = true;
        entry.interpretation = undefined;
        updateTranslationItem(translation);

        const message = await buildInterpretationMessage(translation);
        console.log('[interpretation] Starting interpretation with model:', interpModel);
        const abortHandle = streamSendChatMessage(
            config!.openRouterApiKey!,
            message,
            buildInterpretationSystemPrompt(session),
            interpModel,
            {
                onChunk: function(text: string, reasoning: string): void {
                    entry.interpretation = text;
                    const iRefs = domRefsMap.get(translation);
                    if (!iRefs) return;
                    if (reasoning && iRefs.interpretationThinkingEl && iRefs.interpretationThinkingContentEl) {
                        iRefs.interpretationThinkingEl.style.display = '';
                        iRefs.interpretationThinkingContentEl.textContent = reasoning;
                    }
                    if (iRefs.regenerateInterpretationBtn) {
                        iRefs.regenerateInterpretationBtn.style.display = 'none';
                    }
                    const streamState = interpretationStreamingStateMap.get(translation);
                    if (!streamState) return;
                    streamState.accumulatedText = text;
                    scheduleStreamRender(streamState, function(): void {
                        renderInterpretationStreaming(translation);
                    });
                },
                onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                    interpretationAbortMap.delete(translation);
                    stopInterpretationStreaming(translation);
                    entry.interpretation = fullText;
                    entry.interpretationPending = false;
                    const iRefs = domRefsMap.get(translation);
                    if (iRefs?.interpretationThinkingEl) {
                        iRefs.interpretationThinkingEl.style.display = 'none';
                    }
                    if (usage && entry) {
                        entry.usage = {
                            promptTokens: usage.prompt_tokens,
                            completionTokens: usage.completion_tokens,
                            totalTokens: usage.total_tokens
                        };
                    }
                    if (generationId && entry) {
                        entry.generationId = generationId;
                    }
                    syncTopLevelFromActive(translation);
                    saveSessionTranslation(currentSessionId, translation);
                    updateTranslationItem(translation);
                },
                onError: function(error: Error): void {
                    interpretationAbortMap.delete(translation);
                    stopInterpretationStreaming(translation);
                    console.error('[interpretation] Error:', error);
                    entry.interpretationPending = false;
                    entry.interpretation = undefined;
                    const iRefs = domRefsMap.get(translation);
                    if (iRefs?.interpretationThinkingEl) {
                        iRefs.interpretationThinkingEl.style.display = 'none';
                    }
                    updateTranslationItem(translation);
                }
            },
            getInterpretationReasoningToUse(session),
            config!.temperature
        );
        interpretationAbortMap.set(translation, abortHandle.abort);
    }

    if (tasks.length > 0) {
            Promise.all(tasks)
                .then(() => updateTranslationItem(translation))
                .catch(() => updateTranslationItem(translation));
        }
        updateTranslationItem(translation);
}

/**
 * Fetches word-by-word definitions for a completed translation
 * @param {string} model - Model ID to use
 * @param {string} reasoning - Reasoning level
 * @param {string} text - The translation text to analyze
 * @param {string} outputLanguage - Language name for definitions/explanations in the prompt
 * @returns {Promise<{ xml: string; generationId: string }>} Raw XML response and generation ID
 * @throws {Error} If API request fails
 */
async function fetchWordDefinitions(model: string, reasoning: string, text: string, outputLanguage: string): Promise<{ xml: string; generationId: string }> {
    const prompt = WORD_DEFINITIONS_PROMPT.replace(/\[TEXT\]/g, text).replace(/\[LANGUAGE\]/g, outputLanguage);
    console.log('[wordDefinitions] Sending API request, text length:', text.length);
    const { content, generationId } = await sendChatMessage(
        config!.openRouterApiKey!,
        prompt,
        'You are a linguistic analysis tool. Output only the requested XML structure with no additional text.',
        model,
        reasoning,
        config!.temperature
    );
    console.log('[wordDefinitions] API response length:', content.length, 'first 200 chars:', content.substring(0, 200));
    return { xml: content, generationId: generationId };
}

/**
 * Singleton word popup element
 * @type {HTMLElement | null}
 */
let wordPopupEl: HTMLElement | null = null;

/**
 * Hide timeout ID for popup delay
 * @type {number | null}
 */
let wordPopupHideTimeout: number | null = null;

/**
 * Ensures the word popup element exists and returns it
 * @returns {HTMLElement} The popup element
 */
function ensureWordPopup(): HTMLElement {
    if (!wordPopupEl) {
        const template = document.getElementById('word-popup-template') as HTMLTemplateElement;
        if (template) {
            const clone = template.content.cloneNode(true) as DocumentFragment;
            wordPopupEl = clone.firstElementChild as HTMLElement;
            document.body.appendChild(clone);
        }
    }
    return wordPopupEl!;
}

/**
 * Shows the word definition popup near a target element
 * @param {HTMLElement} target - The word element
 * @param {string} word - The word text
 * @param {string} def - Definition
 * @param {string} exp - Context explanation
 * @returns {void}
 */
function showWordPopup(target: HTMLElement, word: string, def: string, exp: string): void {
    if (wordPopupHideTimeout !== null) {
        clearTimeout(wordPopupHideTimeout);
        wordPopupHideTimeout = null;
    }

    const popup = ensureWordPopup();
    const wordEl = popup.querySelector('.word-popup-word') as HTMLElement;
    const defEl = popup.querySelector('.word-popup-def') as HTMLElement;
    const expEl = popup.querySelector('.word-popup-exp') as HTMLElement;

    if (wordEl) wordEl.textContent = word;
    if (defEl) defEl.textContent = def;
    if (expEl) expEl.textContent = exp;

    const rect = target.getBoundingClientRect();
    popup.style.left = Math.min(rect.left, window.innerWidth - 310) + 'px';
    popup.style.top = (rect.bottom + 6) + 'px';
    popup.style.display = 'block';
}

/**
 * Hides the word definition popup
 * @returns {void}
 */
function hideWordPopup(): void {
    if (wordPopupHideTimeout !== null) {
        clearTimeout(wordPopupHideTimeout);
    }
    wordPopupHideTimeout = window.setTimeout(function() {
        if (wordPopupEl) {
            wordPopupEl.style.display = 'none';
        }
        wordPopupHideTimeout = null;
    }, 200);
}

/**
 * Renders word-by-word content in the Words tab
 * Always clears and rebuilds the content
 * @param {HTMLElement} container - The words tab content element
 * @param {Translation} translation - The translation object
 * @returns {void}
 */
function renderWordContent(container: HTMLElement, translation: Translation): void {
    container.innerHTML = '';

    ensureEntries(translation);
    const entry = translation.entries[translation.activeEntryIndex ?? 0];
    const wordData = entry?.wordData ?? (translation as any).wordData;
    const wordPending = entry?.wordPending ?? false;

    if (wordPending) {
        container.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Loading word data...</span>';
        return;
    }
    if (!wordData || wordData.length === 0) {
        container.textContent = 'No word data available.';
        return;
    }

    for (let i = 0; i < wordData.length; i++) {
        const item = wordData[i];

        if (item.type === 'word') {
            const span = document.createElement('span');
            span.className = 'translation-word';
            span.textContent = item.word;
            span.addEventListener('mouseenter', function() {
                showWordPopup(span, item.word, item.def, item.exp);
            });
            span.addEventListener('mouseleave', function() {
                hideWordPopup();
            });
            container.appendChild(span);
        } else if (item.type === 'punct') {
            const span = document.createElement('span');
            span.textContent = item.text;
            container.appendChild(span);
        } else if (item.type === 'nl') {
            container.appendChild(document.createElement('br'));
        }
    }
}

// ===== Streaming Display Functions =====

/**
 * Sets up the streaming display structure inside the translation target element.
 * Creates a markdown-rendered area for completed paragraphs and a raw text span
 * for the current incomplete paragraph. Shows the stop button and hides interactive controls.
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @param {Translation} translation - The translation being streamed
 * @returns {void}
 */
function setupStreamingDisplay(refs: TranslationDomRefs, translation: Translation): void {
    if (!refs.targetEl) return;

    // Create streaming DOM structure
    refs.targetEl.innerHTML =
        '<div class="streaming-markdown"></div>' +
        '<span class="streaming-raw"></span>';

    // Show stop button, hide interactive buttons
    if (refs.stopGenerationBtn) refs.stopGenerationBtn.style.display = 'inline-block';
    if (refs.retryBtn) refs.retryBtn.style.display = 'none';
    if (refs.regenerateTranslationBtn) refs.regenerateTranslationBtn.style.display = 'none';
    if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
    if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = 'none';
    if (refs.regenerateAnswerBtn) refs.regenerateAnswerBtn.style.display = 'none';
    if (refs.copyAnswerBtn) refs.copyAnswerBtn.style.display = 'none';
    if (refs.saveAnswerBtn) refs.saveAnswerBtn.style.display = 'none';
    if (refs.spinnerEl) refs.spinnerEl.style.display = 'block';
    if (refs.errorEl) refs.errorEl.style.display = 'none';
    if (refs.thinkingEl) refs.thinkingEl.style.display = 'none';

    // Clear dependent sections from previous translations
    if (refs.literalEl) refs.literalEl.textContent = 'Awaiting translation...';
    if (refs.interpretationEl) paintInterpretationHtml(translation, refs, 'Awaiting translation...');
    if (refs.wordsContent) refs.wordsContent.textContent = 'Awaiting translation...';

    // Update char count for streaming state
    const sourceLen = translation.entries?.[0]?.source?.length ?? 0;
    if (refs.charCountEl) {
        refs.charCountEl.textContent = `(${sourceLen}/—)`;
    }
}

/**
 * Display model derived from the accumulated streaming text.
 * Computed on every chunk so stream state stays current, while the DOM writes are
 * deferred to a frame by paintStreamingContent.
 */
interface StreamingDisplay {
    hasReasoning: boolean;
    hasText: boolean;
    displayText: string;
    isComplete: boolean;
}

/**
 * Derives the display model for the accumulated streaming text.
 * Updates the streaming state that other logic depends on (translationComplete)
 * so callers observe it immediately rather than at the next paint.
 * @param {StreamingState} streamingState - Current streaming state for this translation
 * @param {string} text - Accumulated main content text
 * @param {string} reasoning - Accumulated reasoning content text
 * @returns {StreamingDisplay} The display model to paint
 */
function computeStreamingDisplay(streamingState: StreamingState, text: string, reasoning: string): StreamingDisplay {
    const hasText = text.length > 0;

    // Extract only the TRANSLATION portion for display — explanation and nuances
    // are excluded from the target area during streaming
    const extracted = hasText
        ? extractTranslationForDisplay(text)
        : { displayText: '', isComplete: false };

    // Mark translation complete once we've seen the closing tag
    if (extracted.isComplete) {
        streamingState.translationComplete = true;
    }

    return {
        hasReasoning: reasoning.length > 0,
        hasText: hasText,
        displayText: extracted.displayText,
        isComplete: extracted.isComplete
    };
}

/**
 * Paints the streaming display with the latest accumulated text and reasoning content.
 * Shows reasoning (thinking) content while main text hasn't arrived yet.
 * Renders completed paragraphs as markdown, shows current paragraph as raw text.
 * Only the text within <translation> tags is displayed; explanation and nuances
 * content is excluded from the target area during streaming.
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @param {StreamingState} streamingState - Current streaming state for this translation
 * @param {StreamingDisplay} display - Display model from computeStreamingDisplay
 * @param {string} reasoning - Accumulated reasoning content text
 * @returns {void}
 */
function paintStreamingContent(
    refs: TranslationDomRefs,
    streamingState: StreamingState,
    display: StreamingDisplay,
    reasoning: string
): void {
    // Hide spinner once any content starts arriving
    if (refs.spinnerEl) {
        refs.spinnerEl.style.display = (display.hasReasoning || display.hasText) ? 'none' : 'block';
    }

    if (refs.thinkingEl) {
        if (display.hasReasoning && !display.hasText) {
            refs.thinkingEl.style.display = '';
            if (refs.thinkingContentEl) {
                refs.thinkingContentEl.textContent = reasoning;
            }
        } else {
            refs.thinkingEl.style.display = 'none';
        }
    }

    if (!display.hasText) return;

    // Find the streaming structure inside target element
    const markdownEl = refs.targetEl?.querySelector('.streaming-markdown') as HTMLElement | null;
    const rawEl = refs.targetEl?.querySelector('.streaming-raw') as HTMLElement | null;
    if (!markdownEl || !rawEl) return;

    if (display.isComplete) {
        markdownEl.innerHTML = renderMarkdown(normalizeForMarkdown(display.displayText));
        rawEl.textContent = '';
        streamingState.lastRenderedBreakIndex = display.displayText.length;
    } else {
        // Check if new paragraphs were completed since last render
        const lastDoubleNewline = display.displayText.lastIndexOf('\n\n');

        if (lastDoubleNewline !== -1 && lastDoubleNewline + 2 > streamingState.lastRenderedBreakIndex) {
            const completedPart = display.displayText.substring(0, lastDoubleNewline + 2);
            markdownEl.innerHTML = renderMarkdown(normalizeForMarkdown(completedPart));
            streamingState.lastRenderedBreakIndex = lastDoubleNewline + 2;
        }

        // Show current incomplete paragraph as raw text
        const remainingText = display.displayText.substring(streamingState.lastRenderedBreakIndex);
        rawEl.textContent = remainingText;
    }
}

/**
 * Tears down the streaming display structure, clearing the target element for
 * the final rendered view. Hides the stop button and thinking element.
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @returns {void}
 */
function teardownStreamingDisplay(refs: TranslationDomRefs): void {
    if (refs.targetEl) {
        refs.targetEl.innerHTML = '';
    }
    if (refs.stopGenerationBtn) {
        refs.stopGenerationBtn.style.display = 'none';
    }
    if (refs.thinkingEl) {
        refs.thinkingEl.style.display = 'none';
    }
    if (refs.spinnerEl) {
        refs.spinnerEl.style.display = 'none';
    }
}

// ===== Translation Tag Helpers =====

/**
 * Builds the tag instructions block for the prompt if any tags are detected in source text
 * @param {TranslationTag[] | undefined} tags - Session's defined tags
 * @param {string} sourceText - Text being translated
 * @returns {string} Tag instructions block or empty string
 */
function buildTagInstructionsBlock(tags: TranslationTag[] | undefined, sourceText: string): string {
    if (!tags || tags.length === 0) return '';

    const detectedTags = tags.filter(function(tag) {
        return sourceText.includes(tag.openTag);
    });

    if (detectedTags.length === 0) return '';

    const tagList = detectedTags.map(function(tag) {
        return `- ${tag.openTag}...${tag.closeTag}: ${tag.guidance}`;
    }).join('\n');

    return `You may encounter the following inline tags in the source text. Use them as guidance for that portion only, then remove the tags from your output:\n${tagList}`;
}

// ===== Text Selection Tag Popup =====

/** @type {HTMLDivElement | null} */
let tagPopupElement: HTMLDivElement | null = null;

/** @type {HTMLDivElement | null} */
let tagPopupButtonsContainer: HTMLDivElement | null = null;

/**
 * Initializes the tag popup element from the template
 * @returns {void}
 */
function initTagPopup(): void {
    if (tagPopupElement) return;

    const template = document.getElementById('tag-popup-template') as HTMLTemplateElement | null;
    if (!template) return;

    const clone = template.content.cloneNode(true) as DocumentFragment;
    tagPopupElement = clone.firstElementChild as HTMLDivElement;
    tagPopupButtonsContainer = tagPopupElement.querySelector('.tag-popup-buttons') as HTMLDivElement;
    document.body.appendChild(tagPopupElement);
}

/**
 * Shows the tag popup underneath the selected text in the textarea
 * Uses a mirror element to compute the pixel position of the selection
 * @param {HTMLTextAreaElement} textarea - The source textarea element
 * @param {TranslationTag[]} tags - Available tags to show
 * @returns {void}
 */
function showTagPopup(textarea: HTMLTextAreaElement, tags: TranslationTag[]): void {
    if (!tagPopupElement || !tagPopupButtonsContainer) return;

    const container = tagPopupButtonsContainer;
    const popup = tagPopupElement;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    if (start === end) {
        hideTagPopup();
        return;
    }

    container.innerHTML = '';

    tags.forEach(function(tag) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-secondary';
        btn.textContent = tag.name;
        btn.title = tag.guidance;
        btn.addEventListener('click', function() {
            const text = textarea.value;
            const selectedText = text.substring(start, end);
            const wrappedText = tag.openTag + selectedText + tag.closeTag;

            textarea.value = text.substring(0, start) + wrappedText + text.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + wrappedText.length;
            textarea.focus();
            hideTagPopup();
        });
        container.appendChild(btn);
    });

    // Mirror element technique for computing textarea selection position
    const mirror = document.createElement('div');
    const computed = window.getComputedStyle(textarea);
    mirror.style.position = 'absolute';
    mirror.style.top = '0';
    mirror.style.left = '0';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';
    mirror.style.width = computed.width;
    mirror.style.height = computed.height;
    mirror.style.padding = computed.padding;
    mirror.style.border = computed.border;
    mirror.style.font = computed.font;
    mirror.style.lineHeight = computed.lineHeight;
    mirror.style.letterSpacing = computed.letterSpacing;

    const textBefore = textarea.value.substring(0, start);
    const selected = textarea.value.substring(start, end);
    mirror.textContent = textBefore;
    const marker = document.createElement('span');
    marker.textContent = selected || '.';
    mirror.appendChild(marker);

    document.body.appendChild(mirror);
    const markerRect = marker.getBoundingClientRect();
    document.body.removeChild(mirror);

    popup.style.display = 'block';
    popup.style.left = Math.max(0, markerRect.left + markerRect.width / 2 - popup.offsetWidth / 2) + 'px';
    popup.style.top = (markerRect.bottom + window.scrollY + 4) + 'px';
}

/**
 * Hides the tag popup
 * @returns {void}
 */
function hideTagPopup(): void {
    if (tagPopupElement) {
        tagPopupElement.style.display = 'none';
    }
}

// ===== Streaming Orchestration Functions =====

// ===== Literal Retranslation Streaming =====

/**
 * Sets up the streaming display for literal retranslation.
 * Clears the literal element, hides the regenerate button.
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @returns {void}
 */
function setupLiteralStreamingDisplay(refs: TranslationDomRefs): void {
    if (!refs.literalEl) return;
    refs.literalEl.textContent = '';
    if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
}

/**
 * Updates the literal retranslation streaming display with new text.
 * Sets plain text content (no markdown) on the literal element.
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @param {string} text - Accumulated literal text
 * @returns {void}
 */
function updateLiteralStreamingContent(refs: TranslationDomRefs, text: string): void {
    if (!refs.literalEl) return;
    refs.literalEl.textContent = text;
}

/**
 * Tears down the literal streaming display.
 * Clears literal element (will be re-rendered by updateTranslationItem on completion).
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @returns {void}
 */
function teardownLiteralStreamingDisplay(refs: TranslationDomRefs): void {
    if (refs.literalEl) {
        refs.literalEl.textContent = '';
    }
}

/**
 * Handles literal retranslation streaming.
 * Builds the prompt, calls streamSendChatMessage with no reasoning,
 * and updates the literal element during streaming.
 * On completion, saves the result to OPFS and calls updateTranslationItem.
 * @param {Translation} translation - The translation to produce literal for
 * @param {string} text - The text to literally retranslate
 * @param {string} model - Literal model ID
 * @param {string} myLangName - Language name for prompt
 * @param {'input' | 'output'} mode - Translation mode
 * @returns {void}
 */
function handleLiteralRetranslationStreaming(
    translation: Translation,
    text: string,
    model: string,
    myLangName: string,
    mode: 'input' | 'output'
): void {
    const refs = domRefsMap.get(translation);
    if (!refs) {
        console.warn('[handleLiteralRetranslationStreaming] No DOM refs for translation', translation.id);
        return;
    }

    const literalPrompt = mode === 'input'
        ? LITERAL_RETRANSLATION_PROMPT
        : OUTPUT_LITERAL_RETRANSLATION_PROMPT;
    const literalSystemPrompt = literalPrompt.replace(/\[LANGUAGE\]/g, myLangName);

    console.log('[handleLiteralRetranslationStreaming] Starting with model:', model);

    const entry = translation.entries[translation.activeEntryIndex ?? 0];
    if (!entry) return;

    entry.literalPending = true;
    entry.literalRetranslation = undefined;

    setupLiteralStreamingDisplay(refs);
    updateTranslationItem(translation);

    const abortHandle = streamSendChatMessage(
        config!.openRouterApiKey!,
        text,
        literalSystemPrompt,
        model,
        {
            onChunk: function(accumulatedText: string): void {
                const streamState = literalStreamingStateMap.get(translation);
                if (!streamState) return;
                streamState.accumulatedText = accumulatedText;
                scheduleStreamRender(streamState, function(): void {
                    if (literalStreamingStateMap.get(translation) !== streamState) return;
                    updateLiteralStreamingContent(refs!, accumulatedText);
                });
            },
            onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                literalStreamingStateMap.delete(translation);

                if (usage && entry) {
                    entry.usage = {
                        promptTokens: usage.prompt_tokens,
                        completionTokens: usage.completion_tokens,
                        totalTokens: usage.total_tokens
                    };
                }
                if (generationId && entry) {
                    entry.generationId = generationId;
                }

                entry.literalRetranslation = fullText;
                entry.literalPending = false;
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                teardownLiteralStreamingDisplay(refs!);
                updateTranslationItem(translation);
            },
            onError: function(error: Error): void {
                literalStreamingStateMap.delete(translation);
                console.error('[handleLiteralRetranslationStreaming] Error:', error);
                entry.literalPending = false;
                teardownLiteralStreamingDisplay(refs!);
                updateTranslationItem(translation);
            }
        },
        'none',
        config!.temperature
    );

    literalStreamingStateMap.set(translation, {
        abort: abortHandle.abort,
        accumulatedText: ''
    });
}

/**
 * Aborts any running interpretation stream for a translation.
 * Cleans up pending state and hides the thinking element.
 * @param {Translation} translation - Translation whose interpretation to abort
 * @returns {void}
 */
function abortExistingInterpretation(translation: Translation): void {
    const abortFn = interpretationAbortMap.get(translation);
    if (abortFn) {
        abortFn();
        interpretationAbortMap.delete(translation);
    }
    stopInterpretationStreaming(translation);
    ensureEntries(translation);
    const entry = translation.entries[translation.activeEntryIndex ?? 0];
    if (entry) {
        entry.interpretationPending = false;
    }
    const iRefs = domRefsMap.get(translation);
    if (iRefs?.interpretationThinkingEl) {
        iRefs.interpretationThinkingEl.style.display = 'none';
    }
}

/**
 * Releases an interpretation stream's render-scheduler slot and render state.
 * Must run before the final interpretation is written, otherwise a render that
 * was still pending would repaint the pane with a partial transcript.
 * @param {Translation} translation - Translation whose interpretation stream to stop
 * @returns {void}
 */
function stopInterpretationStreaming(translation: Translation): void {
    const state = interpretationStreamingStateMap.get(translation);
    if (state) {
        cancelStreamRender(state);
    }
    interpretationStreamingStateMap.delete(translation);
}

/**
 * Begins tracking a new interpretation stream for a translation.
 * @param {Translation} translation - Translation whose interpretation is streaming
 * @returns {void}
 */
function startInterpretationStreaming(translation: Translation): void {
    stopInterpretationStreaming(translation);
    interpretationStreamingStateMap.set(translation, {
        accumulatedText: '',
        renderedUpTo: 0,
        hasPainted: false
    });
}

/**
 * Paints the accumulated interpretation into the pane.
 * Completed paragraphs are rendered as markdown and only the trailing incomplete
 * paragraph is repainted as raw text, so the per-frame cost tracks the new text
 * rather than the whole transcript.
 * @param {Translation} translation - Translation whose interpretation is streaming
 * @returns {void}
 */
function renderInterpretationStreaming(translation: Translation): void {
    const state = interpretationStreamingStateMap.get(translation);
    const refs = domRefsMap.get(translation);
    if (!state || !refs?.interpretationMarkdownEl || !refs.interpretationRawEl) return;

    const text = state.accumulatedText;
    const lastDoubleNewline = text.lastIndexOf('\n\n');

    if (lastDoubleNewline !== -1 && lastDoubleNewline + 2 > state.renderedUpTo) {
        state.renderedUpTo = lastDoubleNewline + 2;
        refs.interpretationMarkdownEl.innerHTML = renderMarkdown(text.substring(0, state.renderedUpTo));
    } else if (!state.hasPainted) {
        // Drop any placeholder left by the previous full render (the "Interpreting..."
        // spinner) before the first streamed text appears.
        refs.interpretationMarkdownEl.innerHTML = '';
    }
    state.hasPainted = true;

    refs.interpretationRawEl.textContent = text.substring(state.renderedUpTo);
}

/** Placeholder shown in the interpretation pane while the interpretation streams. */
const INTERPRETATION_SPINNER_HTML: string =
    '<div class="spinner-border spinner-border-sm" role="status"></div>'
    + '<span style="margin-left: 0.5rem;">Interpreting...</span>';

/**
 * Replaces the whole interpretation pane with fully-rendered HTML.
 * Writes into the pane's markdown child rather than the pane itself, so the
 * streaming child elements captured at template-clone time stay attached.
 * Invalidates any in-flight stream's incremental boundary, so the next streamed
 * frame repaints the pane instead of assuming it still holds completed paragraphs.
 * @param {Translation} translation - Translation whose pane is being painted
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @param {string} html - Sanitized HTML (or empty string) to show in the pane
 * @returns {void}
 */
function paintInterpretationHtml(translation: Translation, refs: TranslationDomRefs, html: string): void {
    if (refs.interpretationMarkdownEl) {
        refs.interpretationMarkdownEl.innerHTML = html;
    }
    if (refs.interpretationRawEl) {
        refs.interpretationRawEl.textContent = '';
    }

    const state = interpretationStreamingStateMap.get(translation);
    if (state) {
        state.renderedUpTo = 0;
        state.hasPainted = false;
    }
}

/**
 * Aborts an active streaming generation for a translation.
 * Also aborts any concurrent interpretation stream via abortExistingInterpretation.
 * Sets status to 'error' and cleans up DOM.
 * @param {Translation} translation - Translation whose stream to abort
 * @returns {void}
 */
function abortExistingStream(translation: Translation): void {
    const streamState = streamingStateMap.get(translation);
    if (streamState) {
        streamState.abort();
        streamingStateMap.delete(translation);
    }
    abortExistingInterpretation(translation);
    translation.status = 'error';
    translation.error = 'Generation stopped';
    const refs = domRefsMap.get(translation);
    if (refs) {
        teardownStreamingDisplay(refs);
        updateTranslationItemContent(translation, refs);
    }
}

/**
 * Stops generation for a translation by its ID.
 * Public entry point for the stop generation button.
 * @param {string} translationId - ID of the translation whose generation to stop
 * @returns {void}
 */
function stopGeneration(translationId: string): void {
    const translation = allTranslations.find(function(t) { return t.id === translationId; });
    if (!translation) return;
    abortExistingStream(translation);
}

/**
 * Runs background tasks after a structured translation stream completes.
 * Tasks: literal retranslation, word definitions, interpretation.
 * All use non-streaming API calls and save independently to OPFS.
 * @param {Translation} translation - The completed translation
 * @param {'input' | 'output'} mode - Translation mode
 * @param {string} sourceText - Original source text
 * @param {string} translationText - The resulting translation text
 * @returns {Promise<void>}
 */
async function startBackgroundTasksAfterStreaming(
    translation: Translation,
    mode: 'input' | 'output',
    sourceText: string,
    translationText: string
): Promise<void> {
    const session = await loadSession(currentSessionId);
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';

    /** @type {Promise<void>[]} */
    const tasks: Promise<void>[] = [];

    if (getLiteralModelToUse(session)) {
        const literalUserMessage = mode === 'input'
            ? sourceText
            : translationText;
        const literalModel = getLiteralModelToUse(session)!;
        console.log('[translateLiteral] Starting literal retranslation streaming with model:', literalModel);
        handleLiteralRetranslationStreaming(
            translation,
            literalUserMessage,
            literalModel,
            myLangName,
            mode
        );
    }

    const wordDefModel = getWordDefModelToUse(session);
    if (wordDefModel && translationText) {
        translation.entries[0].wordPending = true;
        tasks.push((async () => {
            try {
                console.log('[wordDefinitions] Starting word definitions with model:', wordDefModel);
                const { xml: wordXml } = await fetchWordDefinitions(wordDefModel, getWordDefReasoningToUse(session), translationText, myLangName);
                translation.entries[0].wordDefinitions = wordXml;

                translation.entries[0].wordData = parseWordDefinitions(wordXml);
                console.log('[wordDefinitions] Parsed', translation.entries[0].wordData.length, 'word items');
                translation.entries[0].wordPending = false;
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
            } catch (wordDefError) {
                console.error('[wordDefinitions] Failed:', wordDefError);
                translation.entries[0].wordPending = false;
                updateTranslationItem(translation);
            }
        })());
    }

    const interpModel = getInterpretationModelToUse(session);
    if (mode === 'output' && interpModel) {
        translation.entries[0].interpretationPending = true;
        tasks.push((async () => {
            try {
                const message = await buildInterpretationMessage(translation);
                console.log('[interpretation] Starting interpretation with model:', interpModel);
                const { content: interpretationResult } = await sendChatMessage(
                    config!.openRouterApiKey!,
                    message,
                    buildInterpretationSystemPrompt(session),
                    interpModel,
                    getInterpretationReasoningToUse(session),
                    config!.temperature
                );
                translation.entries[0].interpretation = interpretationResult;

                translation.entries[0].interpretationPending = false;
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
            } catch (interpretationError) {
                console.error('[interpretation] Failed:', interpretationError);
                translation.entries[0].interpretationPending = false;
                updateTranslationItem(translation);
            }
        })());
    }

    if (tasks.length > 0) {
        Promise.all(tasks)
            .then(() => updateTranslationItem(translation))
            .catch(() => updateTranslationItem(translation));
    }
}

/**
 * Options for customizing handleTranslateStreaming behavior.
 * @property {number} oldTimestampToDelete - If set, renames timestamp and deletes the old OPFS file after save (for retry/regenerate)
 * @property {boolean} skipBackgroundTasks - If true, skips literal retranslation, word definitions, and interpretation after completion
 */
interface TranslateStreamingOptions {
    oldTimestampToDelete?: number;
    skipBackgroundTasks?: boolean;
    clearDraftsOnDone?: boolean;
}

/**
 * Structured translation using streaming: creates the streaming display, calls the
 * streaming API, and handles incremental content updates and completion.
 * Supports optional customization for retry/regenerate paths via options.
 * @param {Translation} translation - The translation object (already added to allTranslations)
 * @param {'input' | 'output'} mode - Translation mode
 * @param {string} systemPrompt - System prompt
 * @param {string} effectiveModel - Model ID to use
 * @param {string} reasoningLevel - Reasoning effort level
 * @param {TranslateStreamingOptions} options - Optional customization
 * @returns {Promise<void>}
 */
async function handleTranslateStreaming(
    translation: Translation,
    mode: 'input' | 'output',
    systemPrompt: string,
    effectiveModel: string,
    reasoningLevel: string,
    options?: TranslateStreamingOptions
): Promise<void> {
    const refs = domRefsMap.get(translation);
    if (!refs) {
        console.warn('[handleTranslateStreaming] No DOM refs for translation', translation.id);
        return;
    }

    // Build user message with background, history, and instructions
    const activeEntry = translation.entries[translation.activeEntryIndex ?? 0];
    if (!activeEntry) return;
    const sourceText = activeEntry.source;

    const session = await loadSession(currentSessionId);
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';
    const theirLang = LANGUAGES.find(function(l) { return l.id === session?.theirLanguage; });
    const theirLangName = theirLang?.name ?? session?.theirLanguage ?? 'Foreign';

    let instructions: string;
    if (mode === 'input') {
        instructions = INPUT_INSTRUCTIONS.replace(/\[LANGUAGE\]/g, myLangName);
    } else {
        const intent = activeEntry?.intent ?? '';
        const translationInstructions = session?.translationInstructions ?? '';
        const langInstructionsKey = 'langInstructions_' + (session?.theirLanguage ?? '');
        const langInstructions = await getPreference(langInstructionsKey);
        const langInstructionsBlock = langInstructions
            ? `General ${theirLangName} translation notes:\n${langInstructions}\n\n`
            : '';
        const translationInstructionsBlock = (translationInstructions || langInstructions)
            ? `The following are instructions on how the translation should be styled and presented:\n<translationinstructions>${langInstructionsBlock}${translationInstructions}</translationinstructions>`
            : '';
        const intentBlock = intent
            ? `The following is guidance on the intent of the text to be translated:\n<intent>${intent}</intent>`
            : '';
        instructions = OUTPUT_INSTRUCTIONS.replace(/\[TRANSLATION_INSTRUCTIONS_BLOCK\]/g, translationInstructionsBlock);
        instructions = instructions.replace(/\[INTENT_BLOCK\]/g, intentBlock);
        instructions = instructions.replace(/\[LANGUAGE\]/g, myLangName);
        instructions = instructions.replace(/\[TARGET_LANGUAGE\]/g, theirLangName);
        instructions = instructions.replace(/\[TAG_INSTRUCTIONS_BLOCK\]/g, buildTagInstructionsBlock(session?.translationTags, sourceText));
    }

    const userMessage = await buildUserMessage(mode, sourceText, instructions);

    // Set up streaming display
    setupStreamingDisplay(refs, translation);

    // Start streaming
    const abortHandle = streamTranslateStructured(
        config!.openRouterApiKey!,
        userMessage,
        systemPrompt,
        effectiveModel,
        {
            onChunk: function(text: string, reasoning: string): void {
                const streamState = streamingStateMap.get(translation);
                if (!streamState) return;
                streamState.accumulatedText = text;
                streamState.accumulatedReasoning = reasoning;
                const display = computeStreamingDisplay(streamState, text, reasoning);
                scheduleStreamRender(streamState, function(): void {
                    if (streamingStateMap.get(translation) !== streamState) return;
                    paintStreamingContent(refs!, streamState, display, reasoning);
                });

                // Fallback: if </translation> is missing but next section has started
                if (!streamState.translationComplete) {
                    const openIdx = text.indexOf('<translation>');
                    const explanationIdx = text.indexOf('<explanation>');
                    const nuancesIdx = text.indexOf('<nuances>');
                    if (openIdx !== -1 && ((explanationIdx > openIdx) || (nuancesIdx > openIdx))) {
                        streamState.translationComplete = true;
                    }
                }

                // Once translation is complete (either way), start dependent sections immediately
                if (streamState.translationComplete && !streamState.backgroundTasksTriggered) {
                    streamState.backgroundTasksTriggered = true;
                    const result = extractStructuredResult(text);
                    if (result.translation && /\S/.test(result.translation)) {
                        const activeEntry = translation.entries[translation.activeEntryIndex ?? 0];
                        if (activeEntry) {
                            if (mode === 'output' && session?.translationTags && session.translationTags.length > 0) {
                                activeEntry.translation = stripTranslationTags(result.translation, session.translationTags);
                            } else {
                                activeEntry.translation = result.translation;
                            }
                        }
                        if (!options?.skipBackgroundTasks) {
                            regenerateIndependentSections(translation.id);
                        }
                    }
                }

                // Detect when explanation or nuances sections finish
                if (!streamState.sectionsComplete && (text.includes('</explanation>') || text.includes('</nuances>'))) {
                    streamState.sectionsComplete = true;
                }

                // Save to OPFS at each milestone
                const shouldSave = (streamState.translationComplete && !(streamState.milestoneSaved & 1))
                    || (streamState.sectionsComplete && !(streamState.milestoneSaved & 2));

                if (shouldSave) {
                    const partialResult = extractStructuredResult(text);
                    const activeEntry = translation.entries[translation.activeEntryIndex ?? 0];
                    if (activeEntry) {
                        if (partialResult.translation) {
                            if (mode === 'output' && session?.translationTags && session.translationTags.length > 0) {
                                activeEntry.translation = stripTranslationTags(partialResult.translation, session.translationTags);
                            } else {
                                activeEntry.translation = partialResult.translation;
                            }
                        }
                        if (partialResult.explanation) activeEntry.explanation = partialResult.explanation;
                        if (partialResult.nuances) activeEntry.nuances = partialResult.nuances;
                    }
                    syncTopLevelFromActive(translation);

                    let milestoneBit = 0;
                    if (streamState.translationComplete) milestoneBit |= 1;
                    if (streamState.sectionsComplete) milestoneBit |= 2;
                    streamState.milestoneSaved = milestoneBit;

                    saveSessionTranslation(currentSessionId, translation);
                }
            },
            onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                const streamState = streamingStateMap.get(translation);
                const backgroundTasksAlreadyTriggered = streamState?.backgroundTasksTriggered ?? false;
                streamingStateMap.delete(translation);

                const activeEntry = translation.entries[translation.activeEntryIndex ?? 0];

                // Populate token usage from streaming response (avoids generation info API call)
                if (usage && activeEntry) {
                    activeEntry.usage = {
                        promptTokens: usage.prompt_tokens,
                        completionTokens: usage.completion_tokens,
                        totalTokens: usage.total_tokens
                    };
                    activeEntry.generationId = generationId ?? undefined;
                } else if (generationId && activeEntry) {
                    activeEntry.generationId = generationId;
                }

                // Handle empty response
                if (!fullText || !/\S/.test(fullText)) {
                    console.log('[handleTranslateStreaming] API returned empty - model:', effectiveModel, 'text:', sourceText.substring(0, 100));
                    translation.status = 'error';
                    translation.error = 'Translation returned empty content. Try again.';
                    teardownStreamingDisplay(refs!);
                    syncTopLevelFromActive(translation);
                    saveSessionTranslation(currentSessionId, translation);
                    updateTranslationItemContent(translation, refs!);
                    refreshBalance();
                    return;
                }

                // Parse XML tags from the complete response
                const result = extractStructuredResult(fullText);

                // Strip translation tags from output (output mode only)
                if (mode === 'output' && session?.translationTags && session.translationTags.length > 0) {
                    result.translation = stripTranslationTags(result.translation, session.translationTags);
                }

                // Handle empty translation content
                if (!result.translation || !/\S/.test(result.translation)) {
                    console.log('[handleTranslateStreaming] Empty translation tag - model:', effectiveModel);
                    translation.status = 'error';
                    translation.error = 'Translation returned empty content. Try again.';
                    teardownStreamingDisplay(refs!);
                    syncTopLevelFromActive(translation);
                    saveSessionTranslation(currentSessionId, translation);
                    updateTranslationItemContent(translation, refs!);
                    refreshBalance();
                    return;
                }

                // Populate the active entry with parsed results
                if (activeEntry) {
                    activeEntry.translation = result.translation;
                    activeEntry.explanation = result.explanation;
                    activeEntry.nuances = result.nuances;
                    activeEntry.model = effectiveModel;
                    activeEntry.modelName = getModelName(effectiveModel);
                }
                translation.status = 'complete';
                syncTopLevelFromActive(translation);

                // Handle optional timestamp rename (for retry/regenerate)
                const oldTs = options?.oldTimestampToDelete;
                if (oldTs) {
                    translation.timestamp = Date.now();
                }

                // Save to OPFS
                saveSessionTranslation(currentSessionId, translation);

                if (options?.clearDraftsOnDone) {
                    clearDrafts();
                }

                // Delete old timestamp if renaming
                if (oldTs) {
                    (async () => {
                        try {
                            await deleteSessionTranslation(currentSessionId, oldTs);
                        } catch (e) {
                            console.error('[handleTranslateStreaming] Error deleting old timestamp:', e);
                        }
                    })();
                }

                // Tear down streaming and show final result
                teardownStreamingDisplay(refs!);
                updateTranslationItemContent(translation, refs!);

                // Refresh balance
                refreshBalance();

                // Trigger dependent API calls (literal retranslation, word definitions, interpretation)
                // Skip if already triggered early from onChunk when </translation> was detected
                if (!options?.skipBackgroundTasks && !backgroundTasksAlreadyTriggered) {
                    regenerateIndependentSections(translation.id);
                }
            },
            onError: function(error: Error): void {
                streamingStateMap.delete(translation);
                console.error('[handleTranslateStreaming] Error:', error);
                translation.status = 'error';
                translation.error = error.message;
                teardownStreamingDisplay(refs!);
                updateTranslationItemContent(translation, refs!);
                refreshBalance();
            }
        },
        reasoningLevel,
        config!.temperature
    );

    // Store streaming state for management (abort, pause-as-needed tracking)
    streamingStateMap.set(translation, {
        abort: abortHandle.abort,
        accumulatedText: '',
        accumulatedReasoning: '',
        lastRenderedBreakIndex: 0,
        translationComplete: false,
        sectionsComplete: false,
        milestoneSaved: 0,
        backgroundTasksTriggered: false
    });
}

/**
 * Question answering using streaming: creates the streaming display, calls the
 * streaming API, and handles incremental content updates and completion.
 * @param {Translation} translation - The question translation object
 * @param {string} userMessage - The formatted user message
 * @param {string} effectiveModel - Model ID to use
 * @param {string} reasoningLevel - Reasoning effort level
 * @returns {Promise<void>}
 */
async function handleQuestionStreaming(
    translation: Translation,
    userMessage: string,
    effectiveModel: string,
    reasoningLevel: string,
    clearDraftsOnDone?: boolean
): Promise<void> {
    const refs = domRefsMap.get(translation);
    if (!refs) {
        console.warn('[handleQuestionStreaming] No DOM refs for translation', translation.id);
        return;
    }

    // Set up streaming display
    setupStreamingDisplay(refs, translation);

    // Start streaming
    const abortHandle = streamSendChatMessage(
        config!.openRouterApiKey!,
        userMessage,
        QUESTION_SYSTEM_PROMPT,
        effectiveModel,
        {
            onChunk: function(text: string, reasoning: string): void {
                const streamState = streamingStateMap.get(translation);
                if (!streamState) return;
                streamState.accumulatedText = text;
                streamState.accumulatedReasoning = reasoning;
                const display = computeStreamingDisplay(streamState, text, reasoning);
                scheduleStreamRender(streamState, function(): void {
                    if (streamingStateMap.get(translation) !== streamState) return;
                    paintStreamingContent(refs!, streamState, display, reasoning);
                });
            },
            onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                streamingStateMap.delete(translation);

                const qEntry = translation.entries[0];
                if (usage && qEntry) {
                    qEntry.usage = {
                        promptTokens: usage.prompt_tokens,
                        completionTokens: usage.completion_tokens,
                        totalTokens: usage.total_tokens
                    };
                }
                if (generationId && qEntry) {
                    qEntry.generationId = generationId;
                }

                translation.entries[0].translation = fullText;

                if (!fullText || !/\S/.test(fullText)) {
                    console.log('[handleQuestionStreaming] API returned empty answer');
                    translation.status = 'error';
                    translation.error = 'Question answer returned empty. Try again.';
                } else {
                    translation.status = 'complete';
                }

                teardownStreamingDisplay(refs!);
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                if (clearDraftsOnDone) {
                    clearDrafts();
                }
                updateTranslationItemContent(translation, refs!);
                refreshBalance();
            },
            onError: function(error: Error): void {
                streamingStateMap.delete(translation);
                console.error('[handleQuestionStreaming] Error:', error);
                translation.status = 'error';
                translation.error = error.message;
                teardownStreamingDisplay(refs!);
                updateTranslationItemContent(translation, refs!);
                refreshBalance();
            }
        },
        reasoningLevel,
        config!.questionTemperature
    );

    // Store streaming state
    streamingStateMap.set(translation, {
        abort: abortHandle.abort,
        accumulatedText: '',
        accumulatedReasoning: '',
        lastRenderedBreakIndex: 0,
        translationComplete: false,
        sectionsComplete: false,
        milestoneSaved: 0,
        backgroundTasksTriggered: false
    });
}

/**
 * Builds the user message for a quick question about the current draft.
 * Includes full conversation context, the current source text and intent,
 * and any previous Q&A from the current quick question dialog session.
 * When messageText is provided, it is used instead of sourceText/intent
 * (for input message quick questions).
 * @param {string} questionText - The user's question
 * @param {string} sourceText - Current source textarea content
 * @param {string} intentText - Current intent textarea content
 * @param {string} myLanguage - User's native language
 * @param {Array<{question: string, answer: string}>} previousQA - Previous Q&A pairs from within the same dialog
 * @param {string} [messageText] - Input message text (for message quick questions)
 * @returns {Promise<string>} Complete user message
 */
async function buildQuickQuestionMessage(
    questionText: string,
    sourceText: string,
    intentText: string,
    myLanguage: string,
    previousQA: Array<{question: string; answer: string}> = [],
    messageText?: string,
    translationText?: string,
    translationInstructions?: string,
    translationTags?: TranslationTag[],
    langInstructions?: string
): Promise<string> {
    const background = await getBackground();

    let message = "";

    if (background.trim()) {
        message += `<background>${background}</background>\n\n`;
    }

    const history = await buildHistorySection({
        activeDayCount: HISTORY_CONTEXT_DAYS,
        includeQuestions: true
    });
    if (history) {
        message += history + "\n\n";
    }

    if (translationText) {
        message += `<source_text>${sourceText}</source_text>\n`;
        if (intentText) {
            message += `<intent>${intentText}</intent>\n`;
        }
        message += `<translation>${translationText}</translation>\n`;
    } else if (messageText) {
        message += `<current_message>${messageText}</current_message>\n`;
    } else {
        message += `<draft_text>${sourceText}</draft_text>\n`;
        if (intentText) {
            message += `<intent>${intentText}</intent>\n`;
        }
    }

    if (translationInstructions || langInstructions || (translationTags && translationTags.length > 0)) {
        let refBlock = '';
        if (langInstructions) {
            refBlock += langInstructions;
        }
        if (translationInstructions) {
            if (refBlock) refBlock += '\n\n';
            refBlock += translationInstructions;
        }
        if (translationTags && translationTags.length > 0) {
            if (refBlock) refBlock += '\n\n';
            refBlock += 'The following inline tags may be used in the translation to indicate register/formality:\n';
            refBlock += translationTags.map(function(tag) {
                return `- ${tag.openTag}...${tag.closeTag}: ${tag.guidance}`;
            }).join('\n');
        }
        message += `<reference_translation_instructions>${refBlock}</reference_translation_instructions>\n\n`;
    }

    if (previousQA.length > 0) {
        message += "<previous_qa>\n";
        for (const qa of previousQA) {
            message += `Q: ${qa.question}\nA: ${qa.answer}\n\n`;
        }
        message += "</previous_qa>\n\n";
    }

    message += `<current_time val="${formatTimestampWithOffset(Date.now())}"/>\n`;
    message += `(${TIMESTAMP_NOTE})\n\n`;
    message += `<current_question>${questionText}</current_question>\n\n`;
    message += `<instructions>Answer in ${myLanguage}.</instructions>`;

    return message;
}

/**
 * Appends a synced translation to the current session's UI by timestamp.
 * Loads the translation from OPFS, validates it's not already present,
 * and renders it into the translations container via the standard template flow.
 * The item is placed at its chronological position, which may be older than the
 * currently loaded window. Does nothing if the translation is already displayed
 * or fails to load.
 * @param {number} timestamp - Translation timestamp (milliseconds)
 * @returns {Promise<void>}
 */
export async function appendTranslationFromSync(timestamp: number): Promise<void> {
    const translation = await loadSessionTranslation(currentSessionId, timestamp);
    if (!translation) return;

    if (allTranslations.some(function(t) { return t.id === translation.id; })) return;

    ensureEntries(translation);

    // Keep the window's timestamp index and day buckets current
    if (!sessionTranslationTimestamps.includes(timestamp)) {
        sessionTranslationTimestamps.push(timestamp);
        sessionTranslationTimestamps.sort(function(a, b) { return b - a; });
        sessionActiveDays = groupTimestampsByDay(sessionTranslationTimestamps);
    }
    loadedHistoryDays.add(getDayStart(timestamp));

    allTranslations = allTranslations.concat([translation])
        .sort(function(a, b) { return b.timestamp - a.timestamp; });

    const container = document.getElementById('translations-container');
    if (!container) return;

    renderTranslationItem(container, translation, 'chronological');
}

/** Which context a quick question is about */
type QuickQuestionKind = 'draft' | 'sourceMessage' | 'translation' | 'contextNote';

/**
 * Appends a question/answer pair to a quick question history container.
 * @param {HTMLElement} historyEl - Container to append to
 * @param {string} question - The user's question text
 * @param {boolean} isStreaming - Whether the answer is still loading
 * @returns {HTMLElement | null} The answer element for streaming updates, or null
 */
function appendQuickQuestionHistoryItem(
    historyEl: HTMLElement,
    question: string,
    isStreaming: boolean
): HTMLElement | null {
    const template = document.getElementById('quick-question-history-item-template') as HTMLTemplateElement | null;
    if (!template) return null;
    const itemClone = template.content.cloneNode(true) as DocumentFragment;
    const item = itemClone.firstElementChild as HTMLElement;
    const questionEl = item.querySelector('.quick-question-q') as HTMLElement | null;
    const answerEl = item.querySelector('.quick-question-a') as HTMLElement | null;
    if (questionEl) questionEl.textContent = question;
    if (answerEl) {
        if (isStreaming) {
            answerEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span class="ms-2">Thinking...</span>';
        } else {
            answerEl.innerHTML = '';
        }
    }
    historyEl.appendChild(itemClone);
    return answerEl;
}

/**
 * Clears the inline interpretation follow-up, aborting any answer still streaming.
 * @param {Translation} translation - Translation whose follow-up is being reset
 * @param {TranslationDomRefs} [refs] - Captured DOM references, if the caller has them
 * @returns {void}
 */
function resetInterpretationFollowup(translation: Translation, refs?: TranslationDomRefs): void {
    const abortFn = interpretationFollowupAbortMap.get(translation);
    if (abortFn) {
        abortFn();
        interpretationFollowupAbortMap.delete(translation);
    }

    const followupRefs = refs ?? domRefsMap.get(translation);
    if (!followupRefs) return;

    if (followupRefs.interpretationFollowupHistoryEl) {
        followupRefs.interpretationFollowupHistoryEl.innerHTML = '';
    }
    if (followupRefs.interpretationFollowupThinkingEl) {
        followupRefs.interpretationFollowupThinkingEl.style.display = 'none';
    }
    if (followupRefs.interpretationFollowupThinkingContentEl) {
        followupRefs.interpretationFollowupThinkingContentEl.textContent = '';
    }
    if (followupRefs.interpretationFollowupInputEl) {
        followupRefs.interpretationFollowupInputEl.value = '';
        followupRefs.interpretationFollowupInputEl.disabled = false;
    }
    if (followupRefs.interpretationFollowupAskBtn) {
        followupRefs.interpretationFollowupAskBtn.disabled = false;
    }
}

/**
 * Shows the inline interpretation follow-up only while a completed interpretation exists.
 * Hides and clears it whenever the interpretation is missing or being regenerated.
 * @param {Translation} translation - Translation whose follow-up is being updated
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @param {string | undefined} entryInterpretation - Current interpretation text
 * @param {boolean} entryInterpretationPending - Whether an interpretation is being generated
 * @returns {void}
 */
function updateInterpretationFollowupContent(
    translation: Translation,
    refs: TranslationDomRefs,
    entryInterpretation: string | undefined,
    entryInterpretationPending: boolean
): void {
    if (!refs.interpretationFollowupEl) return;

    const isAvailable = Boolean(entryInterpretation) && !entryInterpretationPending;
    refs.interpretationFollowupEl.style.display = isAvailable ? '' : 'none';

    if (!isAvailable) {
        resetInterpretationFollowup(translation, refs);
    }
}

/**
 * Asks a follow-up question about an interpretation and streams the answer inline.
 * The answer is ephemeral: it is never saved and disappears when the item re-renders.
 * @param {Translation} translation - Translation whose interpretation is being discussed
 * @param {string} questionText - The user's question
 * @param {Array<{question: string, answer: string}>} previousQA - Earlier Q&A in this chain
 * @returns {Promise<void>}
 */
async function askInterpretationFollowup(
    translation: Translation,
    questionText: string,
    previousQA: Array<{question: string, answer: string}>
): Promise<void> {
    const refs = domRefsMap.get(translation);
    const historyEl = refs?.interpretationFollowupHistoryEl;
    const thinkingEl = refs?.interpretationFollowupThinkingEl;
    const thinkingContentEl = refs?.interpretationFollowupThinkingContentEl;
    const followupInput = refs?.interpretationFollowupInputEl;
    const askBtn = refs?.interpretationFollowupAskBtn;
    if (!historyEl || !followupInput) return;

    const inputEl: HTMLTextAreaElement = followupInput;

    if (thinkingEl) {
        thinkingEl.style.display = 'none';
    }
    if (thinkingContentEl) {
        thinkingContentEl.textContent = '';
    }

    const answerEl = appendQuickQuestionHistoryItem(historyEl, questionText, true);
    inputEl.value = '';
    inputEl.disabled = true;
    if (askBtn) askBtn.disabled = true;

    /**
     * Shows a setup or request error in the answer slot and re-enables the input.
     * @param {string} message - Error message to display
     * @returns {void}
     */
    function showFollowupError(message: string): void {
        if (thinkingEl) {
            thinkingEl.style.display = 'none';
        }
        if (answerEl) {
            cancelStreamRender(answerEl);
            answerEl.innerHTML = '<span class="text-danger">' + message + '</span>';
        }
        inputEl.disabled = false;
        if (askBtn) askBtn.disabled = false;
    }

    try {
        const interpretationText = translation.entries?.[translation.activeEntryIndex ?? 0]?.interpretation ?? '';
        if (!interpretationText) {
            showFollowupError('No interpretation to ask about.');
            return;
        }
        if (!config || !config.openRouterApiKey) {
            showFollowupError('No API key configured.');
            return;
        }

        const session = await loadSession(currentSessionId);
        const effectiveModel = getQuickQuestionModelToUse(session);
        if (!effectiveModel) {
            showFollowupError('No model configured for quick questions.');
            return;
        }

        const userMessage = await buildInterpretationFollowupMessage(
            translation,
            interpretationText,
            previousQA,
            questionText
        );
        const systemPrompt = buildInterpretationSystemPrompt(session, INTERPRETATION_FOLLOWUP_PROMPT);

        const abortHandle = streamSendChatMessage(
            config.openRouterApiKey,
            userMessage,
            systemPrompt,
            effectiveModel,
            {
                onChunk: function(text: string, reasoning: string): void {
                    const hasReasoning = reasoning.length > 0;
                    const hasText = text.length > 0;
                    if (hasReasoning && !hasText) {
                        if (thinkingEl && thinkingContentEl) {
                            thinkingContentEl.textContent = reasoning;
                            thinkingEl.style.display = '';
                            thinkingEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                        }
                    } else if (hasText) {
                        if (thinkingEl) {
                            thinkingEl.style.display = 'none';
                        }
                        const targetEl = answerEl;
                        if (!targetEl || !targetEl.isConnected) return;
                        scheduleStreamRender(targetEl, function(): void {
                            targetEl.innerHTML = renderMarkdown(text);
                        });
                    }
                },
                onDone: function(fullText: string): void {
                    interpretationFollowupAbortMap.delete(translation);
                    if (thinkingEl) {
                        thinkingEl.style.display = 'none';
                    }
                    const targetEl = answerEl;
                    if (targetEl && targetEl.isConnected) {
                        cancelStreamRender(targetEl);
                        targetEl.innerHTML = renderMarkdown(fullText);
                    }
                    previousQA.push({ question: questionText, answer: fullText });
                    inputEl.disabled = false;
                    if (askBtn) askBtn.disabled = false;
                },
                onError: function(error: Error): void {
                    interpretationFollowupAbortMap.delete(translation);
                    if (thinkingEl) {
                        thinkingEl.style.display = 'none';
                    }
                    const targetEl = answerEl;
                    if (targetEl && targetEl.isConnected) {
                        cancelStreamRender(targetEl);
                        targetEl.innerHTML = '<span class="text-danger">Error: ' + error.message + '</span>';
                    }
                    inputEl.disabled = false;
                    if (askBtn) askBtn.disabled = false;
                }
            },
            getQuickQuestionReasoningToUse(session),
            config.questionTemperature
        );

        interpretationFollowupAbortMap.set(translation, abortHandle.abort);
    } catch (error) {
        showFollowupError((error as Error).message);
    }
}

    /**
     * Shows a quick question modal for asking about a draft or message.
     * Manages the ephemeral Q&A lifecycle. Supports follow-up questions within the same
     * dialog session. Nothing is persisted when the modal is closed.
     * Accepts optional options for context (sourceText, intentText, translationText),
     * a systemPrompt override, and the kind of context being asked about.
     * The first question asked about the text being composed (draft or translation) is
     * cached in memory so the next modal open pre-fills it. Follow-up questions in the
     * same chain do NOT update the cache, and questions about received messages or notes
     * are never cached.
     * @param {{ kind?: QuickQuestionKind; sourceText?: string; intentText?: string; systemPrompt?: string; placeholderQuestion?: string; prefillQuestion?: string; translationText?: string }} [options] - Context and prompt overrides
     * @returns {void}
     */
function showQuickQuestionModal(options?: {
    kind?: QuickQuestionKind;
    sourceText?: string;
    intentText?: string;
    systemPrompt?: string;
    placeholderQuestion?: string;
    prefillQuestion?: string;
    translationText?: string;
}): void {
    if (quickQuestionModalOpen) return;
    const template = document.getElementById('quick-question-modal-template') as HTMLTemplateElement | null;
    if (!template) return;
    quickQuestionModalOpen = true;

    const clone = template.content.cloneNode(true) as DocumentFragment;
    const modalEl = clone.firstElementChild as HTMLElement;
    document.body.appendChild(clone);

    const questionInput = modalEl.querySelector('#quick-question-input') as HTMLTextAreaElement | null;
    const submitBtn = modalEl.querySelector('#quick-question-submit-btn') as HTMLButtonElement | null;
    const cancelBtn = modalEl.querySelector('#quick-question-cancel-btn') as HTMLButtonElement | null;
    const thinkingEl = modalEl.querySelector('.translation-thinking') as HTMLElement | null;
    const thinkingContentEl = modalEl.querySelector('.thinking-content') as HTMLElement | null;
    const historyEl = modalEl.querySelector('.quick-question-history') as HTMLElement | null;

    if (options?.placeholderQuestion && questionInput) {
        questionInput.placeholder = options.placeholderQuestion;
    }

    if (options?.prefillQuestion && questionInput) {
        questionInput.value = options.prefillQuestion;
    }

    const modal = new Modal(modalEl);

    let abortQuickQuestion: (() => void) | null = null;
    let dialogHistory: Array<{question: string; answer: string}> = [];
    let currentAnswerEl: HTMLElement | null = null;

    let cleanedUp = false;

    function cleanup(): void {
        if (cleanedUp) return;
        cleanedUp = true;
        if (abortQuickQuestion) {
            abortQuickQuestion();
            abortQuickQuestion = null;
        }
        modalEl.removeEventListener('hidden.bs.modal', cleanup);
        if (modalEl.isConnected) {
            modalEl.remove();
        }
        quickQuestionModalOpen = false;
    }

    /**
     * Adds a Q&A pair to the history area. When isStreaming is true, the
     * answer slot shows a spinner and the returned element is used for
     * streaming updates.
     * @param {string} question - The user's question text
     * @param {boolean} isStreaming - Whether the answer is still loading
     * @returns {HTMLElement | null} The answer element for streaming, or null
     */
    function addHistoryItem(question: string, isStreaming: boolean): HTMLElement | null {
        if (!historyEl) return null;
        return appendQuickQuestionHistoryItem(historyEl, question, isStreaming);
    }

    /**
     * Shows an error in the currently streaming answer element.
     * @param {string} message - The error message to display
     * @returns {void}
     */
    function showErrorInCurrentAnswer(message: string): void {
        if (currentAnswerEl) {
            currentAnswerEl.innerHTML = '<span class="text-danger">' + message + '</span>';
        }
        currentAnswerEl = null;
    }

    let hasAutoScrolledThisAnswer = false;

    if (submitBtn) {
        submitBtn.addEventListener('click', async function() {
            hasAutoScrolledThisAnswer = false;
            const question = questionInput?.value.trim() || questionInput?.placeholder || "How's this?";
            const kind: QuickQuestionKind = options?.kind ?? 'draft';

            // Remember the first question asked about the text being composed so the
            // next open can pre-fill it. Received messages, notes, and interpretation
            // follow-ups are never remembered.
            if (dialogHistory.length === 0 && kind === 'translation') {
                cachedTranslationQuickQuestion = question;
            } else if (dialogHistory.length === 0 && kind === 'draft') {
                cachedDraftQuickQuestion = question;
            }

            if (submitBtn) submitBtn.disabled = true;
            if (questionInput) questionInput.disabled = true;
            if (thinkingEl) thinkingEl.style.display = 'none';

            currentAnswerEl = addHistoryItem(question, true);

            // The kind is explicit because a context note also carries sourceText,
            // so "which option fields are present" is no longer a reliable signal.
            const isTranslationQuestion = kind === 'translation';
            const isMessageQuestion = kind === 'sourceMessage' || kind === 'contextNote';
            const sourceText = (isMessageQuestion || isTranslationQuestion)
                ? (options?.sourceText ?? '')
                : (document.getElementById('source-textarea') as HTMLTextAreaElement | null)?.value ?? '';
            let intentText: string;
            if (kind === 'translation') {
                intentText = options?.intentText ?? '';
            } else if (kind === 'draft') {
                intentText = (document.getElementById('intent-textarea') as HTMLTextAreaElement | null)?.value ?? '';
            } else {
                intentText = '';
            }

            if (!config || !config.openRouterApiKey) {
                showErrorInCurrentAnswer('No API key configured.');
                if (submitBtn) submitBtn.disabled = false;
                if (questionInput) questionInput.disabled = false;
                return;
            }

            const session = await loadSession(currentSessionId);
            const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
            const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';
            const theirLang = LANGUAGES.find(function(l) { return l.id === session?.theirLanguage; });
            const theirLangName = theirLang?.name ?? session?.theirLanguage ?? 'Foreign';

            const effectiveModel = getQuickQuestionModelToUse(session);
            if (!effectiveModel) {
                showErrorInCurrentAnswer('No model configured for quick questions.');
                if (submitBtn) submitBtn.disabled = false;
                if (questionInput) questionInput.disabled = false;
                return;
            }

            const reasoningLevel = getQuickQuestionReasoningToUse(session);
            const translationInstructions = session?.translationInstructions ?? '';
            const translationTags = session?.translationTags;
            const langInstructionsKey = 'langInstructions_' + (session?.theirLanguage ?? '');
            const langInstructions = await getPreference(langInstructionsKey) ?? undefined;
            const translationModelId = getTranslationModelToUse(session);
            const translationModelName = translationModelId ? getModelName(translationModelId) : 'an LLM';
            const effectivePrompt = options?.systemPrompt ?? QUICK_QUESTION_DRAFT_PROMPT;
            const systemPrompt = effectivePrompt
                .replace(/\[LANGUAGE\]/g, myLangName)
                .replace(/\[TARGET_LANGUAGE\]/g, theirLangName)
                .replace(/\[TRANSLATION_MODEL\]/g, translationModelName);
            const userMessage = await buildQuickQuestionMessage(
                question, sourceText, intentText, myLangName, dialogHistory,
                isMessageQuestion ? sourceText : undefined,
                options?.translationText,
                translationInstructions,
                translationTags,
                langInstructions
            );

            const abortHandle = streamSendChatMessage(
                config.openRouterApiKey,
                userMessage,
                systemPrompt,
                effectiveModel,
                {
                    onChunk: function(text: string, reasoning: string): void {
                        const hasReasoning = reasoning.length > 0;
                        const hasText = text.length > 0;
                        if (hasReasoning && !hasText) {
                            if (thinkingEl && thinkingContentEl) {
                                thinkingContentEl.textContent = reasoning;
                                thinkingEl.style.display = '';
                            }
                            if (currentAnswerEl) currentAnswerEl.innerHTML = '';
                            if (!hasAutoScrolledThisAnswer && dialogHistory.length > 0) {
                                hasAutoScrolledThisAnswer = true;
                                submitBtn?.scrollIntoView({ behavior: 'smooth', block: 'end' });
                            }
                        } else if (hasText) {
                            if (thinkingEl) thinkingEl.style.display = 'none';
                            const answerEl = currentAnswerEl;
                            if (answerEl) {
                                scheduleStreamRender(answerEl, function(): void {
                                    answerEl.innerHTML = renderMarkdown(text);
                                });
                            }
                        }
                    },
                    onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                        abortQuickQuestion = null;
                        if (thinkingEl) thinkingEl.style.display = 'none';
                        if (currentAnswerEl) {
                            cancelStreamRender(currentAnswerEl);
                            currentAnswerEl.innerHTML = renderMarkdown(fullText);
                        }
                        dialogHistory.push({question, answer: fullText});
                        currentAnswerEl = null;
                        if (submitBtn) {
                            submitBtn.textContent = 'Ask another';
                            submitBtn.disabled = false;
                        }
                        if (questionInput) {
                            questionInput.disabled = false;
                            questionInput.value = '';
                            questionInput.placeholder = "Elaborate?";
                        }
                    },
                    onError: function(error: Error): void {
                        abortQuickQuestion = null;
                        if (thinkingEl) thinkingEl.style.display = 'none';
                        console.error('[quickQuestion] Error:', error);
                        if (currentAnswerEl) {
                            cancelStreamRender(currentAnswerEl);
                            currentAnswerEl.innerHTML = '<span class="text-danger">Error: ' + error.message + '</span>';
                        }
                        currentAnswerEl = null;
                        if (submitBtn) {
                            submitBtn.textContent = 'Ask';
                            submitBtn.disabled = false;
                        }
                        if (questionInput) {
                            questionInput.disabled = false;
                        }
                    }
                },
                reasoningLevel,
                config.questionTemperature
            );

            abortQuickQuestion = abortHandle.abort;
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', function() {
            if (!modalEl.isConnected) return;
            modal.hide();
        });
    }

    modalEl.addEventListener('hidden.bs.modal', cleanup);

    modal.show();
}