/**
 * Translation Module
 * Handles translation functionality for input and output panes
 */

import { translateStructured, translateRaw } from './openrouter';
import { getPreference, savePreference, listSessions, saveSession, loadSession, deleteSession as storageDeleteSession, getOrCreateDefaultSession, saveSessionTranslation, listSessionTranslations, deleteSessionTranslation } from './storage';
import { DEBUG_TRANSLATIONS, DEBUG_SESSIONS } from './debug';
import * as ui from './ui';
import { LANGUAGES } from './languages';
import { SYSTEM_PROMPT, INPUT_INSTRUCTIONS, OUTPUT_INSTRUCTIONS, LITERAL_RETRANSLATION_PROMPT, OUTPUT_LITERAL_RETRANSLATION_PROMPT, QUESTION_SYSTEM_PROMPT, WORD_DEFINITIONS_PROMPT } from './prompts';
import { renderMarkdown } from './markdown';
import * as settings from './settings';
import type { Translation, TranslationWordItem, WordItem, PunctItem, NewlineItem } from './types/translation';
import type { Config } from './types/config';
import type { TranslationSession } from './types/session';

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
 * Gets the effective model for translation, considering overrides
 * @returns {string | null} The effective model ID to use
 */
function getEffectiveModel(): string | null {
    return modelOverride ?? config?.selectedModel ?? null;
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
    await savePreference('currentSession', sessionId);

    allTranslations = [];
    clearTranslationContainers();

    const MAX_HISTORY = 1000;
    const inputItems = await listSessionTranslations(sessionId, 'input', MAX_HISTORY);
    const outputItems = await listSessionTranslations(sessionId, 'output', MAX_HISTORY);
    const questionItems = await listSessionTranslations(sessionId, 'question', MAX_HISTORY);
    allTranslations = [...inputItems, ...outputItems, ...questionItems]
        .sort(function(a, b) { return b.timestamp - a.timestamp; });

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
    const newSession: TranslationSession = {
        id: generateUuid(),
        name: name ?? "New Conversation",
        model: config?.selectedModel ?? null,
        readLanguage: 'english',
        writeLanguage: 'english',
        writePromptId: config?.selectedPromptId ?? null,
        background: "",
        reasoning: "none",
        literalModel: null,
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
        'english',
        config?.selectedPromptId ?? null
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
 * @returns {string} History section or empty string
 */
function buildHistorySection(): string {
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
        if (t.pill === 'input') {
            history += `<THEM>${t.source}</THEM>\n`;
            history += `<THEM>${t.translation}</THEM>\n`;
        } else if (t.pill === 'output') {
            history += `<ME>${t.source}</ME>\n`;
            history += `<ME>${t.translation}</ME>\n`;
        } else if (t.pill === 'question') {
            history += `<USERQUESTION>${t.source}</USERQUESTION>\n`;
            history += `<AGENTANSWER>${t.translation}</AGENTANSWER>\n`;
        }
    }
    history += "</HISTORY>";
    return history;
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

    const history = buildHistorySection();
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
    const effectiveModel = getEffectiveModel();
    if (!config || !effectiveModel) {
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

    textarea.value = '';

    const session = await loadSession(currentSessionId);
    const reasoningLevel = session?.reasoning ?? 'none';
    currentLiteralModel = session?.literalModel ?? null;

    let promptName: string;
    let instructions: string;

    if (mode === 'input') {
        const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
        promptName = readLang?.name ?? 'Foreign';
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', readLang?.name ?? 'your language');
    } else {
        const writeLang = LANGUAGES.find(function(l) { return l.id === session?.writeLanguage; });
        const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
        const prompts = settings.getPrompts();
        const prompt = prompts.find(function(p) { return p.id === session?.writePromptId; });
        const promptContent = session?.promptOverride ?? prompt?.content ?? '';
        instructions = OUTPUT_INSTRUCTIONS.replace('[PROMPT]', promptContent);
        const intentTextarea = document.getElementById('intent-textarea') as HTMLTextAreaElement | null;
        const intent = intentTextarea?.value.trim() ?? '';
        instructions = instructions.replace('[INTENT]', intent ? `Intent: ${intent}` : '');
        instructions = instructions.replace('[LANGUAGE]', writeLang?.name ?? 'the source language');
        instructions = instructions.replace('[TARGET_LANGUAGE]', readLang?.name ?? 'the target language');
        promptName = prompt?.name ?? 'Translate';
        if (intentTextarea) {
            intentTextarea.value = '';
        }
    }

    const userMessage = await buildUserMessage(mode, sourceText, instructions);

    const translation: Translation = {
        id: generateUuid(),
        pill: mode,
        source: sourceText,
        translation: '',
        intent: '',
        explanation: '',
        nuances: '',
        reasoning: '',
        reasoningDetails: '',
        literalRetranslation: '',
        model: effectiveModel,
        modelName: getModelName(effectiveModel),
        prompt: promptName,
        promptContent: instructions,
        timestamp: Date.now(),
        status: 'pending',
        error: null
    };

    allTranslations.push(translation);
    const container = document.getElementById('translations-container');
    if (container) {
        renderTranslationItem(container, translation);
    }

    /** @type {Promise<void>[]} */
    const backgroundTasks: Promise<void>[] = [];

    if (mode === 'input' && session?.literalModel) {
        translation.literalPending = true;
        const writeLang = LANGUAGES.find(function(l) { return l.id === session?.writeLanguage; });
        const targetLangName = writeLang?.name ?? session?.writeLanguage ?? 'target';
        const literalSystemPrompt = LITERAL_RETRANSLATION_PROMPT.replace(/\[LANGUAGE\]/g, targetLangName);
        backgroundTasks.push((async () => {
            try {
                console.log('[translateLiteral] Starting literal of source with model:', session.literalModel);
                const literalResult = await translateRaw(
                    config.openRouterApiKey,
                    sourceText,
                    literalSystemPrompt,
                    session.literalModel,
                    'none',
                    config.temperature
                );
                translation.literalRetranslation = literalResult;
                translation.literalPending = false;
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
            } catch (literalError) {
                console.error('[translateLiteral] Literal failed:', literalError);
                translation.literalPending = false;
            }
        })());
    }

    const wordDefModel = session?.literalModel ?? effectiveModel;
                if (mode === 'input' && wordDefModel) {
            backgroundTasks.push((async () => {
                try {
                    console.log('[wordDefinitions] Starting word definitions of source with model:', wordDefModel);
                    const wordXml = await fetchWordDefinitions(wordDefModel, sourceText);
                    translation.wordDefinitions = wordXml;
                    translation.wordData = parseWordDefinitions(wordXml);
                    console.log('[wordDefinitions] Parsed', translation.wordData.length, 'word items');
                    translation.wordPending = false;
                    saveSessionTranslation(currentSessionId, translation);
                    updateTranslationItem(translation);
                    const wordElement = document.getElementById('translation-' + translation.id);
                    const wordContent = wordElement?.querySelector('.translation-words');
                    if (wordContent) {
                        wordContent.innerHTML = '';
                        renderWordContent(wordContent, translation);
                    }
                } catch (wordDefError) {
                    console.error('[wordDefinitions] Failed:', wordDefError);
                    translation.wordPending = false;
                }
            })());
        }

        if (backgroundTasks.length > 0) {
            Promise.all(backgroundTasks)
            .then(() => updateTranslationItem(translation))
            .catch(() => updateTranslationItem(translation));
    }

    try {
        const result = await translateStructured(
            config.openRouterApiKey,
            userMessage,
            SYSTEM_PROMPT,
            effectiveModel,
            reasoningLevel
        );

        translation.translation = result.translation;
        translation.explanation = result.explanation;
        translation.nuances = result.nuances;
        translation.reasoning = result.reasoning;
        translation.reasoningDetails = result.reasoningDetails;
        translation.status = 'complete';
        saveSessionTranslation(currentSessionId, translation);

        if (mode === 'output' && session?.literalModel) {
            translation.literalPending = true;
            backgroundTasks.push((async () => {
                try {
                    const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
                    const sourceLangName = readLang?.name ?? session?.readLanguage ?? 'source';
                    const literalSystemPrompt = OUTPUT_LITERAL_RETRANSLATION_PROMPT.replace(/\[LANGUAGE\]/g, sourceLangName);
                    const literalUserMessage = result.translation;
                    console.log('[translateLiteral] Starting literal retranslation with model:', session.literalModel);
                    const literalResult = await translateRaw(
                        config.openRouterApiKey,
                        literalUserMessage,
                        literalSystemPrompt,
                        session.literalModel,
                        'none',
                        config.temperature
                    );
                    translation.literalRetranslation = literalResult;
                    translation.literalPending = false;
                    saveSessionTranslation(currentSessionId, translation);
                    updateTranslationItem(translation);
                } catch (literalError) {
                    console.error('[translateLiteral] Literal retranslation failed:', literalError);
                    translation.literalPending = false;
                }
            })());
        }

        if (mode === 'output' && wordDefModel && result.translation) {
            backgroundTasks.push((async () => {
                try {
                    console.log('[wordDefinitions] Starting word definitions with model:', wordDefModel);
                    const wordXml = await fetchWordDefinitions(wordDefModel, result.translation);
                    translation.wordDefinitions = wordXml;
                    translation.wordData = parseWordDefinitions(wordXml);
                    console.log('[wordDefinitions] Parsed', translation.wordData.length, 'word items');
                    translation.wordPending = false;
                    saveSessionTranslation(currentSessionId, translation);
                    updateTranslationItem(translation);
                    const wordElement = document.getElementById('translation-' + translation.id);
                    const wordContent = wordElement?.querySelector('.translation-words');
                    if (wordContent) {
                        wordContent.innerHTML = '';
                        renderWordContent(wordContent, translation);
                    }
                } catch (wordDefError) {
                    console.error('[wordDefinitions] Failed:', wordDefError);
                    translation.wordPending = false;
                }
            })());
        }

        if (backgroundTasks.length > 0) {
            Promise.all(backgroundTasks)
                .then(() => updateTranslationItem(translation))
                .catch(() => updateTranslationItem(translation));
        }

        updateTranslationItem(translation);
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
        if (backgroundTasks.length > 0) {
            Promise.all(backgroundTasks)
                .then(() => updateTranslationItem(translation))
                .catch(() => updateTranslationItem(translation));
        } else {
            updateTranslationItem(translation);
        }
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
    const effectiveModel = getEffectiveModel();
    if (!config || !effectiveModel) {
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

    const userMessage = await buildQuestionMessage(questionText);

    const session = await loadSession(currentSessionId);

    const translation: Translation = {
        id: generateUuid(),
        pill: 'question',
        source: questionText,
        translation: '',
        explanation: '',
        nuances: '',
        reasoning: '',
        reasoningDetails: '',
        model: effectiveModel,
        modelName: getModelName(effectiveModel),
        prompt: 'Question',
        promptContent: QUESTION_SYSTEM_PROMPT,
        timestamp: Date.now(),
        status: 'pending',
        error: null
    };

    allTranslations.push(translation);
    renderAllTranslations();

    try {
        const result = await translateRaw(
            config.openRouterApiKey,
            userMessage,
            QUESTION_SYSTEM_PROMPT,
            effectiveModel,
            session?.reasoning ?? 'none',
            config.questionTemperature
        );
        translation.translation = result;
        translation.status = 'complete';
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
    if (!config || !config.openRouterApiKey) {
        return;
    }

    try {
        const { fetchBalance } = await import('./openrouter');
        const balanceInfo = await fetchBalance(config.openRouterApiKey);
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
                toggleSectionsBtn.textContent = '▲';
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
        const literalTab = element.querySelector('#literal-tab');
        const explanationTab = element.querySelector('#explanation-tab');
        const nuancesTab = element.querySelector('#nuances-tab');
        const wordsTab = element.querySelector('#words-tab');
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
            copySourceBtn.addEventListener('click', function() {
                navigator.clipboard.writeText(translation.source).catch(function() {
                    console.log('Failed to copy source text');
                });
            });
        }

        if (copyTargetBtn) {
            copyTargetBtn.addEventListener('click', function() {
                navigator.clipboard.writeText(translation.translation).catch(function() {
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
                if (editSource) editSource.value = translation.source;
                if (editIntent) editIntent.value = translation.intent ?? '';
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
                regenerateLiteralRetranslation(translationId);
            });
        }

        setupToggleHandler(element, translation);

        container.insertBefore(element, container.firstChild);
    }

    if (element && !element.dataset.wordsHandler) {
        const wordsTab = element.querySelector('#words-tab-' + translation.id) as HTMLElement | null;
        const wordsContentEl = element.querySelector('.translation-words') as HTMLElement | null;
        if (wordsTab && wordsContentEl) {
            wordsTab.addEventListener('click', function() {
                console.log('[WordsTab] Clicked, wordData:', translation.wordData?.length, 'wordPending:', translation.wordPending);
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
    const sectionsArea = element.querySelector('.translation-sections-area') as HTMLElement | null;
    const toggleSectionsBtn = element.querySelector('.toggle-sections-btn') as HTMLButtonElement | null;
    const wordsPane = element.querySelector('#words-pane-' + translation.id) as HTMLElement | null;
    const wordsContent = element.querySelector('.translation-words') as HTMLElement | null;

    if (sourceEl) {
        sourceEl.textContent = translation.source;
    }
    if (promptEl) {
        promptEl.textContent = translation.prompt;
    }
    if (modelNameEl) {
        modelNameEl.textContent = translation.modelName;
    }

    if (translation.status === 'pending') {
        if (spinnerEl) spinnerEl.style.display = 'block';
        if (errorEl) errorEl.style.display = 'none';
        if (targetEl) targetEl.innerHTML = '';
        if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
        if (charCountEl) {
            charCountEl.textContent = `(${translation.source.length}/—)`;
        }
    } else if (translation.status === 'error') {
        if (spinnerEl) spinnerEl.style.display = 'none';
        if (targetEl) targetEl.innerHTML = '';
        if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
        if (charCountEl) {
            charCountEl.textContent = `(${translation.source.length}/—)`;
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
                targetEl.innerHTML = renderMarkdown(translation.translation);
                const toggleAnswerBtn = element.querySelector('.toggle-answer-btn') as HTMLButtonElement | null;
                if (translation.answerCollapsed) {
                    targetEl.classList.add('answer-collapsed');
                    if (toggleAnswerBtn) toggleAnswerBtn.textContent = '▲';
                } else {
                    targetEl.classList.remove('answer-collapsed');
                    if (toggleAnswerBtn) toggleAnswerBtn.textContent = '▼';
                }
            } else {
                targetEl.innerHTML = renderMarkdown(translation.translation);
            }
        }
        if (charCountEl) {
            charCountEl.textContent = `(${translation.source.length}/${translation.translation.length})`;
        }

        if (literalEl) {
            if (translation.literalPending) {
                literalEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Retranslating...</span>';
                if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
            } else if (translation.literalRetranslation) {
                literalEl.innerHTML = renderMarkdown(translation.literalRetranslation);
                if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
            } else {
                literalEl.innerHTML = '';
                if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
            }
        }
        if (explanationEl) {
            explanationEl.innerHTML = translation.explanation ? renderMarkdown(translation.explanation) : '';
        }
        if (nuancesEl) {
            nuancesEl.innerHTML = translation.nuances ? renderMarkdown(translation.nuances) : '';
        }

        if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';

        if (sectionsArea && toggleSectionsBtn) {
            if (translation.sectionsCollapsed) {
                sectionsArea.classList.add('translation-sections-collapsed');
                toggleSectionsBtn.textContent = '▲';
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

    const effectiveModel = getEffectiveModel();
    if (!config || !effectiveModel || !config.openRouterApiKey) {
        ui.displayError("Cannot retry: no model selected or no API key");
        return;
    }

    translation.status = 'pending';
    translation.error = null;
    translation.wordDefinitions = undefined;
    translation.wordData = undefined;
    translation.wordPending = false;
    renderAllTranslations();

    const session = await loadSession(currentSessionId);
    const reasoningLevel = session?.reasoning ?? 'none';

    if (translation.pill === 'question') {
        const userMessage = await buildQuestionMessage(translation.source);
        try {
            const result = await translateRaw(
                config.openRouterApiKey,
                userMessage,
                QUESTION_SYSTEM_PROMPT,
                effectiveModel,
                reasoningLevel,
                config.questionTemperature
            );
            translation.translation = result;
            translation.status = 'complete';
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
    if (translation.pill === 'input') {
        const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', readLang?.name ?? 'the target language');
    } else {
        const writeLang = LANGUAGES.find(function(l) { return l.id === session?.writeLanguage; });
        const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
        const prompts = settings.getPrompts();
        const prompt = prompts.find(function(p) { return p.id === session?.writePromptId; });
        const promptContent = session?.promptOverride ?? prompt?.content ?? '';
        instructions = OUTPUT_INSTRUCTIONS.replace('[PROMPT]', promptContent);
        instructions = instructions.replace('[INTENT]', translation.intent ? `Intent: ${translation.intent}` : '');
        instructions = instructions.replace('[LANGUAGE]', writeLang?.name ?? 'the source language');
        instructions = instructions.replace('[TARGET_LANGUAGE]', readLang?.name ?? 'the target language');
    }

    const userMessage = await buildUserMessage(translation.pill, translation.source, instructions);

    try {
        const result = await translateStructured(
            config.openRouterApiKey,
            userMessage,
            SYSTEM_PROMPT,
            effectiveModel,
            reasoningLevel,
            config.temperature
        );

        translation.translation = result.translation;
        translation.explanation = result.explanation;
        translation.nuances = result.nuances;
        translation.reasoning = result.reasoning;
        translation.reasoningDetails = result.reasoningDetails;
        translation.status = 'complete';
        saveSessionTranslation(currentSessionId, translation);
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

    translation.translation = '';
    translation.explanation = '';
    translation.nuances = '';
    translation.reasoning = '';
    translation.reasoningDetails = '';
    translation.status = 'pending';
    translation.error = null;
    updateTranslationItem(translation);

    const session = await loadSession(currentSessionId);
    const effectiveModel = getEffectiveModel();
    translation.model = effectiveModel;
    translation.modelName = getModelName(effectiveModel ?? '');
    const reasoningLevel = session?.reasoning ?? 'none';
    const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
    const instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', readLang?.name ?? 'your language');
    const userMessage = await buildUserMessage('input', translation.source, instructions);

    try {
const result = await translateStructured(
            config.openRouterApiKey,
            userMessage,
            SYSTEM_PROMPT,
            effectiveModel,
            reasoningLevel,
            config.temperature
        );

        translation.translation = result.translation;
        translation.explanation = result.explanation;
        translation.nuances = result.nuances;
        translation.reasoning = result.reasoning;
        translation.reasoningDetails = result.reasoningDetails;
        translation.status = 'complete';
        saveSessionTranslation(currentSessionId, translation);
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

    const effectiveModel = getEffectiveModel();
    if (!config || !effectiveModel || !config.openRouterApiKey) {
        ui.displayError("Cannot retranslate: no model selected or no API key");
        return;
    }

    const session = await loadSession(currentSessionId);
    const reasoningLevel = session?.reasoning ?? 'none';

    translation.status = 'pending';
    translation.error = null;
    translation.source = newSource;
    translation.intent = newIntent || undefined;
    translation.translation = '';
    translation.explanation = '';
    translation.nuances = '';
    translation.reasoning = '';
    translation.reasoningDetails = '';
    translation.literalRetranslation = '';
    translation.literalPending = false;
    translation.wordDefinitions = undefined;
    translation.wordData = undefined;
    translation.wordPending = false;
    updateTranslationItem(translation);

    let instructions: string;
    if (translation.pill === 'input') {
        const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', readLang?.name ?? 'the target language');
    } else {
        const writeLang = LANGUAGES.find(function(l) { return l.id === session?.writeLanguage; });
        const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
        const prompts = settings.getPrompts();
        const prompt = prompts.find(function(p) { return p.id === session?.writePromptId; });
        const promptContent = session?.promptOverride ?? prompt?.content ?? '';
        instructions = OUTPUT_INSTRUCTIONS.replace('[PROMPT]', promptContent);
        instructions = instructions.replace('[INTENT]', newIntent ? `Intent: ${newIntent}` : '');
        instructions = instructions.replace('[LANGUAGE]', writeLang?.name ?? 'the source language');
        instructions = instructions.replace('[TARGET_LANGUAGE]', readLang?.name ?? 'the target language');
    }

    const userMessage = await buildUserMessage(translation.pill, newSource, instructions);

    try {
        const result = await translateStructured(
            config.openRouterApiKey,
            userMessage,
            SYSTEM_PROMPT,
            effectiveModel,
            reasoningLevel
        );

        translation.translation = result.translation;
        translation.explanation = result.explanation;
        translation.nuances = result.nuances;
        translation.reasoning = result.reasoning;
        translation.reasoningDetails = result.reasoningDetails;
        translation.status = 'complete';
        saveSessionTranslation(currentSessionId, translation);

        currentLiteralModel = session?.literalModel ?? null;
        /** @type {Promise<void>[]} */
        const tasks: Promise<void>[] = [];

        if (session?.literalModel) {
            translation.literalPending = true;
            tasks.push((async () => {
                try {
                    const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
                    const sourceLangName = readLang?.name ?? session?.readLanguage ?? 'source';
                    const literalPrompt = translation.pill === 'input'
                        ? LITERAL_RETRANSLATION_PROMPT
                        : OUTPUT_LITERAL_RETRANSLATION_PROMPT;
                    const literalSystemPrompt = literalPrompt.replace(/\[LANGUAGE\]/g, sourceLangName);
                    const literalUserMessage = result.translation;
                    const literalResult = await translateRaw(
                        config.openRouterApiKey,
                        literalUserMessage,
                        literalSystemPrompt,
                        session.literalModel,
                        'none',
                        config.temperature
                    );
                    translation.literalRetranslation = literalResult;
                    translation.literalPending = false;
                    saveSessionTranslation(currentSessionId, translation);
                } catch (literalError) {
                    console.error('[retranslateFromEdit] Literal retranslation failed:', literalError);
                    translation.literalPending = false;
                }
            })());
        }

        const wordDefModel = session?.literalModel ?? effectiveModel;
        if (wordDefModel && result.translation) {
            translation.wordPending = true;
            tasks.push((async () => {
                try {
                    console.log('[wordDefinitions] Starting word definitions with model:', wordDefModel);
                    const wordXml = await fetchWordDefinitions(wordDefModel, result.translation);
                    translation.wordDefinitions = wordXml;
                    translation.wordData = parseWordDefinitions(wordXml);
                    console.log('[wordDefinitions] Parsed', translation.wordData.length, 'word items');
                    translation.wordPending = false;
                    saveSessionTranslation(currentSessionId, translation);
                } catch (wordDefError) {
                    console.error('[wordDefinitions] Failed:', wordDefError);
                    translation.wordPending = false;
                }
            })());
        }

        if (tasks.length > 0) {
            updateTranslationItem(translation);
            Promise.all(tasks)
                .then(() => updateTranslationItem(translation))
                .catch(() => updateTranslationItem(translation));
        }
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
        updateTranslationItem(translation);
    }

    await refreshBalance();
}

/**
 * Regenerates the literal retranslation for a completed translation
 * @param {string} translationId - ID of translation to regenerate literal for
 * @returns {Promise<void>}
 */
export async function regenerateLiteralRetranslation(translationId: string): Promise<void> {
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

    const effectiveModel = getEffectiveModel();
    if (!config || !config.openRouterApiKey) {
        console.error('[regenerateLiteral] No API key');
        return;
    }

    const readLang = LANGUAGES.find(function(l) { return l.id === session?.readLanguage; });
    const sourceLangName = readLang?.name ?? session?.readLanguage ?? 'source';
    const literalPrompt = translation.pill === 'input'
        ? LITERAL_RETRANSLATION_PROMPT
        : OUTPUT_LITERAL_RETRANSLATION_PROMPT;
    const literalSystemPrompt = literalPrompt.replace(/\[LANGUAGE\]/g, sourceLangName);
    const literalUserMessage = translation.pill === 'input'
        ? translation.source
        : translation.translation;
    console.log('[regenerateLiteral] Starting literal retranslation with model:', session.literalModel);
    console.log('[regenerateLiteral] Input text (' + translation.pill + '):', literalUserMessage.substring(0, 200));

    translation.literalPending = true;
    updateTranslationItem(translation);

    /** @type {Promise<void>[]} */
    const tasks: Promise<void>[] = [];

    if (session?.literalModel) {
        tasks.push((async () => {
            try {
                const literalResult = await translateRaw(
                    config.openRouterApiKey,
                    literalUserMessage,
                    literalSystemPrompt,
                    session.literalModel,
                    'none',
                    config.temperature
                );
                console.log('[regenerateLiteral] Literal result:', literalResult.substring(0, 200));
                translation.literalRetranslation = literalResult;
                translation.literalPending = false;
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
            } catch (literalError) {
                console.error('[regenerateLiteral] Literal retranslation failed:', literalError);
                translation.literalPending = false;
            }
        })());
    }

    const wordDefModel = session?.literalModel ?? effectiveModel;
    if (wordDefModel && translation.translation) {
        translation.wordPending = true;
        tasks.push((async () => {
            try {
                console.log('[wordDefinitions] Starting word definitions with model:', wordDefModel);
                const wordText = translation.pill === 'input'
                    ? translation.source
                    : translation.translation;
                const wordXml = await fetchWordDefinitions(wordDefModel, wordText);
                translation.wordDefinitions = wordXml;
                translation.wordData = parseWordDefinitions(wordXml);
                console.log('[wordDefinitions] Parsed', translation.wordData.length, 'word items');
                translation.wordPending = false;
                saveSessionTranslation(currentSessionId, translation);
                updateTranslationItem(translation);
                const wordElement = document.getElementById('translation-' + translation.id);
                const wordContent = wordElement?.querySelector('.translation-words');
                if (wordContent) {
                    wordContent.innerHTML = '';
                    renderWordContent(wordContent, translation);
                }
            } catch (wordDefError) {
                console.error('[wordDefinitions] Failed:', wordDefError);
                translation.wordPending = false;
            }
        })());
    }

    if (tasks.length > 0) {
        updateTranslationItem(translation);
        Promise.all(tasks)
            .then(() => updateTranslationItem(translation))
            .catch(() => updateTranslationItem(translation));
    }
}

/**
 * Fetches word-by-word definitions for a completed translation
 * @param {string} model - Model ID to use
 * @param {string} text - The translation text to analyze
 * @returns {Promise<string>} Raw XML response
 * @throws {Error} If API request fails
 */
async function fetchWordDefinitions(model: string, text: string): Promise<string> {
    const prompt = WORD_DEFINITIONS_PROMPT.replace('[TEXT]', text);
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

    if (translation.wordPending) {
        container.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Loading word data...</span>';
        return;
    }
    if (!translation.wordData || translation.wordData.length === 0) {
        container.textContent = 'No word data available.';
        return;
    }

    for (let i = 0; i < translation.wordData.length; i++) {
        const item = translation.wordData[i];

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