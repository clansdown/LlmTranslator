/**
 * Translation Module
 * Handles translation functionality for input and output panes
 */

import { translateStructured, translateRaw } from './openrouter';
import { getPreference, savePreference, listSessions, saveSession, loadSession, deleteSession as storageDeleteSession, getOrCreateDefaultSession, saveSessionTranslation, listSessionTranslations, deleteSessionTranslation } from './storage';
import { DEBUG_TRANSLATIONS, DEBUG_SESSIONS } from './debug';
import * as ui from './ui';
import { LANGUAGES } from './languages';
import { INPUT_SYSTEM_PROMPT, OUTPUT_SYSTEM_PROMPT, INPUT_INSTRUCTIONS, OUTPUT_INSTRUCTIONS, LITERAL_RETRANSLATION_PROMPT, OUTPUT_LITERAL_RETRANSLATION_PROMPT, QUESTION_SYSTEM_PROMPT, WORD_DEFINITIONS_PROMPT, INTERPRETATION_PROMPT } from './prompts';
import { renderMarkdown, normalizeForMarkdown } from './markdown';
import type { Translation, TranslationEntry, TranslationWordItem, WordItem, PunctItem, NewlineItem } from './types/translation';
import type { Config } from './types/config';
import type { TranslationSession, ReasoningLevel } from './types/session';

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
function getModelName(modelId: string): string {
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
    currentLiteralModel = session.literalModel ?? null;
    currentInterpretationModel = session.interpretationModel ?? null;
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

    renderAllTranslations();

    if (config) {
        if (session.model) {
            config.selectedModel = session.model;
        }
    }

    updateSessionSelector(sessionId);

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

    const [defaultModelPref, defaultReasoningPref, defaultLiteralModelPref, defaultInterpretationModelPref, defaultInterpretationReasoningPref] = await Promise.all([
        getPreference("defaultModel"),
        getPreference("defaultReasoning"),
        getPreference("defaultLiteralModel"),
        getPreference("defaultInterpretationModel"),
        getPreference("defaultInterpretationReasoning")
    ]);

    const newSession: TranslationSession = {
        id: generateUuid(),
        name: name ?? "New Conversation",
        model: defaultModelPref ?? config?.selectedModel ?? null,
        theirLanguage: 'english',
        myLanguage: config?.defaultMyLanguage ?? 'english',
        background: "",
        reasoning: (defaultReasoningPref as ReasoningLevel) ?? 'none',
        literalModel: defaultLiteralModelPref ?? null,
        interpretationModel: defaultInterpretationModelPref ?? null,
        interpretationReasoning: (defaultInterpretationReasoningPref as ReasoningLevel | null) ?? undefined,
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
 * Saves the current session state (model)
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

    if (config) {
        session.model = config.selectedModel;
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
 * Loads translation history for the current session from OPFS into memory
 * @returns {Promise<void>}
 */
export async function loadTranslationHistory(): Promise<void> {
    if (DEBUG_TRANSLATIONS) {
        console.log('[loadTranslationHistory] Loading translation history...');
    }
    const MAX_HISTORY = 1000;

    const inputItems = await listSessionTranslations(currentSessionId, 'input', MAX_HISTORY);
    const outputItems = await listSessionTranslations(currentSessionId, 'output', MAX_HISTORY);
    const questionItems = await listSessionTranslations(currentSessionId, 'question', MAX_HISTORY);
    allTranslations = [...inputItems, ...outputItems, ...questionItems]
        .sort(function(a, b) { return b.timestamp - a.timestamp; });

    for (const t of allTranslations) {
        ensureEntries(t);
    }

    if (DEBUG_TRANSLATIONS) {
        console.log(`[loadTranslationHistory] Loaded ${allTranslations.length} total translations`);
    }
    renderAllTranslations();

    if (DEBUG_TRANSLATIONS) {
        console.log('[loadTranslationHistory] Translation history loaded');
    }
}

/**
 * Builds the history section for the user message
 * Returns history from the last 7 days with activity
 * @param {boolean} includeQuestions - Whether to include question/answer pairs in history
 * @returns {string} History section or empty string
 */
function buildHistorySection(includeQuestions: boolean = true): string {
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
            history += `<THEM>${entry.translation}</THEM>\n`;
        } else if (t.pill === 'output') {
            history += `<ME>${entry.source}</ME>\n`;
            history += `<ME>${entry.translation}</ME>\n`;
        } else if (t.pill === 'question' && includeQuestions && t.includeInContext !== false) {
            history += `<USERQUESTION>${entry.source}</USERQUESTION>\n`;
            history += `<AGENTANSWER>${entry.translation}</AGENTANSWER>\n`;
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
    translation.includeInContext = (translation as any).includeInContext;
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
    updateTranslationItem(translation);
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

    const overrideSelect = document.getElementById('model-override') as HTMLSelectElement | null;

    if (overrideSelect) {
        overrideSelect.addEventListener('change', function() {
            modelOverride = overrideSelect.value || null;
        });
    }

    updateButtonStates();
}

/**
 * Sets up keyboard handlers for textareas to trigger translation on Shift+Enter or Ctrl+Enter
 * @returns {void}
 */
export function setupTextareaKeyHandlers(): void {
    const sourceTextarea = document.getElementById('source-textarea') as HTMLTextAreaElement | null;

    if (sourceTextarea) {
        sourceTextarea.addEventListener('keydown', function(event: KeyboardEvent): void {
            if (event.key === 'Enter' && event.ctrlKey && event.shiftKey) {
                event.preventDefault();
                askQuestion();
            } else if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey)) {
                event.preventDefault();
                translate('output');
            }
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

    const history = buildHistorySection(pill !== 'input');
    if (history) {
        message += history + "\n\n";
    }

    message += `<TRANSLATE>${sourceText}</TRANSLATE>\n\n`;
    message += `<INSTRUCTIONS>${instructions}</INSTRUCTIONS>`;

    return message;
}

/**
 * Performs translation for the specified mode
 * @param {'input' | 'output'} mode - Which mode to translate
 * @returns {Promise<void>}
 */
export async function translate(mode: 'input' | 'output'): Promise<void> {
    if (!config) {
        ui.displayError("Please select a model first");
        return;
    }

    if (!config!.openRouterApiKey!) {
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

    textarea.value = '';

    const session = await loadSession(currentSessionId);
    const effectiveModel = getTranslationModelToUse(session);
    if (!effectiveModel) {
        ui.displayError("Please select a model first");
        return;
    }
    const reasoningLevel = session?.reasoning ?? 'none';
    currentLiteralModel = session?.literalModel ?? null;
    const theirLang = LANGUAGES.find(function(l) { return l.id === session?.theirLanguage; });
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';
    const theirLangName = theirLang?.name ?? session?.theirLanguage ?? 'Foreign';

    let promptName: string;
    let instructions: string;

    if (mode === 'input') {
        promptName = session?.interlocutorName ?? theirLang?.name ?? 'Foreign';
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', myLangName);
    } else {
        const intentTextarea = document.getElementById('intent-textarea') as HTMLTextAreaElement | null;
        const intent = intentTextarea?.value.trim() ?? '';
        const translationInstructions = session?.translationInstructions ?? '';
        const translationInstructionsBlock = translationInstructions
            ? `The following are instructions on how the translation should be styled and presented:\n<TRANSLATIONINSTRUCTIONS>${translationInstructions}</TRANSLATIONINSTRUCTIONS>`
            : '';
        const intentBlock = intent
            ? `The following is guidance on the intent of the text to be translated:\n<INTENT>${intent}</INTENT>`
            : '';
        instructions = OUTPUT_INSTRUCTIONS.replace('[TRANSLATION_INSTRUCTIONS_BLOCK]', translationInstructionsBlock);
        instructions = instructions.replace('[INTENT_BLOCK]', intentBlock);
        instructions = instructions.replace('[LANGUAGE]', myLangName);
        instructions = instructions.replace('[TARGET_LANGUAGE]', theirLangName);
        promptName = 'Me';
        if (intentTextarea) {
            intentTextarea.value = '';
        }
    }

    const userMessage = await buildUserMessage(mode, sourceText, instructions);

    const translation: Translation = {
        id: generateUuid(),
        pill: mode,
        entries: [{
            source: sourceText,
            intent: '',
            model: effectiveModel ?? '',
            modelName: getModelName(effectiveModel ?? ''),
            prompt: promptName,
            promptContent: instructions,
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
        status: 'pending',
        error: null
    };

    allTranslations.push(translation);
    const container = document.getElementById('translations-container');
    if (container) {
        renderTranslationItem(container, translation);
    }

    const systemPrompt = mode === 'input' ? INPUT_SYSTEM_PROMPT : OUTPUT_SYSTEM_PROMPT;
    console.log(`[translate] Starting translation with model: ${effectiveModel}, mode: ${mode}`);

    try {
        const result = await translateStructured(
            config!.openRouterApiKey!,
            userMessage,
            systemPrompt,
            effectiveModel!,
            reasoningLevel,
            config!.temperature
        );

        translation.entries[0].translation = result.translation;
        translation.entries[0].explanation = result.explanation;
        translation.entries[0].nuances = result.nuances;
        translation.entries[0].reasoning = result.reasoning;
        translation.entries[0].reasoningDetails = result.reasoningDetails;
        translation.entries[0].model = effectiveModel ?? '';
        translation.entries[0].modelName = getModelName(effectiveModel ?? '');
        translation.status = 'complete';
        syncTopLevelFromActive(translation);
        saveSessionTranslation(currentSessionId, translation);

        currentLiteralModel = session?.literalModel ?? null;
        /** @type {Promise<void>[]} */
        const tasks: Promise<void>[] = [];

        if (session?.literalModel) {
            translation.entries[0].literalPending = true;
            tasks.push((async () => {
                try {
                    const literalPrompt = mode === 'input'
                        ? LITERAL_RETRANSLATION_PROMPT
                        : OUTPUT_LITERAL_RETRANSLATION_PROMPT;
                    const literalSystemPrompt = literalPrompt.replace(/\[LANGUAGE\]/g, myLangName);
                    const literalUserMessage = mode === 'input'
                        ? sourceText
                        : result.translation;
                    console.log('[translateLiteral] Starting literal retranslation with model:', session.literalModel);
                    const literalResult = await translateRaw(
                        config!.openRouterApiKey!,
                        literalUserMessage,
                        literalSystemPrompt,
                        session.literalModel!,
                        'none',
                        config!.temperature
                    );
                    translation.entries[0].literalRetranslation = literalResult;
                    translation.entries[0].literalPending = false;
                    syncTopLevelFromActive(translation);
                    saveSessionTranslation(currentSessionId, translation);
                    updateTranslationItem(translation);
                } catch (literalError) {
                    console.error('[translateLiteral] Literal retranslation failed:', literalError);
                    translation.entries[0].literalPending = false;
                    updateTranslationItem(translation);
                }
            })());
        }

        const wordDefModel = session?.literalModel ?? effectiveModel;
        if (wordDefModel) {
            const wordText = mode === 'input'
                ? sourceText
                : result.translation;
            if (wordText) {
                translation.entries[0].wordPending = true;
                tasks.push((async () => {
                    try {
                        console.log('[wordDefinitions] Starting word definitions with model:', wordDefModel);
                        const wordXml = await fetchWordDefinitions(wordDefModel, wordText, myLangName);
                        translation.entries[0].wordDefinitions = wordXml;
                        translation.entries[0].wordData = parseWordDefinitions(wordXml);
                        console.log('[wordDefinitions] Parsed', translation.entries[0].wordData.length, 'word items');
                        translation.entries[0].wordPending = false;
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
                        translation.entries[0].wordPending = false;
                        updateTranslationItem(translation);
                    }
                })());
            }
        }

        if (mode === 'output' && session?.interpretationModel) {
            translation.entries[0].interpretationPending = true;
            tasks.push((async () => {
                try {
                    const message = await buildInterpretationMessage(translation);
                    console.log('[interpretation] Starting interpretation with model:', session.interpretationModel);
                    const interpretationResult = await translateRaw(
                        config!.openRouterApiKey!,
                        message,
                        INTERPRETATION_PROMPT,
                        session.interpretationModel!,
                        session?.interpretationReasoning ?? 'none',
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
        updateTranslationItem(translation);
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
        updateTranslationItem(translation);
    }

    await refreshBalance();
}

/**
 * Builds the user message for question answering
 * @param {string} questionText - The user's question
 * @returns {Promise<string>} Complete user message
 */
async function buildQuestionMessage(questionText: string): Promise<string> {
    const background = await getBackground();

    let message = "";

    if (background.trim()) {
        message += `<BACKGROUND>${background}</BACKGROUND>\n\n`;
    }

    const history = buildHistorySection();
    if (history) {
        message += history + "\n\n";
    }

    message += `<QUESTION>${questionText}</QUESTION>\n\n`;
    message += `<INSTRUCTIONS>Answer the user's question clearly and helpfully.</INSTRUCTIONS>`;

    return message;
}

/**
 * Answers a question about the conversation
 * @returns {Promise<void>}
 */
export async function askQuestion(): Promise<void> {
    if (!config) {
        ui.displayError("Please select a model first");
        return;
    }

    if (!config!.openRouterApiKey!) {
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

    const userMessage = await buildQuestionMessage(questionText);

    const session = await loadSession(currentSessionId);
    const effectiveModel = getTranslationModelToUse(session);
    if (!effectiveModel) {
        ui.displayError("Please select a model first");
        return;
    }

    const translation: Translation = {
        id: generateUuid(),
        pill: 'question',
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
        status: 'pending',
        error: null
    };

    allTranslations.push(translation);
    renderAllTranslations();

    try {
        const result = await translateRaw(
            config!.openRouterApiKey!,
            userMessage,
            QUESTION_SYSTEM_PROMPT,
            effectiveModel!,
            session?.reasoning ?? 'none',
            config.questionTemperature
        );
        translation.entries[0].translation = result;
        translation.status = 'complete';
        syncTopLevelFromActive(translation);
        saveSessionTranslation(currentSessionId, translation);
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Failed to get answer";
    }

    renderAllTranslations();
    await refreshBalance();
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
 * Sets up toggle visibility for explanation/nuances sections
 * @param {HTMLElement} element - The translation item element
 * @param {Translation} translation - The translation object
 * @returns {void}
 */
function setupToggleHandler(element: HTMLElement, translation: Translation): void {
    const toggleSectionsBtn = element.querySelector('.toggle-sections-btn') as HTMLButtonElement | null;
    const sectionsArea = element.querySelector('.translation-sections-area') as HTMLElement | null;
    if (toggleSectionsBtn && sectionsArea) {
            toggleSectionsBtn.addEventListener('click', function() {
                const isCollapsed = sectionsArea.classList.contains('translation-sections-collapsed');
                if (isCollapsed) {
                    sectionsArea.classList.remove('translation-sections-collapsed');
                    toggleSectionsBtn.textContent = '▼';
                    translation.sectionsCollapsed = false;
                } else {
                    sectionsArea.classList.add('translation-sections-collapsed');
                    toggleSectionsBtn.textContent = '▶';
                    translation.sectionsCollapsed = true;
                }
            saveSessionTranslation(currentSessionId, translation);
        });
    }

    const toggleAnswerBtn = element.querySelector('.toggle-answer-btn') as HTMLButtonElement | null;
    const answerEl = element.querySelector('.translation-target') as HTMLElement | null;
    if (toggleAnswerBtn && answerEl) {
        toggleAnswerBtn.addEventListener('click', function() {
            const isCollapsed = answerEl.classList.contains('answer-collapsed');
            if (isCollapsed) {
                answerEl.classList.remove('answer-collapsed');
                toggleAnswerBtn.textContent = '▲';
                translation.answerCollapsed = false;
            } else {
                answerEl.classList.add('answer-collapsed');
                toggleAnswerBtn.textContent = '▼';
                translation.answerCollapsed = true;
            }
            saveSessionTranslation(currentSessionId, translation);
        });
    }
}

/**
 * Renders a single translation item, creating or updating DOM element
 * @param {HTMLElement} container - Container element
 * @param {Translation} translation - Translation object
 * @returns {void}
 */
function renderTranslationItem(container: HTMLElement, translation: Translation): void {
    const elementId = 'translation-' + translation.id;
    let element = document.getElementById(elementId);

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
        if (literalPane) {
            literalPane.id = 'literal-pane-' + translation.id;
        }
        if (explanationPane) {
            explanationPane.id = 'explanation-pane-' + translation.id;
        }
        if (nuancesPane) {
            nuancesPane.id = 'nuances-pane-' + translation.id;
        }
        if (wordsPane) {
            wordsPane.id = 'words-pane-' + translation.id;
        }
        if (interpretationPane) {
            interpretationPane.id = 'interpretation-pane-' + translation.id;
        }
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

        const retryBtn = element.querySelector('.retry-btn');
        if (retryBtn) {
            const translationId = translation.id;
            retryBtn.addEventListener('click', function() {
                retryTranslation(translationId);
            });
        }

        const deleteBtn = element.querySelector('.delete-translation-btn') as HTMLButtonElement | null;
        if (deleteBtn) {
            const translationId = translation.id;
            deleteBtn.addEventListener('click', function() {
                deleteTranslation(translationId);
            });
        }

        const copySourceBtn = element.querySelector('.copy-source-btn') as HTMLButtonElement | null;
        const copyTargetBtn = element.querySelector('.copy-target-btn') as HTMLButtonElement | null;

        if (copySourceBtn) {
            const translationId = translation.id;
            copySourceBtn.addEventListener('click', function() {
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const src = t.entries?.[t.activeEntryIndex ?? 0]?.source ?? (t as any).source ?? '';
                navigator.clipboard.writeText(src).catch(function() {
                    console.log('Failed to copy source text');
                });
            });
        }

        if (copyTargetBtn) {
            const translationId = translation.id;
            copyTargetBtn.addEventListener('click', function() {
                const t = allTranslations.find(function(x) { return x.id === translationId; });
                if (!t) return;
                ensureEntries(t);
                const txt = t.entries?.[t.activeEntryIndex ?? 0]?.translation ?? (t as any).translation ?? '';
                navigator.clipboard.writeText(txt).catch(function() {
                    console.log('Failed to copy translation text');
                });
            });
        }

        const editSource = element.querySelector('.translation-edit-source') as HTMLTextAreaElement | null;
        const editIntent = element.querySelector('.translation-edit-intent') as HTMLTextAreaElement | null;
        const retranslateBtn = element.querySelector('.retranslate-btn') as HTMLButtonElement | null;

        if (retranslateBtn) {
            retranslateBtn.addEventListener('click', function() {
                const newSource = editSource?.value.trim() ?? '';
                if (!newSource) {
                    ui.displayError("Source text cannot be empty");
                    return;
                }
                const newIntent = editIntent?.value.trim() ?? '';
                retranslateFromEdit(translation.id, newSource, newIntent);
            });
        }

        const editToggleBtn = element.querySelector('.edit-toggle-btn') as HTMLButtonElement | null;
        const editArea = element.querySelector('.translation-edit-area') as HTMLElement | null;

        if (editToggleBtn && editArea) {
            editToggleBtn.addEventListener('click', function() {
                ensureEntries(translation);
                const activeEntry = translation.entries[translation.activeEntryIndex ?? 0];
                if (editSource) editSource.value = activeEntry?.source ?? (translation as any).source ?? '';
                if (editIntent) editIntent.value = activeEntry?.intent ?? (translation as any).intent ?? '';
                if (editArea.style.display === 'none') {
                    editArea.style.display = 'block';
                } else {
                    editArea.style.display = 'none';
                }
            });
        }

        const regenerateTranslationBtn = element.querySelector('.regenerate-translation-btn') as HTMLButtonElement | null;
        if (regenerateTranslationBtn) {
            const translationId = translation.id;
            regenerateTranslationBtn.addEventListener('click', function() {
                regenerateTranslationById(translationId);
            });
        }

        const regenerateLiteralBtn = element.querySelector('.regenerate-literal-btn') as HTMLButtonElement | null;
        if (regenerateLiteralBtn) {
            const translationId = translation.id;
            regenerateLiteralBtn.addEventListener('click', function() {
                regenerateIndependentSections(translationId);
            });
        }

        const regenerateInterpretationBtn = element.querySelector('.regenerate-interpretation-btn') as HTMLButtonElement | null;
        if (regenerateInterpretationBtn) {
            const translationId = translation.id;
            regenerateInterpretationBtn.addEventListener('click', function() {
                regenerateInterpretation(translationId);
            });
        }

        setupToggleHandler(element, translation);

        if (translation.pill === 'question') {
            const ctxToggle = element.querySelector('.include-in-context-toggle') as HTMLInputElement | null;
            if (ctxToggle) {
                ctxToggle.checked = translation.includeInContext !== false;
                ctxToggle.addEventListener('change', function() {
                    translation.includeInContext = ctxToggle.checked;
                    saveSessionTranslation(currentSessionId, translation);
                });
            }
        }

        const retranslationTabs = element.querySelector('.retranslation-tabs') as HTMLElement | null;
        if (retranslationTabs) {
            retranslationTabs.style.display = 'none';
        }

        container.insertBefore(element, container.firstChild);
    }

    if (element && !element.dataset.wordsHandler) {
        const wordsTab = element.querySelector('#words-tab-' + translation.id) as HTMLElement | null;
        const wordsContentEl = element.querySelector('.translation-words') as HTMLElement | null;
        if (wordsTab && wordsContentEl) {
            wordsTab.addEventListener('click', function() {
                ensureEntries(translation);
                console.log('[WordsTab] Clicked, wordData:', translation.entries?.[translation.activeEntryIndex ?? 0]?.wordData?.length, 'wordPending:', translation.entries?.[translation.activeEntryIndex ?? 0]?.wordPending);
                renderWordContent(wordsContentEl, translation);
            });
            element.dataset.wordsHandler = 'true';
        }
    }

    updateTranslationItem(translation);
}

/**
 * Updates an existing translation item's dynamic fields in the DOM
 * Does NOT create elements - use renderTranslationItem for that
 * @param {Translation} translation - Translation object with updated data
 * @returns {void}
 */
function updateTranslationItem(translation: Translation): void {
    const element = document.getElementById('translation-' + translation.id);
    if (!element) return;

    element.dataset.pill = translation.pill;

    ensureEntries(translation);
    const entry = translation.entries[translation.activeEntryIndex ?? 0];

    const sourceEl = element.querySelector('.translation-source') as HTMLElement | null;
    const targetEl = element.querySelector('.translation-target') as HTMLElement | null;
    const literalEl = element.querySelector('.translation-literal') as HTMLElement | null;
    const explanationEl = element.querySelector('.translation-explanation') as HTMLElement | null;
    const nuancesEl = element.querySelector('.translation-nuances') as HTMLElement | null;
    const spinnerEl = element.querySelector('.translation-spinner') as HTMLElement | null;
    const errorEl = element.querySelector('.translation-error') as HTMLElement | null;
    const promptEl = element.querySelector('.translation-prompt') as HTMLElement | null;
    const modelNameEl = element.querySelector('.translation-model-name') as HTMLElement | null;
    const charCountEl = element.querySelector('.translation-char-count') as HTMLElement | null;
    const regenerateLiteralBtn = element.querySelector('.regenerate-literal-btn') as HTMLButtonElement | null;
    const regenerateInterpretationBtn = element.querySelector('.regenerate-interpretation-btn') as HTMLButtonElement | null;
    const sectionsArea = element.querySelector('.translation-sections-area') as HTMLElement | null;
    const toggleSectionsBtn = element.querySelector('.toggle-sections-btn') as HTMLButtonElement | null;
    const interpretationEl = element.querySelector('.translation-interpretation') as HTMLElement | null;
    const wordsPane = element.querySelector('#words-pane-' + translation.id) as HTMLElement | null;
    const wordsContent = element.querySelector('.translation-words') as HTMLElement | null;
    const retranslationTabsEl = element.querySelector('.retranslation-tabs') as HTMLElement | null;

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
    const entryIntent = entry?.intent ?? (translation as any).intent ?? '';

    if (sourceEl) {
        sourceEl.innerHTML = renderMarkdown(normalizeForMarkdown(entrySource));
    }
    if (promptEl) {
        promptEl.textContent = entryPrompt;
    }
    if (modelNameEl) {
        modelNameEl.textContent = entryModelName;
    }

    if (retranslationTabsEl) {
        retranslationTabsEl.innerHTML = '';
        if (translation.entries.length <= 1) {
            retranslationTabsEl.style.display = 'none';
        } else {
            retranslationTabsEl.style.display = '';
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
            retranslationTabsEl.appendChild(ul);
        }
    }

    if (translation.status === 'pending') {
        if (spinnerEl) spinnerEl.style.display = 'block';
        if (errorEl) errorEl.style.display = 'none';
        if (targetEl) targetEl.innerHTML = '';
        if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
        if (charCountEl) {
            charCountEl.textContent = `(${entrySource.length}/—)`;
        }
    } else if (translation.status === 'error') {
        if (spinnerEl) spinnerEl.style.display = 'none';
        if (targetEl) targetEl.innerHTML = '';
        if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
        if (charCountEl) {
            charCountEl.textContent = `(${entrySource.length}/—)`;
        }
        if (errorEl) {
            errorEl.style.display = 'block';
            const errorMsg = errorEl.querySelector('.error-message') as HTMLElement | null;
            if (errorMsg) {
                errorMsg.textContent = translation.error ?? "Translation failed";
            }
        }
    } else {
        if (spinnerEl) spinnerEl.style.display = 'none';
        if (errorEl) errorEl.style.display = 'none';
        if (targetEl) {
            if (translation.pill === 'question') {
                targetEl.innerHTML = renderMarkdown(entryTranslation);
                const toggleAnswerBtn = element.querySelector('.toggle-answer-btn') as HTMLButtonElement | null;
                if (translation.answerCollapsed) {
                    targetEl.classList.add('answer-collapsed');
                    if (toggleAnswerBtn) toggleAnswerBtn.textContent = '▲';
                } else {
                    targetEl.classList.remove('answer-collapsed');
                    if (toggleAnswerBtn) toggleAnswerBtn.textContent = '▼';
                }
            } else {
                targetEl.innerHTML = renderMarkdown(normalizeForMarkdown(entryTranslation));
            }
        }
        if (charCountEl) {
            charCountEl.textContent = `(${entrySource.length}/${entryTranslation.length})`;
        }

        if (literalEl) {
            if (entryLiteralPending) {
                literalEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Retranslating...</span>';
                if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
            } else if (entryLiteralRetranslation) {
                literalEl.innerHTML = renderMarkdown(entryLiteralRetranslation);
                if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
            } else {
                literalEl.innerHTML = '';
                if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
            }
        }
        if (explanationEl) {
            explanationEl.innerHTML = entryExplanation ? renderMarkdown(entryExplanation) : '';
        }
        if (nuancesEl) {
            nuancesEl.innerHTML = entryNuances ? renderMarkdown(entryNuances) : '';
        }

        if (interpretationEl) {
            if (entryInterpretationPending) {
                interpretationEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Interpreting...</span>';
                if (regenerateInterpretationBtn) regenerateInterpretationBtn.style.display = 'none';
            } else if (entryInterpretation) {
                interpretationEl.innerHTML = renderMarkdown(entryInterpretation);
                if (regenerateInterpretationBtn) regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            } else {
                interpretationEl.innerHTML = '';
                if (regenerateInterpretationBtn) regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';
            }
        }

        if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
        if (regenerateInterpretationBtn) regenerateInterpretationBtn.style.display = currentInterpretationModel ? 'inline-block' : 'none';

        if (sectionsArea && toggleSectionsBtn) {
            if (translation.sectionsCollapsed) {
                sectionsArea.classList.add('translation-sections-collapsed');
                toggleSectionsBtn.textContent = '▶';
            } else {
                sectionsArea.classList.remove('translation-sections-collapsed');
                toggleSectionsBtn.textContent = '▼';
            }
        }
    }

    if (wordsPane && wordsContent && wordsPane.classList.contains('active')) {
        wordsContent.innerHTML = '';
        renderWordContent(wordsContent, translation);
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

    ensureEntries(translation);
    const activeIdx = translation.activeEntryIndex ?? 0;
    const entry = translation.entries[activeIdx];
    if (!entry) return;

    translation.status = 'pending';
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

    const reasoningLevel = session?.reasoning ?? 'none';

    if (translation.pill === 'question') {
        const userMessage = await buildQuestionMessage(entry.source);
        try {
            const result = await translateRaw(
                config!.openRouterApiKey!,
                userMessage,
                QUESTION_SYSTEM_PROMPT,
                effectiveModel!,
                reasoningLevel,
                config.questionTemperature
            );
            translation.entries[activeIdx].translation = result;
            translation.status = 'complete';
            syncTopLevelFromActive(translation);
            saveSessionTranslation(currentSessionId, translation);
        } catch (error) {
            translation.status = 'error';
            translation.error = error instanceof Error ? error.message : "Failed to get answer";
        }
        renderAllTranslations();
        await refreshBalance();
        return;
    }

    let instructions: string;
    const theirLang = LANGUAGES.find(function(l) { return l.id === session?.theirLanguage; });
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    if (translation.pill === 'input') {
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', myLang?.name ?? session?.myLanguage ?? 'English');
    } else {
        const translationInstructions = session?.translationInstructions ?? '';
        const translationInstructionsBlock = translationInstructions
            ? `The following are instructions on how the translation should be styled and presented:\n<TRANSLATIONINSTRUCTIONS>${translationInstructions}</TRANSLATIONINSTRUCTIONS>`
            : '';
        const intentBlock = entry.intent
            ? `The following is guidance on the intent of the text to be translated:\n<INTENT>${entry.intent}</INTENT>`
            : '';
        instructions = OUTPUT_INSTRUCTIONS.replace('[TRANSLATION_INSTRUCTIONS_BLOCK]', translationInstructionsBlock);
        instructions = instructions.replace('[INTENT_BLOCK]', intentBlock);
        instructions = instructions.replace('[LANGUAGE]', myLang?.name ?? session?.myLanguage ?? 'English');
        instructions = instructions.replace('[TARGET_LANGUAGE]', theirLang?.name ?? session?.theirLanguage ?? 'Foreign');
    }

    const userMessage = await buildUserMessage(translation.pill, entry.source, instructions);

    const systemPrompt = translation.pill === 'input' ? INPUT_SYSTEM_PROMPT : OUTPUT_SYSTEM_PROMPT;

    try {
        const result = await translateStructured(
            config!.openRouterApiKey!,
            userMessage,
            systemPrompt,
            effectiveModel!,
            reasoningLevel,
            config!.temperature
        );

        translation.entries[activeIdx].translation = result.translation;
        translation.entries[activeIdx].explanation = result.explanation;
        translation.entries[activeIdx].nuances = result.nuances;
        translation.entries[activeIdx].reasoning = result.reasoning;
        translation.entries[activeIdx].reasoningDetails = result.reasoningDetails;
        translation.entries[activeIdx].model = effectiveModel;
        translation.entries[activeIdx].modelName = getModelName(effectiveModel);
        translation.status = 'complete';
        syncTopLevelFromActive(translation);
        const oldTimestamp = translation.timestamp;
        translation.timestamp = Date.now();
        await saveSessionTranslation(currentSessionId, translation);
        await deleteSessionTranslation(currentSessionId, oldTimestamp);
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
    }

    updateTranslationItem(translation);
    await refreshBalance();
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

    ensureEntries(translation);
    const activeIdx = translation.activeEntryIndex ?? 0;
    const currentEntry = translation.entries[activeIdx];
    if (!currentEntry) return;

    translation.status = 'pending';
    translation.error = null;
    updateTranslationItem(translation);

    const session = await loadSession(currentSessionId);
    const effectiveModel = getTranslationModelToUse(session);
    const reasoningLevel = session?.reasoning ?? 'none';
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', myLang?.name ?? session?.myLanguage ?? 'English');
    const userMessage = await buildUserMessage('input', currentEntry.source, instructions);
    const systemPrompt = translation.pill === 'input' ? INPUT_SYSTEM_PROMPT : OUTPUT_SYSTEM_PROMPT;
    try {
        const result = await translateStructured(
            config!.openRouterApiKey!,
            userMessage,
            systemPrompt,
            effectiveModel!,
            reasoningLevel,
            config!.temperature
        );

        /** @type {TranslationEntry} */
        const newEntry: TranslationEntry = {
            source: currentEntry.source,
            intent: currentEntry.intent,
            model: effectiveModel ?? '',
            modelName: getModelName(effectiveModel ?? ''),
            prompt: currentEntry.prompt,
            promptContent: currentEntry.promptContent,
            translation: result.translation,
            explanation: result.explanation,
            nuances: result.nuances,
            reasoning: result.reasoning,
            reasoningDetails: result.reasoningDetails,
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
        translation.status = 'complete';
        syncTopLevelFromActive(translation);
        const oldTimestamp = translation.timestamp;
        translation.timestamp = Date.now();
        await saveSessionTranslation(currentSessionId, translation);
        await deleteSessionTranslation(currentSessionId, oldTimestamp);
        updateTranslationItem(translation);
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
        updateTranslationItem(translation);
    }

    await refreshBalance();
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

    const session = await loadSession(currentSessionId);
    const effectiveModel = getTranslationModelToUse(session);
    if (!config || !effectiveModel || !config!.openRouterApiKey!) {
        ui.displayError("Cannot retranslate: no model selected or no API key");
        return;
    }

    const reasoningLevel = session?.reasoning ?? 'none';
    const myLang = LANGUAGES.find(function(l) { return l.id === session?.myLanguage; });
    const myLangName = myLang?.name ?? session?.myLanguage ?? 'English';
    const theirLang = LANGUAGES.find(function(l) { return l.id === session?.theirLanguage; });
    const promptName = translation.pill === 'input'
        ? session?.interlocutorName ?? theirLang?.name ?? 'Foreign'
        : 'Me';

    translation.status = 'pending';
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
    updateTranslationItem(translation);

    let instructions: string;
    if (translation.pill === 'input') {
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', myLangName);
    } else {
        const translationInstructions = session?.translationInstructions ?? '';
        const translationInstructionsBlock = translationInstructions
            ? `The following are instructions on how the translation should be styled and presented:\n<TRANSLATIONINSTRUCTIONS>${translationInstructions}</TRANSLATIONINSTRUCTIONS>`
            : '';
        const intentBlock = newIntent
            ? `The following is guidance on the intent of the text to be translated:\n<INTENT>${newIntent}</INTENT>`
            : '';
        instructions = OUTPUT_INSTRUCTIONS.replace('[TRANSLATION_INSTRUCTIONS_BLOCK]', translationInstructionsBlock);
        instructions = instructions.replace('[INTENT_BLOCK]', intentBlock);
        instructions = instructions.replace('[LANGUAGE]', myLangName);
        instructions = instructions.replace('[TARGET_LANGUAGE]', theirLang?.name ?? session?.theirLanguage ?? 'Foreign');
    }

    const userMessage = await buildUserMessage(translation.pill, newSource, instructions);

    const systemPrompt = translation.pill === 'input' ? INPUT_SYSTEM_PROMPT : OUTPUT_SYSTEM_PROMPT;
    console.log(`[translate] Starting translation with model: ${effectiveModel}, mode: ${translation.pill}`);

    try {
        const result = await translateStructured(
            config!.openRouterApiKey!,
            userMessage,
            systemPrompt,
            effectiveModel!,
            reasoningLevel,
            config!.temperature
        );

        translation.entries[0].translation = result.translation;
        translation.entries[0].explanation = result.explanation;
        translation.entries[0].nuances = result.nuances;
        translation.entries[0].reasoning = result.reasoning;
        translation.entries[0].reasoningDetails = result.reasoningDetails;
        translation.entries[0].model = effectiveModel ?? '';
        translation.entries[0].modelName = getModelName(effectiveModel ?? '');
        translation.status = 'complete';
        syncTopLevelFromActive(translation);
        const oldTimestamp = translation.timestamp;
        translation.timestamp = Date.now();
        await saveSessionTranslation(currentSessionId, translation);
        await deleteSessionTranslation(currentSessionId, oldTimestamp);

        currentLiteralModel = session?.literalModel ?? null;
        /** @type {Promise<void>[]} */
        const tasks: Promise<void>[] = [];

        if (session?.literalModel) {
            translation.entries[0].literalPending = true;
            tasks.push((async () => {
                try {
                    const literalPrompt = translation.pill === 'input'
                        ? LITERAL_RETRANSLATION_PROMPT
                        : OUTPUT_LITERAL_RETRANSLATION_PROMPT;
                    const literalSystemPrompt = literalPrompt.replace(/\[LANGUAGE\]/g, myLangName);
                    const literalUserMessage = result.translation;
                    const literalResult = await translateRaw(
                        config!.openRouterApiKey!,
                        literalUserMessage,
                        literalSystemPrompt,
                        session.literalModel!,
                        'none',
                        config!.temperature
                    );
                    translation.entries[0].literalRetranslation = literalResult;
                    translation.entries[0].literalPending = false;
                    syncTopLevelFromActive(translation);
                    saveSessionTranslation(currentSessionId, translation);
                } catch (literalError) {
                    console.error('[retranslateFromEdit] Literal retranslation failed:', literalError);
                    translation.entries[0].literalPending = false;
                }
            })());
        }

        const wordDefModel = session?.literalModel ?? effectiveModel;
        if (wordDefModel && result.translation) {
            translation.entries[0].wordPending = true;
            tasks.push((async () => {
                try {
                    console.log('[wordDefinitions] Starting word definitions with model:', wordDefModel);
                    const wordXml = await fetchWordDefinitions(wordDefModel, result.translation, myLangName);
                    translation.entries[0].wordDefinitions = wordXml;
                    translation.entries[0].wordData = parseWordDefinitions(wordXml);
                    console.log('[wordDefinitions] Parsed', translation.entries[0].wordData.length, 'word items');
                    translation.entries[0].wordPending = false;
                    syncTopLevelFromActive(translation);
                    saveSessionTranslation(currentSessionId, translation);
                } catch (wordDefError) {
                    console.error('[wordDefinitions] Failed:', wordDefError);
                    translation.entries[0].wordPending = false;
                }
            })());
        }

        if (session?.interpretationModel && result.translation) {
            translation.entries[0].interpretationPending = true;
            tasks.push((async () => {
                try {
                    const message = await buildInterpretationMessage(translation);
                    console.log('[interpretation] Starting interpretation with model:', session.interpretationModel);
                    const interpretationResult = await translateRaw(
                        config!.openRouterApiKey!,
                        message,
                        INTERPRETATION_PROMPT,
                        session.interpretationModel!,
                        session?.interpretationReasoning ?? 'none',
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
        updateTranslationItem(translation);
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
        updateTranslationItem(translation);
    }

    await refreshBalance();
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
    if (!session?.interpretationModel) {
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

    entry.interpretationPending = true;
    entry.interpretation = undefined;
    updateTranslationItem(translation);

    try {
        const message = await buildInterpretationMessage(translation);
        console.log('[regenerateInterpretation] Starting interpretation with model:', session.interpretationModel);
        const interpretationResult = await translateRaw(
            config!.openRouterApiKey!,
            message,
            INTERPRETATION_PROMPT,
            session.interpretationModel,
            session?.interpretationReasoning ?? 'none',
            config!.temperature
        );
        entry.interpretation = interpretationResult;
        entry.interpretationPending = false;
        syncTopLevelFromActive(translation);
        saveSessionTranslation(currentSessionId, translation);
        updateTranslationItem(translation);
    } catch (interpretationError) {
        console.error('[regenerateInterpretation] Failed:', interpretationError);
        entry.interpretationPending = false;
        updateTranslationItem(translation);
    }
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

    if (translation.status !== 'complete') {
        return;
    }

    const session = await loadSession(currentSessionId);
    if (!session?.literalModel) {
        console.error('[regenerateLiteral] No literal model configured');
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
    console.log('[regenerateLiteral] Starting literal retranslation with model:', session.literalModel);
    console.log('[regenerateLiteral] Input text (' + translation.pill + '):', literalUserMessage.substring(0, 200));

    entry.literalPending = true;
    entry.literalRetranslation = undefined;
    updateTranslationItem(translation);

    /** @type {Promise<void>[]} */
    const tasks: Promise<void>[] = [];

    if (session?.literalModel) {
        tasks.push((async () => {
            try {
                const literalResult = await translateRaw(
                    config!.openRouterApiKey!,
                    literalUserMessage,
                    literalSystemPrompt,
                    session.literalModel!,
                    'none',
                    config!.temperature
                );
                console.log('[regenerateLiteral] Literal result:', literalResult.substring(0, 200));
                entry.literalRetranslation = literalResult;
                entry.literalPending = false;
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
            } catch (literalError) {
                console.error('[regenerateLiteral] Literal retranslation failed:', literalError);
                entry.literalPending = false;
                updateTranslationItem(translation);
            }
        })());
    }

    const wordDefModel = session?.literalModel ?? effectiveModel;
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
                const wordXml = await fetchWordDefinitions(wordDefModel, wordText, myLangName);
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

    if (session?.interpretationModel && entry.translation) {
        entry.interpretationPending = true;
        entry.interpretation = undefined;
        tasks.push((async () => {
            try {
                const message = await buildInterpretationMessage(translation);
                console.log('[interpretation] Starting interpretation with model:', session.interpretationModel);
                const interpretationResult = await translateRaw(
                    config!.openRouterApiKey!,
                    message,
                    INTERPRETATION_PROMPT,
                    session.interpretationModel!,
                    session?.interpretationReasoning ?? 'none',
                    config!.temperature
                );
                entry.interpretation = interpretationResult;
                entry.interpretationPending = false;
                syncTopLevelFromActive(translation);
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
            } catch (interpretationError) {
                console.error('[interpretation] Failed:', interpretationError);
                entry.interpretationPending = false;
                updateTranslationItem(translation);
            }
        })());
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
 * @param {string} text - The translation text to analyze
 * @param {string} outputLanguage - Language name for definitions/explanations in the prompt
 * @returns {Promise<string>} Raw XML response
 * @throws {Error} If API request fails
 */
async function fetchWordDefinitions(model: string, text: string, outputLanguage: string): Promise<string> {
    const prompt = WORD_DEFINITIONS_PROMPT.replace('[TEXT]', text).replace('[LANGUAGE]', outputLanguage);
    console.log('[wordDefinitions] Sending API request, text length:', text.length);
    const result = await translateRaw(
        config!.openRouterApiKey!,
        prompt,
        'You are a linguistic analysis tool. Output only the requested XML structure with no additional text.',
        model,
        'none',
        config!.temperature
    );
    console.log('[wordDefinitions] API response length:', result.length, 'first 200 chars:', result.substring(0, 200));
    return result;
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