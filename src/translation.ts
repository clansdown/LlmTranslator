/**
 * Translation Module
 * Handles translation functionality for input and output panes
 */

import { translateStructured, sendChatMessage, streamSendChatMessage, streamTranslateStructured, parseTag } from './openrouter';
import { getPreference, savePreference, listSessions, saveSession, loadSession, deleteSession as storageDeleteSession, getOrCreateDefaultSession, saveSessionTranslation, listSessionTranslations, deleteSessionTranslation, loadSessionTranslation } from './storage';
import { DEBUG_TRANSLATIONS, DEBUG_SESSIONS } from './debug';
import * as ui from './ui';
import { LANGUAGES } from './languages';
import { INPUT_SYSTEM_PROMPT, OUTPUT_SYSTEM_PROMPT, INPUT_INSTRUCTIONS, OUTPUT_INSTRUCTIONS, LITERAL_RETRANSLATION_PROMPT, OUTPUT_LITERAL_RETRANSLATION_PROMPT, QUESTION_SYSTEM_PROMPT, WORD_DEFINITIONS_PROMPT, INTERPRETATION_PROMPT, QUICK_QUESTION_DRAFT_PROMPT, QUICK_QUESTION_MESSAGE_PROMPT, QUICK_QUESTION_TRANSLATION_PROMPT } from './prompts';
import { renderMarkdown, normalizeForMarkdown } from './markdown';
import { readLocalFile, writeLocalFile, deleteLocalFile } from './opfs';
import type { Translation, TranslationEntry, TranslationWordItem, WordItem, PunctItem, NewlineItem } from './types/translation';
import type { StreamingAbortHandle, StreamCallbacks, StreamUsage } from './types/api';
import type { Config } from './types/config';
import type { TranslationTag } from './types/translationTag';
import type { TranslationSession, ReasoningLevel } from './types/session';
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

/** Timeout handle for draft auto-save debounce */
let draftSaveTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * In-memory translation array - source of truth for translations
 * @type {Translation[]}
 */
let allTranslations: Translation[] = [];

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
    interpretationThinkingEl: HTMLElement | null;
    interpretationThinkingContentEl: HTMLElement | null;
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
    backgroundTasksTriggered: boolean;
}

/**
 * Map from streaming Translation objects to their ephemeral streaming state.
 * @type {WeakMap<Translation, StreamingState>}
 */
const streamingStateMap: WeakMap<Translation, StreamingState> = new WeakMap();

/**
 * Extracts only the TRANSLATION portion of text for display during streaming.
 * Once </TRANSLATION> is seen, the translation is complete and non-translation
 * content (explanation, nuances) should not be shown in the target area.
 * @param {string} text - Raw accumulated streaming text
 * @returns {{ displayText: string; isComplete: boolean }}
 */
function extractTranslationForDisplay(text: string): { displayText: string; isComplete: boolean } {
    const openIdx = text.indexOf('<TRANSLATION>');
    const closeIdx = text.indexOf('</TRANSLATION>');

    if (openIdx !== -1 && closeIdx !== -1) {
        return {
            displayText: text.substring(openIdx + '<TRANSLATION>'.length, closeIdx),
            isComplete: true
        };
    } else if (openIdx !== -1) {
        return {
            displayText: text.substring(openIdx + '<TRANSLATION>'.length),
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
    currentLiteralModel = getLiteralModelToUse(session);
    currentInterpretationModel = getInterpretationModelToUse(session);
    await savePreference('currentSession', sessionId);

    allTranslations = [];
    clearTranslationContainers();

    const MAX_HISTORY = 1000;
    const inputItems = await listSessionTranslations(sessionId, 'input', MAX_HISTORY);
    const outputItems = await listSessionTranslations(sessionId, 'output', MAX_HISTORY);
    const questionItems = await listSessionTranslations(sessionId, 'question', MAX_HISTORY);
    allTranslations = [...inputItems, ...outputItems, ...questionItems]
        .sort(function(a, b) { return b.timestamp - a.timestamp; });

    for (const t of allTranslations) {
        ensureEntries(t);
    }

    // Fix up interrupted translations from potential previous crashes
    for (const t of allTranslations) {
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
                    console.error('[setCurrentSession] Failed to save fixed translation:', e);
                });
            }
        }
    }

    renderAllTranslations();

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
 * Creates a new session
 * @returns {Promise<string>} New session ID
 */
export async function createSession(name?: string): Promise<string> {
    if (DEBUG_SESSIONS) {
        console.log('[createSession] Creating new session');
    }

    const now = Date.now();

    const newSession: TranslationSession = {
        id: generateUuid(),
        name: name ?? "New Conversation",
        model: null,
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
    return session?.background ?? "";
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
 * Builds the history section for the user message
 * Returns history from the last 7 days with activity
 * @param {boolean} includeQuestions - Whether to include question/answer pairs in history
 * @returns {string} History section or empty string
 */
function buildHistorySection(includeQuestions: boolean = true, sourcesOnly: boolean = false, respectQuestionToggle: boolean = true): string {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const cutoff = now - SEVEN_DAYS_MS;

    const activeDays = new Set<number>();
    for (const t of allTranslations) {
        if (t.status === 'complete' && t.timestamp >= cutoff) {
            const dayStart = new Date(t.timestamp).setHours(0, 0, 0, 0);
            activeDays.add(dayStart);
        }
    }

    if (activeDays.size === 0) {
        return "";
    }

    const translationsWithinDays = allTranslations.filter(function(t) {
        if (t.status !== 'complete') return false;
        const dayStart = new Date(t.timestamp).setHours(0, 0, 0, 0);
        return activeDays.has(dayStart);
    });

    translationsWithinDays.sort(function(a, b) { return a.timestamp - b.timestamp; });

    let history = "<HISTORY>\n";
    for (const t of translationsWithinDays) {
        ensureEntries(t);
        const entry = t.entries[t.activeEntryIndex ?? 0];
        if (!entry) continue;
        if (t.pill === 'input') {
            history += `<THEM>${entry.source}</THEM>\n`;
            if (!sourcesOnly) {
                history += `<THEM>${entry.translation}</THEM>\n`;
            }
        } else if (t.pill === 'output') {
            history += `<ME>${entry.source}</ME>\n`;
            if (!sourcesOnly) {
                history += `<ME>${entry.translation}</ME>\n`;
            }
        } else if (t.pill === 'question' && includeQuestions && (!respectQuestionToggle || t.includeInContext === true)) {
            history += `<ALREADY_ANSWERED>${entry.source}</ALREADY_ANSWERED>\n`;
            if (!sourcesOnly) {
                history += `<AGENTANSWER>${entry.translation}</AGENTANSWER>\n`;
            }
        }
    }
    history += "</HISTORY>";
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
 * Ensures a translation has entries[] populated (for backward compatibility from old saves)
 * If entries is missing or empty, constructs entries[0] from top-level fields
 * @param {Translation} translation - Translation object to check
 * @returns {void}
 */
function ensureEntries(translation: Translation): void {
    if (translation.entries && translation.entries.length > 0) {
        return;
    }
    /** @type {TranslationEntry} */
    const entry: TranslationEntry = {
        source: (translation as any).source ?? '',
        intent: (translation as any).intent ?? '',
        model: (translation as any).model ?? '',
        modelName: (translation as any).modelName ?? '',
        prompt: (translation as any).prompt ?? '',
        promptContent: (translation as any).promptContent ?? '',
        translation: (translation as any).translation ?? '',
        explanation: (translation as any).explanation ?? '',
        nuances: (translation as any).nuances ?? '',
        reasoning: (translation as any).reasoning ?? '',
        reasoningDetails: (translation as any).reasoningDetails ?? '',
        literalRetranslation: (translation as any).literalRetranslation,
        literalPending: (translation as any).literalPending,
        wordDefinitions: (translation as any).wordDefinitions,
        wordData: (translation as any).wordData,
        wordPending: (translation as any).wordPending,
        interpretation: (translation as any).interpretation,
        interpretationPending: (translation as any).interpretationPending
    };
    translation.entries = [entry];
    translation.activeEntryIndex = 0;
    translation.includeInContext = (translation as any).includeInContext ?? false;
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
 * Builds history section for interpretation - last 2 days with input/output translations
 * Excludes questions
 * @returns {string} History section or empty string
 */
function buildInterpretationHistory(): string {
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const cutoff = now - TWO_DAYS_MS;

    const dayMap = new Map<number, Translation[]>();
    for (const t of allTranslations) {
        if (t.status !== 'complete') continue;
        if (t.pill === 'question') continue;
        if (t.timestamp < cutoff) continue;
        const dayStart = new Date(t.timestamp).setHours(0, 0, 0, 0);
        if (!dayMap.has(dayStart)) {
            dayMap.set(dayStart, []);
        }
        dayMap.get(dayStart)!.push(t);
    }

    if (dayMap.size === 0) {
        return "";
    }

    const sortedDays = Array.from(dayMap.keys()).sort(function(a, b) { return b - a; });
    const lastTwoDays = sortedDays.slice(0, 2);

    /** @type {Translation[]} */
    const translationsForHistory: Translation[] = [];
    for (const day of lastTwoDays) {
        const dayTranslations = dayMap.get(day) ?? [];
        dayTranslations.sort(function(a, b) { return a.timestamp - b.timestamp; });
        translationsForHistory.push(...dayTranslations);
    }

    let history = "<HISTORY>\n";
    for (const t of translationsForHistory) {
        ensureEntries(t);
        const entry = t.entries[t.activeEntryIndex ?? 0];
        if (!entry) continue;
        if (t.pill === 'input') {
            history += `<THEM>${entry.source}</THEM>\n`;
            history += `<THEM>${entry.translation}</THEM>\n`;
        } else if (t.pill === 'output') {
            history += `<ME>${entry.source}</ME>\n`;
            history += `<ME>${entry.translation}</ME>\n`;
        }
    }
    history += "</HISTORY>";
    return history;
}

/**
 * Builds the user message for interpretation
 * @param {Translation} translation - Translation to interpret
 * @returns {Promise<string>} Formatted message
 */
async function buildInterpretationMessage(translation: Translation): Promise<string> {
    const background = await getBackground();
    const session = await loadSession(currentSessionId);
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';

    let message = "";

    if (background.trim()) {
        message += `<BACKGROUND>${background}</BACKGROUND>\n\n`;
    }

    const history = buildInterpretationHistory();
    if (history) {
        message += history + "\n\n";
    }

    const entry = translation.entries?.[translation.activeEntryIndex ?? 0];
    const translationText = entry?.translation ?? (translation as any).translation ?? '';
    message += `<INTERPRET>${translationText}</INTERPRET>\n\n`;
    message += `<INSTRUCTIONS>Explain how the listener will understand this message — both text and subtext — given their linguistic and cultural context. Write your explanation in ${myLangName}.</INSTRUCTIONS>`;

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

    const quickQuestionBtn = document.getElementById('quick-question-btn');
    if (quickQuestionBtn) {
        quickQuestionBtn.addEventListener('click', function() {
            if (quickQuestionModalOpen) return;
            showQuickQuestionModal();
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
        message += `<BACKGROUND>${background}</BACKGROUND>\n\n`;
    }

    const history = buildHistorySection(pill !== 'input', false, true);
    if (history) {
        message += history + "\n\n";
    }

    message += `<TRANSLATE>${sourceText}</TRANSLATE>\n\n`;
    message += `<INSTRUCTIONS>${instructions}</INSTRUCTIONS>`;

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

        const translation: Translation = {
            id: generateUuid(),
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
        message += `<BACKGROUND>${background}</BACKGROUND>\n\n`;
    }

    const history = buildHistorySection(true, true, false);
    if (history) {
        message += history + "\n\n";
    }

    message += `<QUESTION>${questionText}</QUESTION>\n\n`;
    const langInstruction = myLanguage ? ` Write your answer in ${myLanguage}.` : '';
    message += `<INSTRUCTIONS>Answer the user's question clearly and helpfully.${langInstruction}</INSTRUCTIONS>`;

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

        const translation: Translation = {
            id: generateUuid(),
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
                refs.toggleSectionsBtn!.textContent = '▼';
                translation.sectionsCollapsed = false;
            } else {
                refs.sectionsArea!.classList.add('translation-sections-collapsed');
                refs.toggleSectionsBtn!.textContent = '▶';
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
 * Renders a single translation item, creating or updating DOM element.
 * Captures all dynamic child element references once during creation and stores them
 * in domRefsMap for efficient subsequent updates.
 * @param {HTMLElement} container - Container element
 * @param {Translation} translation - Translation object
 * @returns {void}
 */
function renderTranslationItem(container: HTMLElement, translation: Translation): void {
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
        const template = translation.pill === 'question'
            ? document.getElementById('question-item-template') as HTMLTemplateElement | null
            : translation.pill === 'input'
            ? document.getElementById('input-item-template') as HTMLTemplateElement | null
            : document.getElementById('translation-item-template') as HTMLTemplateElement | null;
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
            interpretationThinkingEl: interpretationPane?.querySelector('.translation-thinking') as HTMLElement | null,
            interpretationThinkingContentEl: interpretationPane?.querySelector('.thinking-content') as HTMLElement | null,
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
                    sourceText: sourceText,
                    systemPrompt: QUICK_QUESTION_MESSAGE_PROMPT,
                    defaultQuestion: 'What does this mean?'
                });
            });
        }

        // Wire quick question button on output (translation) items
        if (refs.quickQuestionBtn && translation.pill !== 'input') {
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
                    sourceText: sourceText,
                    intentText: entry.intent ?? '',
                    translationText: targetText,
                    systemPrompt: QUICK_QUESTION_TRANSLATION_PROMPT,
                    defaultQuestion: 'What does this mean?'
                });
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

        container.insertBefore(element, container.firstChild);
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
 * For streaming state, use setupStreamingDisplay/updateStreamingContent/teardownStreamingDisplay instead.
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
                refs.interpretationEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Interpreting...</span>';
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = 'none';
            } else if (entryInterpretation) {
                refs.interpretationEl.innerHTML = renderMarkdown(entryInterpretation);
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            } else {
                refs.interpretationEl.innerHTML = '';
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            }
        }
        if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = 'none';
        if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = 'none';
        if (refs.sectionsArea && refs.toggleSectionsBtn) {
            if (translation.sectionsCollapsed) {
                refs.sectionsArea.classList.add('translation-sections-collapsed');
                refs.toggleSectionsBtn.textContent = '▶';
            } else {
                refs.sectionsArea.classList.remove('translation-sections-collapsed');
                refs.toggleSectionsBtn.textContent = '▼';
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
                refs.interpretationEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Interpreting...</span>';
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = 'none';
            } else if (entryInterpretation) {
                refs.interpretationEl.innerHTML = renderMarkdown(entryInterpretation);
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            } else {
                refs.interpretationEl.innerHTML = '';
                if (refs.regenerateInterpretationBtn) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            }
        }

        if (refs.regenerateLiteralBtn) refs.regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
        if (refs.regenerateInterpretationBtn && !entryInterpretationPending) refs.regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';

        if (refs.sectionsArea && refs.toggleSectionsBtn) {
            if (translation.sectionsCollapsed) {
                refs.sectionsArea.classList.add('translation-sections-collapsed');
                refs.toggleSectionsBtn.textContent = '▶';
            } else {
                refs.sectionsArea.classList.remove('translation-sections-collapsed');
                refs.toggleSectionsBtn.textContent = '▼';
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

    await deleteSessionTranslation(currentSessionId, translation.timestamp);
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

    if (translation.pill === 'question') {
        console.error('[retranslateFromEdit] Cannot retranslate a question');
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
    entry.interpretationPending = true;
    entry.interpretation = undefined;
    updateTranslationItem(translation);

    const message = await buildInterpretationMessage(translation);
    const interpModel = getInterpretationModelToUse(session)!;
    console.log('[regenerateInterpretation] Starting interpretation with model:', interpModel);
    const abortHandle = streamSendChatMessage(
        config!.openRouterApiKey!,
        message,
        INTERPRETATION_PROMPT,
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
                if (iRefs.interpretationEl) {
                    iRefs.interpretationEl.innerHTML = renderMarkdown(entry.interpretation);
                }
                if (iRefs.regenerateInterpretationBtn) {
                    iRefs.regenerateInterpretationBtn.style.display = 'none';
                }
            },
            onDone: function(fullText: string, fullReasoning: string, generationId: string | null): void {
                interpretationAbortMap.delete(translation);
                entry.interpretation = fullText;
                entry.interpretationPending = false;
                const iRefs = domRefsMap.get(translation);
                if (iRefs?.interpretationThinkingEl) {
                    iRefs.interpretationThinkingEl.style.display = 'none';
                }
                if (generationId) {
                    storeGenerationInfo(generationId, config!.openRouterApiKey!, entry);
                }
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
            },
            onError: function(error: Error): void {
                interpretationAbortMap.delete(translation);
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
                const { xml: wordXml, generationId: wordGenerationId } = await fetchWordDefinitions(wordDefModel, getWordDefReasoningToUse(session), wordText, myLangName);
                entry.wordDefinitions = wordXml;

                // Fetch generation info after 1s delay
                storeGenerationInfo(wordGenerationId, config!.openRouterApiKey!, entry);

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
        entry.interpretationPending = true;
        entry.interpretation = undefined;
        updateTranslationItem(translation);

        const message = await buildInterpretationMessage(translation);
        console.log('[interpretation] Starting interpretation with model:', interpModel);
        const abortHandle = streamSendChatMessage(
            config!.openRouterApiKey!,
            message,
            INTERPRETATION_PROMPT,
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
                    if (iRefs.interpretationEl) {
                        iRefs.interpretationEl.innerHTML = renderMarkdown(entry.interpretation);
                    }
                    if (iRefs.regenerateInterpretationBtn) {
                        iRefs.regenerateInterpretationBtn.style.display = 'none';
                    }
                },
                onDone: function(fullText: string, fullReasoning: string, generationId: string | null): void {
                    interpretationAbortMap.delete(translation);
                    entry.interpretation = fullText;
                    entry.interpretationPending = false;
                    const iRefs = domRefsMap.get(translation);
                    if (iRefs?.interpretationThinkingEl) {
                        iRefs.interpretationThinkingEl.style.display = 'none';
                    }
                    if (generationId) {
                        storeGenerationInfo(generationId, config!.openRouterApiKey!, entry);
                    }
                    syncTopLevelFromActive(translation);
                    saveSessionTranslation(currentSessionId, translation);
                    updateTranslationItem(translation);
                },
                onError: function(error: Error): void {
                    interpretationAbortMap.delete(translation);
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
 * Parses the XML word definitions response into structured data
 * @param {string} xml - Raw XML from the API
 * @returns {TranslationWordItem[]} Parsed word items
 */
function parseWordDefinitions(xml: string): TranslationWordItem[] {
    /** @type {TranslationWordItem[]} */
    const items: TranslationWordItem[] = [];

    xml = xml.replace(/```[\s\S]*?```/g, function(m) {
        return m.replace(/```\w*\n?/, '').replace(/\n?```/, '');
    });

    console.log('[wordDefinitions] Parsing XML, raw length:', xml.length, 'first 300 chars:', xml.substring(0, 300));

    const itemRegex = /<ITEM><WORD>([\s\S]*?)<\/WORD><DEF>([\s\S]*?)<\/DEF><EXP>([\s\S]*?)<\/EXP><\/ITEM>/g;
    const nonItemParts = xml.split(/(<ITEM>[\s\S]*?<\/ITEM>)/);

    console.log('[wordDefinitions] Split into', nonItemParts.length, 'parts');

    for (const part of nonItemParts) {
        if (/^<ITEM>/.test(part)) {
            const match = itemRegex.exec(part);
            if (match) {
                items.push({
                    type: 'word',
                    word: match[1].trim(),
                    def: match[2].trim(),
                    exp: match[3].trim()
                });
            } else {
                console.log('[wordDefinitions] ITEM regex failed on part:', part.substring(0, 200));
            }
            itemRegex.lastIndex = 0;
        } else {
            const punctRegex = /<P>([\s\S]*?)<\/P>/g;
            let punctMatch;
            while ((punctMatch = punctRegex.exec(part)) !== null) {
                items.push({
                    type: 'punct',
                    text: punctMatch[1]
                });
            }
            const nlRegex = /<NL\s*\/>/g;
            let nlMatch;
            while ((nlMatch = nlRegex.exec(part)) !== null) {
                items.push({
                    type: 'nl'
                });
            }
        }
    }

    console.log('[wordDefinitions] Parse complete, total items:', items.length);
    return items;
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
    if (refs.interpretationEl) refs.interpretationEl.textContent = 'Awaiting translation...';
    if (refs.wordsContent) refs.wordsContent.textContent = 'Awaiting translation...';

    // Update char count for streaming state
    const sourceLen = translation.entries?.[0]?.source?.length ?? 0;
    if (refs.charCountEl) {
        refs.charCountEl.textContent = `(${sourceLen}/—)`;
    }
}

/**
 * Updates the streaming display with new accumulated text and reasoning content.
 * Shows reasoning (thinking) content while main text hasn't arrived yet.
 * Renders completed paragraphs as markdown, shows current paragraph as raw text.
 * Only the text within <TRANSLATION> tags is displayed; explanation and nuances
 * content is excluded from the target area during streaming.
 * @param {TranslationDomRefs} refs - Captured DOM references
 * @param {StreamingState} streamingState - Current streaming state for this translation
 * @param {string} text - Accumulated main content text
 * @param {string} reasoning - Accumulated reasoning content text
 * @returns {void}
 */
function updateStreamingContent(
    refs: TranslationDomRefs,
    streamingState: StreamingState,
    text: string,
    reasoning: string
): void {
    // Hide spinner once any content starts arriving
    const hasReasoning = reasoning.length > 0;
    const hasText = text.length > 0;
    if (refs.spinnerEl) {
        refs.spinnerEl.style.display = (hasReasoning || hasText) ? 'none' : 'block';
    }

    if (refs.thinkingEl) {
        if (hasReasoning && !hasText) {
            refs.thinkingEl.style.display = '';
            if (refs.thinkingContentEl) {
                refs.thinkingContentEl.textContent = reasoning;
            }
        } else {
            refs.thinkingEl.style.display = 'none';
        }
    }

    if (!hasText) return;

    // Extract only the TRANSLATION portion for display — explanation and nuances
    // are excluded from the target area during streaming
    const { displayText, isComplete } = extractTranslationForDisplay(text);

    // Mark translation complete once we've seen the closing tag
    if (isComplete) {
        streamingState.translationComplete = true;
    }

    // Find the streaming structure inside target element
    const markdownEl = refs.targetEl?.querySelector('.streaming-markdown') as HTMLElement | null;
    const rawEl = refs.targetEl?.querySelector('.streaming-raw') as HTMLElement | null;
    if (!markdownEl || !rawEl) return;

    if (isComplete) {
        markdownEl.innerHTML = renderMarkdown(normalizeForMarkdown(displayText));
        rawEl.textContent = '';
        streamingState.lastRenderedBreakIndex = displayText.length;
    } else {
        // Check if new paragraphs were completed since last render
        const lastDoubleNewline = displayText.lastIndexOf('\n\n');

        if (lastDoubleNewline !== -1 && lastDoubleNewline + 2 > streamingState.lastRenderedBreakIndex) {
            const completedPart = displayText.substring(0, lastDoubleNewline + 2);
            markdownEl.innerHTML = renderMarkdown(normalizeForMarkdown(completedPart));
            streamingState.lastRenderedBreakIndex = lastDoubleNewline + 2;
        }

        // Show current incomplete paragraph as raw text
        const remainingText = displayText.substring(streamingState.lastRenderedBreakIndex);
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

/**
 * Extracts a structured TranslationResult from raw text by parsing XML tags.
 * Falls back to using the full text as translation if no TRANSLATION tag is found.
 * @param {string} rawText - Raw response text with XML tags
 * @returns {{translation: string, explanation: string, nuances: string}}
 */
function extractStructuredResult(rawText: string): { translation: string; explanation: string; nuances: string } {
    const result = {
        translation: parseTag(rawText, 'TRANSLATION'),
        explanation: parseTag(rawText, 'EXPLANATION'),
        nuances: parseTag(rawText, 'NUANCES')
    };

    if (!result.translation) {
        result.translation = rawText;
    }

    return result;
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

/**
 * Strips recognized translation tags from translated text
 * Only strips well-formed opening and closing tags independently
 * @param {string} text - Translation text potentially containing tags
 * @param {TranslationTag[]} tags - Defined tags to strip
 * @returns {string} Text with tags removed
 */
function stripTranslationTags(text: string, tags: TranslationTag[]): string {
    let cleaned = text;
    for (const tag of tags) {
        const openEscaped = tag.openTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const closeEscaped = tag.closeTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        cleaned = cleaned.replace(new RegExp(openEscaped, 'g'), '');
        cleaned = cleaned.replace(new RegExp(closeEscaped, 'g'), '');
    }
    return cleaned;
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

/**
 * Fetches generation info from OpenRouter after a 1-second delay.
 * Required because OpenRouter's generation info endpoint needs time to propagate.
 * @param {string} apiKey - OpenRouter API key
 * @param {string} generationId - Generation ID from the API response
 * @returns {Promise<import('./types/api').GenerationInfo | null>} Generation info or null on failure
 */
async function fetchGenerationInfoWithDelay(apiKey: string, generationId: string): Promise<import('./types/api').GenerationInfo | null> {
    await new Promise(function(resolve) { return setTimeout(resolve, 3000); });
    try {
        const { getGenerationInfo } = await import('./openrouter');
        const info = await getGenerationInfo(apiKey, generationId);
        console.log('[GenerationInfo] ID:', generationId, 'Tokens:', info.usage, 'Cost:', info.cost);
        return info;
    } catch (error) {
        console.error('[GenerationInfo] Failed for', generationId, ':', error);
        return null;
    }
}

/**
 * Stores generation info (usage tokens, cost) on a TranslationEntry.
 * Only stores if generationId is provided and entry exists.
 * @param {string | null} generationId - OpenRouter generation ID
 * @param {string} apiKey - OpenRouter API key
 * @param {import('./types/translation').TranslationEntry | null | undefined} entry - Entry to store info on
 * @returns {Promise<void>}
 */
async function storeGenerationInfo(
    generationId: string | null,
    apiKey: string,
    entry: TranslationEntry | null | undefined
): Promise<void> {
    if (!generationId || !entry) return;
    const genInfo = await fetchGenerationInfoWithDelay(apiKey, generationId);
    if (genInfo) {
        entry.generationId = generationId;
        entry.usage = {
            promptTokens: genInfo.usage?.prompt_tokens,
            completionTokens: genInfo.usage?.completion_tokens,
            totalTokens: genInfo.usage?.total_tokens
        };
        entry.cost = genInfo.cost;
    }
}

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
                updateLiteralStreamingContent(refs!, accumulatedText);
            },
            onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                literalStreamingStateMap.delete(translation);

                // Fetch generation info after 1s delay
                if (generationId) {
                    storeGenerationInfo(generationId, config!.openRouterApiKey!, entry);
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
                const { xml: wordXml, generationId: wordGenerationId } = await fetchWordDefinitions(wordDefModel, getWordDefReasoningToUse(session), translationText, myLangName);
                translation.entries[0].wordDefinitions = wordXml;

                // Fetch generation info after 1s delay
                storeGenerationInfo(wordGenerationId, config!.openRouterApiKey!, translation.entries[0]);

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
                const { content: interpretationResult, generationId } = await sendChatMessage(
                    config!.openRouterApiKey!,
                    message,
                    INTERPRETATION_PROMPT,
                    interpModel,
                    getInterpretationReasoningToUse(session),
                    config!.temperature
                );
                translation.entries[0].interpretation = interpretationResult;

                // Fetch generation info after 1s delay
                storeGenerationInfo(generationId, config!.openRouterApiKey!, translation.entries[0]);

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
        const translationInstructionsBlock = translationInstructions
            ? `The following are instructions on how the translation should be styled and presented:\n<TRANSLATIONINSTRUCTIONS>${translationInstructions}</TRANSLATIONINSTRUCTIONS>`
            : '';
        const intentBlock = intent
            ? `The following is guidance on the intent of the text to be translated:\n<INTENT>${intent}</INTENT>`
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
                updateStreamingContent(refs!, streamState, text, reasoning);

                // Fallback: if </TRANSLATION> is missing but next section has started
                if (!streamState.translationComplete) {
                    const openIdx = text.indexOf('<TRANSLATION>');
                    const explanationIdx = text.indexOf('<EXPLANATION>');
                    const nuancesIdx = text.indexOf('<NUANCES>');
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
                            activeEntry.translation = result.translation;
                        }
                        if (!options?.skipBackgroundTasks) {
                            regenerateIndependentSections(translation.id);
                        }
                    }
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
                // Skip if already triggered early from onChunk when </TRANSLATION> was detected
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
                updateStreamingContent(refs!, streamState, text, reasoning);
            },
            onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                streamingStateMap.delete(translation);

                // Fetch generation info after 1s delay (fire-and-forget)
                if (generationId) {
                    storeGenerationInfo(generationId, config!.openRouterApiKey!, translation.entries[0]);
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
    translationInstructions?: string
): Promise<string> {
    const background = await getBackground();

    let message = "";

    if (background.trim()) {
        message += `<BACKGROUND>${background}</BACKGROUND>\n\n`;
    }

    const history = buildHistorySection(true, true, false);
    if (history) {
        message += history + "\n\n";
    }

    if (translationText) {
        message += `<SOURCE_TEXT>${sourceText}</SOURCE_TEXT>\n`;
        if (intentText) {
            message += `<INTENT>${intentText}</INTENT>\n`;
        }
        message += `<TRANSLATION>${translationText}</TRANSLATION>\n`;
    } else if (messageText) {
        message += `<CURRENT_MESSAGE>${messageText}</CURRENT_MESSAGE>\n`;
    } else {
        message += `<DRAFT_TEXT>${sourceText}</DRAFT_TEXT>\n`;
        if (intentText) {
            message += `<INTENT>${intentText}</INTENT>\n`;
        }
    }

    if (translationInstructions) {
        message += `<REFERENCE_TRANSLATION_INSTRUCTIONS>${translationInstructions}</REFERENCE_TRANSLATION_INSTRUCTIONS>\n\n`;
    }

    if (previousQA.length > 0) {
        message += "<PREVIOUS_QA>\n";
        for (const qa of previousQA) {
            message += `Q: ${qa.question}\nA: ${qa.answer}\n\n`;
        }
        message += "</PREVIOUS_QA>\n\n";
    }

    message += `<CURRENT_QUESTION>${questionText}</CURRENT_QUESTION>\n\n`;
    message += `<INSTRUCTIONS>Answer in ${myLanguage}.</INSTRUCTIONS>`;

    return message;
}

/**
 * Appends a synced translation to the current session's UI by timestamp.
 * Loads the translation from OPFS, validates it's not already present,
 * and renders it into the translations container via the standard template flow.
 * Does nothing if the translation is already displayed or fails to load.
 * @param {number} timestamp - Translation timestamp (milliseconds)
 * @returns {Promise<void>}
 */
export async function appendTranslationFromSync(timestamp: number): Promise<void> {
    const translation = await loadSessionTranslation(currentSessionId, timestamp);
    if (!translation) return;

    if (allTranslations.some(function(t) { return t.id === translation.id; })) return;

    ensureEntries(translation);
    allTranslations.push(translation);

    const container = document.getElementById('translations-container');
    if (container) {
        renderTranslationItem(container, translation);
    }
}

/**
 * Opens the quick question modal, wires up the streaming logic, and manages
 * the ephemeral Q&A lifecycle. Supports follow-up questions within the same
 * dialog session. Nothing is persisted when the modal is closed.
 * Accepts optional options for context (sourceText, intentText) and a
 * systemPrompt override (for input message quick questions).
 * @param {{ sourceText?: string; intentText?: string; systemPrompt?: string; defaultQuestion?: string; translationText?: string }} [options] - Context and prompt overrides
 * @returns {void}
 */
function showQuickQuestionModal(options?: {
    sourceText?: string;
    intentText?: string;
    systemPrompt?: string;
    defaultQuestion?: string;
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
    const historyItemTemplate = document.getElementById('quick-question-history-item-template') as HTMLTemplateElement | null;

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
        if (!historyItemTemplate || !historyEl) return null;
        const itemClone = historyItemTemplate.content.cloneNode(true) as DocumentFragment;
        const item = itemClone.firstElementChild as HTMLElement;
        const qEl = item.querySelector('.quick-question-q') as HTMLElement | null;
        const aEl = item.querySelector('.quick-question-a') as HTMLElement | null;
        if (qEl) qEl.textContent = question;
        if (aEl) {
            if (isStreaming) {
                aEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span class="ms-2">Thinking...</span>';
            } else {
                aEl.innerHTML = '';
            }
        }
        historyEl.appendChild(itemClone);
        return aEl;
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
            const defaultQuestion = options?.defaultQuestion ?? "How's this?";
            const question = questionInput?.value.trim() || defaultQuestion;
            if (submitBtn) submitBtn.disabled = true;
            if (questionInput) questionInput.disabled = true;
            if (thinkingEl) thinkingEl.style.display = 'none';

            currentAnswerEl = addHistoryItem(question, true);

            // When options.sourceText is provided, use it directly as the source
            // (for input message quick questions). When options.translationText is provided,
            // both source and translation are used (for output message quick questions).
            // Otherwise read from the global textareas (for draft quick questions).
            const isTranslationQuestion = options?.translationText !== undefined;
            const isMessageQuestion = !isTranslationQuestion && options?.sourceText !== undefined;
            const sourceText = (isMessageQuestion || isTranslationQuestion) ? (options!.sourceText ?? '') : (document.getElementById('source-textarea') as HTMLTextAreaElement | null)?.value ?? '';
            let intentText: string;
            if (isMessageQuestion) {
                intentText = '';
            } else if (isTranslationQuestion) {
                intentText = options!.intentText ?? '';
            } else {
                intentText = (document.getElementById('intent-textarea') as HTMLTextAreaElement | null)?.value ?? '';
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
            const effectivePrompt = options?.systemPrompt ?? QUICK_QUESTION_DRAFT_PROMPT;
            const systemPrompt = effectivePrompt
                .replace(/\[LANGUAGE\]/g, myLangName)
                .replace(/\[TARGET_LANGUAGE\]/g, theirLangName);
            const userMessage = await buildQuickQuestionMessage(
                question, sourceText, intentText, myLangName, dialogHistory,
                isMessageQuestion ? sourceText : undefined,
                options?.translationText,
                translationInstructions
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
                            if (currentAnswerEl) {
                                currentAnswerEl.innerHTML = renderMarkdown(text);
                            }
                        }
                    },
                    onDone: function(fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage): void {
                        abortQuickQuestion = null;
                        if (thinkingEl) thinkingEl.style.display = 'none';
                        if (currentAnswerEl) {
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