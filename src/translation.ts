/**
 * Translation Module
 * Handles translation functionality for input and output panes
 */

import { translateStructured, translateRaw } from './openrouter';
import { getPreference, savePreference, listSessions, saveSession, loadSession, deleteSession as storageDeleteSession, getOrCreateDefaultSession, saveSessionTranslation, listSessionTranslations } from './storage';
import { DEBUG_TRANSLATIONS, DEBUG_SESSIONS } from './debug';
import * as ui from './ui';
import { LANGUAGES } from './languages';
import { SYSTEM_PROMPT, INPUT_INSTRUCTIONS, OUTPUT_INSTRUCTIONS, LITERAL_RETRANSLATION_PROMPT, QUESTION_SYSTEM_PROMPT } from './prompts';
import { renderMarkdown } from './markdown';
import * as settings from './settings';
import type { Translation } from './types/translation';
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
 * In-memory translation arrays - source of truth for translations
 * @type {Translation[]}
 */
let inputTranslations: Translation[] = [];

/**
 * @type {Translation[]}
 */
let outputTranslations: Translation[] = [];

/**
 * Maps of model IDs to names for display
 * @type {Map<string, string>}
 */
let modelNameMap: Map<string, string> = new Map();

/**
 * Temporary model override for input pane (not persisted)
 * @type {string | null}
 */
let inputModelOverride: string | null = null;

/**
 * Temporary model override for output pane (not persisted)
 * @type {string | null}
 */
let outputModelOverride: string | null = null;

/**
 * Sets the model override dropdowns with available models
 * @param {Array<{id: string; name: string; pricing?: {prompt: string; completion: string}; providerName?: string}>} models - Array of model objects
 * @returns {void}
 */
export function setModelOverrideOptions(models: Array<{id: string; name: string; pricing?: {prompt: string; completion: string}; providerName?: string}>): void {
    const inputOverrideSelect = document.getElementById('input-model-override') as HTMLSelectElement | null;
    const outputOverrideSelect = document.getElementById('output-model-override') as HTMLSelectElement | null;

    const populateSelect = function(select: HTMLSelectElement | null) {
        if (!select) return;
        select.innerHTML = '';

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Default LLM';
        select.appendChild(defaultOption);

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
            select.appendChild(option);
        }
    };

    populateSelect(inputOverrideSelect);
    populateSelect(outputOverrideSelect);
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
 * Gets the effective model for a translation pill, considering overrides
 * @param {'input' | 'output'} pill - Which pane
 * @returns {string | null} The effective model ID to use
 */
function getEffectiveModel(pill: 'input' | 'output'): string | null {
    if (pill === 'input') {
        return inputModelOverride ?? config?.selectedModel ?? null;
    }
    return outputModelOverride ?? config?.selectedModel ?? null;
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

    inputTranslations = [];
    outputTranslations = [];
    clearTranslationContainers();

    const MAX_HISTORY = 1000;
    inputTranslations = await listSessionTranslations(sessionId, 'input', MAX_HISTORY);
    outputTranslations = await listSessionTranslations(sessionId, 'output', MAX_HISTORY);

    renderTranslations('input');
    renderTranslations('output');

    if (config) {
        if (session.model) {
            config.selectedModel = session.model;
        }
        if (session.promptId) {
            config.selectedPromptId = session.promptId;
        }
    }

    if (session.inputLanguage) {
        populateLanguageDropdowns(session.inputLanguage);
    }

    settings.updatePromptDropdown();

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
        inputLanguage: getCurrentInputLanguage(),
        promptId: config?.selectedPromptId ?? null,
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
 * Saves the current session state (model, language, prompt)
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
        session.promptId = config.selectedPromptId;
    }
    session.inputLanguage = getCurrentInputLanguage();

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
 * Clears both translation containers in the DOM
 * @returns {void}
 */
function clearTranslationContainers(): void {
    const inputContainer = document.getElementById('input-translations-container');
    const outputContainer = document.getElementById('output-translations-container');

    if (inputContainer) {
        inputContainer.innerHTML = '';
    }
    if (outputContainer) {
        outputContainer.innerHTML = '';
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
 * Gets the currently selected input language from the dropdown
 * @returns {string} Language ID
 */
function getCurrentInputLanguage(): string {
    const dropdown = document.getElementById('input-language-dropdown') as HTMLSelectElement | null;
    return dropdown?.value ?? 'english';
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
        await getPreference('inputLanguage') ?? 'english',
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

    inputTranslations = await listSessionTranslations(currentSessionId, 'input', MAX_HISTORY);
    if (DEBUG_TRANSLATIONS) {
        console.log(`[loadTranslationHistory] Loaded ${inputTranslations.length} input translations`);
    }
    renderTranslations('input');

    outputTranslations = await listSessionTranslations(currentSessionId, 'output', MAX_HISTORY);
    if (DEBUG_TRANSLATIONS) {
        console.log(`[loadTranslationHistory] Loaded ${outputTranslations.length} output translations`);
    }
    renderTranslations('output');

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

    const allTranslations: Translation[] = [...inputTranslations, ...outputTranslations];

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
    const inputBtn = document.getElementById("input-translate-btn");
    const outputBtn = document.getElementById("output-translate-btn");
    const askBtn = document.getElementById("output-ask-btn");

    if (inputBtn) {
        inputBtn.addEventListener('click', function() {
            translate('input');
        });
    }

    if (outputBtn) {
        outputBtn.addEventListener('click', function() {
            translate('output');
        });
    }

    if (askBtn) {
        askBtn.addEventListener('click', function() {
            askQuestion();
        });
    }

    const inputOverrideSelect = document.getElementById('input-model-override') as HTMLSelectElement | null;
    const outputOverrideSelect = document.getElementById('output-model-override') as HTMLSelectElement | null;

    if (inputOverrideSelect) {
        inputOverrideSelect.addEventListener('change', function() {
            inputModelOverride = inputOverrideSelect.value || null;
        });
    }

    if (outputOverrideSelect) {
        outputOverrideSelect.addEventListener('change', function() {
            outputModelOverride = outputOverrideSelect.value || null;
        });
    }

    updateButtonStates();
}

/**
 * Sets up keyboard handlers for textareas to trigger translation on Shift+Enter or Ctrl+Enter
 * @returns {void}
 */
export function setupTextareaKeyHandlers(): void {
    const inputTextarea = document.getElementById('input-textarea') as HTMLTextAreaElement | null;
    const outputTextarea = document.getElementById('output-textarea') as HTMLTextAreaElement | null;

    if (inputTextarea) {
        inputTextarea.addEventListener('keydown', function(event: KeyboardEvent): void {
            if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey)) {
                event.preventDefault();
                translate('input');
            }
        });
    }

    if (outputTextarea) {
        outputTextarea.addEventListener('keydown', function(event: KeyboardEvent): void {
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
 * Populates the input language dropdown
 * @param {string} inputLanguage - Pre-selected input language ID
 * @returns {void}
 */
export function populateLanguageDropdowns(inputLanguage: string): void {
    const inputDropdown = document.getElementById('input-language-dropdown') as HTMLSelectElement | null;

    if (inputDropdown) {
        inputDropdown.innerHTML = '';
        for (const lang of LANGUAGES) {
            const option = document.createElement('option');
            option.value = lang.id;
            option.textContent = lang.name;
            inputDropdown.appendChild(option);
        }
        inputDropdown.value = inputLanguage;
    }
}

/**
 * Sets up input language dropdown change handler
 * @returns {void}
 */
export function setupLanguageDropdownHandlers(): void {
    const inputDropdown = document.getElementById('input-language-dropdown') as HTMLSelectElement | null;

    if (inputDropdown) {
        inputDropdown.addEventListener('change', async function() {
            const langId = inputDropdown.value;
            const session = await loadSession(currentSessionId);
            if (session) {
                session.inputLanguage = langId;
                await saveSession(session);
            }
        });
    }
}

/**
 * Updates button enabled/disabled states based on model selection
 * @returns {void}
 */
export function updateButtonStates(): void {
    const inputBtn = document.getElementById("input-translate-btn") as HTMLButtonElement | null;
    const outputBtn = document.getElementById("output-translate-btn") as HTMLButtonElement | null;
    const askBtn = document.getElementById("output-ask-btn") as HTMLButtonElement | null;

    const hasModel = config !== null && config.selectedModel !== null;

    if (inputBtn) {
        inputBtn.disabled = !hasModel;
    }

    if (outputBtn) {
        outputBtn.disabled = !hasModel;
    }

    if (askBtn) {
        askBtn.disabled = !hasModel;
    }
}

/**
 * Builds the complete user message for structured translation
 * @param {'input' | 'output'} pill - Which pane
 * @param {string} sourceText - Text to translate
 * @param {string} instructions - Instruction text (language or prompt instructions)
 * @returns {Promise<string>} Complete user message
 */
async function buildUserMessage(pill: 'input' | 'output', sourceText: string, instructions: string): Promise<string> {
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
 * Performs translation for the specified pane
 * @param {'input' | 'output'} pill - Which pane to translate
 * @returns {Promise<void>}
 */
export async function translate(pill: 'input' | 'output'): Promise<void> {
    const effectiveModel = getEffectiveModel(pill);
    if (!config || !effectiveModel) {
        ui.displayError("Please select a model first");
        return;
    }

    if (!config.openRouterApiKey) {
        ui.displayError("Please enter your API key first");
        return;
    }

    const textareaId = pill === 'input' ? 'input-textarea' : 'output-textarea';
    const textarea = document.getElementById(textareaId) as HTMLTextAreaElement | null;

    if (!textarea) {
        return;
    }

    const sourceText = textarea.value.trim();
    if (!sourceText) {
        ui.displayError("Please enter text to translate");
        return;
    }

    textarea.value = '';

    const translations = pill === 'input' ? inputTranslations : outputTranslations;

    let promptName: string;
    let instructions: string;

    if (pill === 'input') {
        const languageDropdown = document.getElementById('input-language-dropdown') as HTMLSelectElement | null;
        if (!languageDropdown) {
            return;
        }

        const languageId = languageDropdown.value;
        const language = LANGUAGES.find(function(l) { return l.id === languageId; });

        if (!language) {
            ui.displayError("Please select a language");
            return;
        }

        promptName = language.name;
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', language.name);
    } else {
        const promptDropdown = document.getElementById('prompt-dropdown') as HTMLSelectElement | null;
        if (!promptDropdown) {
            return;
        }

        const promptId = promptDropdown.value;
        if (!promptId) {
            ui.displayError("Please select a prompt");
            return;
        }

        const prompts = settings.getPrompts();
        const selectedPrompt = prompts.find(function(p) { return p.id === promptId; });

        if (!selectedPrompt) {
            ui.displayError("Please select a prompt");
            return;
        }

        promptName = selectedPrompt.name;
        const outputSession = await loadSession(currentSessionId);
        const promptContent = outputSession?.promptOverride ?? selectedPrompt.content;
        instructions = OUTPUT_INSTRUCTIONS.replace('[PROMPT]', promptContent);
        const intentTextarea = document.getElementById('output-intent-textarea') as HTMLTextAreaElement | null;
        const intent = intentTextarea?.value.trim() ?? '';
        instructions = instructions.replace('[INTENT]', intent ? `Intent: ${intent}` : '');
        const inputLangId = getCurrentInputLanguage();
        const inputLang = LANGUAGES.find(function(l) { return l.id === inputLangId; });
        if (inputLang) {
            instructions = instructions.replace('[LANGUAGE]', inputLang.name);
        } else {
            instructions = instructions.replace('[LANGUAGE]', 'the input language');
        }
    }

    const userMessage = await buildUserMessage(pill, sourceText, instructions);

    const session = await loadSession(currentSessionId);
    const reasoningLevel = session?.reasoning ?? 'none';
    currentLiteralModel = session?.literalModel ?? null;

    let intentForTranslation = '';
    if (pill === 'output' && intentTextarea) {
        intentForTranslation = intent;
        intentTextarea.value = '';
    }

    const translation: Translation = {
        id: generateUuid(),
        pill: pill,
        source: sourceText,
        translation: '',
        intent: intentForTranslation,
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

    translations.push(translation);
    renderTranslations(pill);

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

        if (session?.literalModel) {
            try {
                const sourceLangId = getCurrentInputLanguage();
                const sourceLang = LANGUAGES.find(function(l) { return l.id === sourceLangId; });
                const sourceLangName = sourceLang?.name ?? sourceLangId;
                const literalSystemPrompt = LITERAL_RETRANSLATION_PROMPT.replace(/\[LANGUAGE\]/g, sourceLangName);
                const literalUserMessage = result.translation;
                console.log('[translateLiteral] Starting literal retranslation with model:', session.literalModel);
                console.log('[translateLiteral] Input text length:', result.translation.length);
                console.log('[translateLiteral] Input text (first 200 chars):', result.translation.substring(0, 200));
                translation.literalPending = true;
                renderTranslations(pill);
                const literalResult = await translateRaw(
                    config.openRouterApiKey,
                    literalUserMessage,
                    literalSystemPrompt,
                    session.literalModel,
                    'none'
                );
                console.log('[translateLiteral] Literal result:', literalResult.substring(0, 200));
                console.log('[translateLiteral] Full literal result:', literalResult);
                translation.literalRetranslation = literalResult;
                translation.literalPending = false;
                saveSessionTranslation(currentSessionId, translation);
            } catch (literalError) {
                console.error('[translateLiteral] Literal retranslation failed:', literalError);
                translation.literalPending = false;
            }
        }
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
    }

    renderTranslations(pill);
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
    const effectiveModel = getEffectiveModel('output');
    if (!config || !effectiveModel) {
        ui.displayError("Please select a model first");
        return;
    }

    if (!config.openRouterApiKey) {
        ui.displayError("Please enter your API key first");
        return;
    }

    const textarea = document.getElementById('output-textarea') as HTMLTextAreaElement | null;
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

    outputTranslations.push(translation);
    renderTranslations('output');

    try {
        const result = await translateRaw(
            config.openRouterApiKey,
            userMessage,
            QUESTION_SYSTEM_PROMPT,
            effectiveModel,
            session?.reasoning ?? 'none'
        );
        translation.translation = result;
        translation.status = 'complete';
        saveSessionTranslation(currentSessionId, translation);
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Failed to get answer";
    }

    renderTranslations('output');
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
        ui.updateBalanceDisplay("$" + balanceInfo.totalCredits.toFixed(2));
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
 * Renders translations for the specified pane
 * @param {'input' | 'output'} pill - Which pane to render
 * @returns {void}
 */
export function renderTranslations(pill: 'input' | 'output'): void {
    const containerId = pill === 'input' ? 'input-translations-container' : 'output-translations-container';
    const container = document.getElementById(containerId);

    if (!container) {
        return;
    }

    const translations = pill === 'input' ? inputTranslations : outputTranslations;

    for (let i = translations.length - 1; i >= 0; i--) {
        const translation = translations[i];
        const elementId = 'translation-' + translation.id;
        let element = document.getElementById(elementId);

        if (!element) {
            let template: HTMLTemplateElement | null = null;
            if (translation.pill === 'question') {
                template = document.getElementById('question-item-template') as HTMLTemplateElement | null;
            }
            if (!template) {
                template = document.getElementById('translation-item-template') as HTMLTemplateElement | null;
            }
            if (!template) {
                continue;
            }

            const clone = template.content.cloneNode(true) as DocumentFragment;
            element = clone.firstElementChild as HTMLElement;
            element.id = elementId;

            const literalPane = element.querySelector('#literal-pane');
            const explanationPane = element.querySelector('#explanation-pane');
            const nuancesPane = element.querySelector('#nuances-pane');
            const literalTab = element.querySelector('#literal-tab');
            const explanationTab = element.querySelector('#explanation-tab');
            const nuancesTab = element.querySelector('#nuances-tab');
            if (literalPane) {
                literalPane.id = 'literal-pane-' + translation.id;
                literalPane.setAttribute('aria-labelledby', 'literal-tab-' + translation.id);
            }
            if (explanationPane) {
                explanationPane.id = 'explanation-pane-' + translation.id;
                explanationPane.setAttribute('aria-labelledby', 'explanation-tab-' + translation.id);
            }
            if (nuancesPane) {
                nuancesPane.id = 'nuances-pane-' + translation.id;
                nuancesPane.setAttribute('aria-labelledby', 'nuances-tab-' + translation.id);
            }
            if (literalTab) {
                literalTab.id = 'literal-tab-' + translation.id;
                literalTab.setAttribute('data-bs-target', '#literal-pane-' + translation.id);
                literalTab.setAttribute('aria-controls', 'literal-pane-' + translation.id);
            }
            if (explanationTab) {
                explanationTab.id = 'explanation-tab-' + translation.id;
                explanationTab.setAttribute('data-bs-target', '#explanation-pane-' + translation.id);
                explanationTab.setAttribute('aria-controls', 'explanation-pane-' + translation.id);
            }
            if (nuancesTab) {
                nuancesTab.id = 'nuances-tab-' + translation.id;
                nuancesTab.setAttribute('data-bs-target', '#nuances-pane-' + translation.id);
                nuancesTab.setAttribute('aria-controls', 'nuances-pane-' + translation.id);
            }

            const retryBtn = element.querySelector('.retry-btn');
            if (retryBtn) {
                const translationId = translation.id;
                retryBtn.addEventListener('click', function() {
                    retryTranslation(pill, translationId);
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

            const editToggleBtn = element.querySelector('.edit-toggle-btn') as HTMLButtonElement | null;
            const editArea = element.querySelector('.translation-edit-area') as HTMLElement | null;
            const editSource = element.querySelector('.translation-edit-source') as HTMLTextAreaElement | null;
            const editIntent = element.querySelector('.translation-edit-intent') as HTMLTextAreaElement | null;
            const retranslateBtn = element.querySelector('.retranslate-btn') as HTMLButtonElement | null;

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

            if (retranslateBtn) {
                retranslateBtn.addEventListener('click', function() {
                    const newSource = editSource?.value.trim() ?? '';
                    if (!newSource) {
                        ui.displayError("Source text cannot be empty");
                        return;
                    }
                    const newIntent = editIntent?.value.trim() ?? '';
                    if (editArea) editArea.style.display = 'none';
                    retranslateFromEdit(pill, translation.id, newSource, newIntent);
                });
            }

            const regenerateLiteralBtn = element.querySelector('.regenerate-literal-btn') as HTMLButtonElement | null;
            if (regenerateLiteralBtn) {
                const translationId = translation.id;
                regenerateLiteralBtn.addEventListener('click', function() {
                    regenerateLiteralRetranslation(pill, translationId);
                });
            }

            setupToggleHandler(element, translation);

            container.insertBefore(element, container.firstChild);
        }

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
        const literalPane = element.querySelector('#literal-pane-' + translation.id) as HTMLElement | null;
        const explanationPane = element.querySelector('#explanation-pane-' + translation.id) as HTMLElement | null;
        const nuancesPane = element.querySelector('#nuances-pane-' + translation.id) as HTMLElement | null;

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
            if (targetEl) targetEl.style.display = 'none';
            if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
            if (charCountEl) {
                charCountEl.textContent = `(${translation.source.length}/—)`;
            }
        } else if (translation.status === 'error') {
            if (spinnerEl) spinnerEl.style.display = 'none';
            if (targetEl) targetEl.style.display = 'none';
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
                    targetEl.style.display = 'block';
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
    }
}

/**
 * Retries a failed translation
 * @param {'input' | 'output'} pill - Which pane
 * @param {string} translationId - ID of translation to retry
 * @returns {Promise<void>}
 */
export async function retryTranslation(pill: 'input' | 'output', translationId: string): Promise<void> {
    const translations = pill === 'input' ? inputTranslations : outputTranslations;
    const translation = translations.find(function(t) { return t.id === translationId; });

    if (!translation) {
        return;
    }

    const effectiveModel = getEffectiveModel(pill);
    if (!config || !effectiveModel || !config.openRouterApiKey) {
        ui.displayError("Cannot retry: no model selected or no API key");
        return;
    }

    translation.status = 'pending';
    translation.error = null;
    renderTranslations(pill);

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
                reasoningLevel
            );
            translation.translation = result;
            translation.status = 'complete';
            saveSessionTranslation(currentSessionId, translation);
        } catch (error) {
            translation.status = 'error';
            translation.error = error instanceof Error ? error.message : "Failed to get answer";
        }
        renderTranslations(pill);
        await refreshBalance();
        return;
    }

    let instructions: string;
    if (pill === 'input') {
        const inputLangId = getCurrentInputLanguage();
        const inputLang = LANGUAGES.find(function(l) { return l.id === inputLangId; });
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', inputLang?.name ?? 'the target language');
    } else {
        const promptDropdown = document.getElementById('prompt-dropdown') as HTMLSelectElement | null;
        const promptId = promptDropdown?.value;
        const prompts = settings.getPrompts();
        const selectedPrompt = prompts.find(function(p) { return p.id === promptId; });
        const promptContent = session?.promptOverride ?? selectedPrompt?.content ?? '';
        instructions = OUTPUT_INSTRUCTIONS.replace('[PROMPT]', promptContent);
        instructions = instructions.replace('[INTENT]', translation.intent ? `Intent: ${translation.intent}` : '');
        const inputLangId = getCurrentInputLanguage();
        const inputLang = LANGUAGES.find(function(l) { return l.id === inputLangId; });
        if (inputLang) {
            instructions = instructions.replace('[LANGUAGE]', inputLang.name);
        } else {
            instructions = instructions.replace('[LANGUAGE]', 'the input language');
        }
    }

    const userMessage = await buildUserMessage(pill, translation.source, instructions);

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
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
    }

    renderTranslations(pill);
    await refreshBalance();
}

/**
 * Retranslates an existing translation with edited source and/or intent
 * @param {'input' | 'output'} pill - Which pane
 * @param {string} translationId - ID of translation to retranslate
 * @param {string} newSource - New source text
 * @param {string} newIntent - New intent text
 * @returns {Promise<void>}
 */
export async function retranslateFromEdit(pill: 'input' | 'output', translationId: string, newSource: string, newIntent: string): Promise<void> {
    const translations = pill === 'input' ? inputTranslations : outputTranslations;
    const translation = translations.find(function(t) { return t.id === translationId; });

    if (!translation) {
        return;
    }

    const effectiveModel = getEffectiveModel(pill);
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
    renderTranslations(pill);

    let instructions: string;
    if (pill === 'input') {
        const inputLangId = getCurrentInputLanguage();
        const inputLang = LANGUAGES.find(function(l) { return l.id === inputLangId; });
        instructions = INPUT_INSTRUCTIONS.replace('[LANGUAGE]', inputLang?.name ?? 'the target language');
    } else {
        const promptDropdown = document.getElementById('prompt-dropdown') as HTMLSelectElement | null;
        const promptId = promptDropdown?.value;
        const prompts = settings.getPrompts();
        const selectedPrompt = prompts.find(function(p) { return p.id === promptId; });
        const promptContent = session?.promptOverride ?? selectedPrompt?.content ?? '';
        instructions = OUTPUT_INSTRUCTIONS.replace('[PROMPT]', promptContent);
        instructions = instructions.replace('[INTENT]', newIntent ? `Intent: ${newIntent}` : '');
        const inputLangId = getCurrentInputLanguage();
        const inputLang = LANGUAGES.find(function(l) { return l.id === inputLangId; });
        if (inputLang) {
            instructions = instructions.replace('[LANGUAGE]', inputLang.name);
        } else {
            instructions = instructions.replace('[LANGUAGE]', 'the input language');
        }
    }

    const userMessage = await buildUserMessage(pill, newSource, instructions);

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
        if (session?.literalModel) {
            try {
                const sourceLangId = getCurrentInputLanguage();
                const sourceLang = LANGUAGES.find(function(l) { return l.id === sourceLangId; });
                const sourceLangName = sourceLang?.name ?? sourceLangId;
                const literalSystemPrompt = LITERAL_RETRANSLATION_PROMPT.replace(/\[LANGUAGE\]/g, sourceLangName);
                const literalUserMessage = result.translation;
                translation.literalPending = true;
                renderTranslations(pill);
                const literalResult = await translateRaw(
                    config.openRouterApiKey,
                    literalUserMessage,
                    literalSystemPrompt,
                    session.literalModel,
                    'none'
                );
                translation.literalRetranslation = literalResult;
                translation.literalPending = false;
                saveSessionTranslation(currentSessionId, translation);
            } catch (literalError) {
                console.error('[retranslateFromEdit] Literal retranslation failed:', literalError);
                translation.literalPending = false;
            }
        }
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
    }

    renderTranslations(pill);
    await refreshBalance();
}

/**
 * Regenerates the literal retranslation for a completed translation
 * @param {'input' | 'output'} pill - Which pane
 * @param {string} translationId - ID of translation to regenerate literal for
 * @returns {Promise<void>}
 */
export async function regenerateLiteralRetranslation(pill: 'input' | 'output', translationId: string): Promise<void> {
    const translations = pill === 'input' ? inputTranslations : outputTranslations;
    const translation = translations.find(function(t) { return t.id === translationId; });

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

    if (!config || !config.openRouterApiKey) {
        console.error('[regenerateLiteral] No API key');
        return;
    }

    const sourceLangId = getCurrentInputLanguage();
    const sourceLang = LANGUAGES.find(function(l) { return l.id === sourceLangId; });
    const sourceLangName = sourceLang?.name ?? sourceLangId;
    const literalSystemPrompt = LITERAL_RETRANSLATION_PROMPT.replace(/\[LANGUAGE\]/g, sourceLangName);
    const literalUserMessage = translation.translation;
    console.log('[regenerateLiteral] Starting literal retranslation with model:', session.literalModel);
    console.log('[regenerateLiteral] Input text:', translation.translation.substring(0, 200));

    translation.literalPending = true;
    renderTranslations(pill);

    try {
        const literalResult = await translateRaw(
            config.openRouterApiKey,
            literalUserMessage,
            literalSystemPrompt,
            session.literalModel,
            'none'
        );
        console.log('[regenerateLiteral] Literal result:', literalResult.substring(0, 200));
        translation.literalRetranslation = literalResult;
        translation.literalPending = false;
        saveSessionTranslation(currentSessionId, translation);
        renderTranslations(pill);
    } catch (literalError) {
        console.error('[regenerateLiteral] Literal retranslation failed:', literalError);
        translation.literalPending = false;
        renderTranslations(pill);
    }
}