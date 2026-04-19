/**
 * Translation Module
 * Handles translation functionality for input and output panes
 */

import { translateStructured, translateRaw } from './openrouter';
import { getPreference, savePreference, listSessions, saveSession, loadSession, deleteSession as storageDeleteSession, getOrCreateDefaultSession, saveSessionTranslation, listSessionTranslations } from './storage';
import { DEBUG_TRANSLATIONS, DEBUG_SESSIONS } from './debug';
import * as ui from './ui';
import { LANGUAGES } from './languages';
import { SYSTEM_PROMPT, INPUT_INSTRUCTIONS, OUTPUT_INSTRUCTIONS, LITERAL_RETRANSLATION_PROMPT } from './prompts';
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
        } else {
            history += `<ME>${t.source}</ME>\n`;
            history += `<ME>${t.translation}</ME>\n`;
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
            if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey)) {
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

    const hasModel = config !== null && config.selectedModel !== null;

    if (inputBtn) {
        inputBtn.disabled = !hasModel;
    }

    if (outputBtn) {
        outputBtn.disabled = !hasModel;
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
    if (!config || !config.selectedModel) {
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
        instructions = OUTPUT_INSTRUCTIONS.replace('[PROMPT]', selectedPrompt.content);
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

    const translation: Translation = {
        id: generateUuid(),
        pill: pill,
        source: sourceText,
        translation: '',
        explanation: '',
        nuances: '',
        reasoning: '',
        reasoningDetails: '',
        literalRetranslation: '',
        model: config.selectedModel,
        modelName: getModelName(config.selectedModel),
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
            config.selectedModel,
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
    const toggleBtns = element.querySelectorAll('.toggle-section-btn');
    toggleBtns.forEach(function(btn) {
        const targetId = btn.getAttribute('data-target');
        const targetEl = element.querySelector('.' + targetId) as HTMLElement | null;
        if (targetEl) {
            btn.addEventListener('click', function() {
                const isHidden = targetEl.style.display === 'none' || targetEl.style.display === '';
                targetEl.style.display = isHidden ? 'block' : 'none';
                btn.textContent = isHidden ? '▲' : '▼';
            });
        }
    });
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
            const template = document.getElementById('translation-item-template') as HTMLTemplateElement;
            if (!template) {
                continue;
            }

            const clone = template.content.cloneNode(true) as DocumentFragment;
            element = clone.firstElementChild as HTMLElement;
            element.id = elementId;

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
        const explanationEl = element.querySelector('.translation-explanation') as HTMLElement | null;
        const literalContentEl = element.querySelector('.translation-literal-content') as HTMLElement | null;
        const literalEl = element.querySelector('.translation-literal') as HTMLElement | null;
        const nuancesEl = element.querySelector('.translation-nuances') as HTMLElement | null;
        const spinnerEl = element.querySelector('.translation-spinner') as HTMLElement | null;
        const errorEl = element.querySelector('.translation-error') as HTMLElement | null;
        const promptEl = element.querySelector('.translation-prompt') as HTMLElement | null;
        const modelNameEl = element.querySelector('.translation-model-name') as HTMLElement | null;
        const charCountEl = element.querySelector('.translation-char-count') as HTMLElement | null;
        const regenerateLiteralBtn = element.querySelector('.regenerate-literal-btn') as HTMLButtonElement | null;

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
            if (explanationEl) explanationEl.style.display = 'none';
            if (literalEl) literalEl.style.display = 'none';
            if (literalContentEl) literalContentEl.style.display = 'none';
            if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
            if (nuancesEl) nuancesEl.style.display = 'none';
            if (charCountEl) {
                charCountEl.textContent = `(${translation.source.length}/—)`;
            }
        } else if (translation.status === 'error') {
            if (spinnerEl) spinnerEl.style.display = 'none';
            if (targetEl) targetEl.style.display = 'none';
            if (explanationEl) explanationEl.style.display = 'none';
            if (literalEl) literalEl.style.display = 'none';
            if (literalContentEl) literalContentEl.style.display = 'none';
            if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
            if (nuancesEl) nuancesEl.style.display = 'none';
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
                targetEl.style.display = 'block';
                targetEl.innerHTML = renderMarkdown(translation.translation);
            }
            if (charCountEl) {
                charCountEl.textContent = `(${translation.source.length}/${translation.translation.length})`;
            }

            if (explanationEl) {
                if (translation.explanation) {
                    explanationEl.style.display = 'block';
                    explanationEl.innerHTML = renderMarkdown(translation.explanation);
                    const toggleBtn = element.querySelector('.toggle-explanation-btn');
                    if (toggleBtn) toggleBtn.textContent = '▼';
                } else {
                    explanationEl.style.display = 'none';
                    const toggleBtn = element.querySelector('.toggle-explanation-btn');
                    if (toggleBtn) toggleBtn.textContent = '▼';
                }
            }
            if (literalEl) {
                if (translation.literalPending) {
                    literalEl.style.display = 'block';
                    literalEl.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div><span style="margin-left: 0.5rem;">Retranslating...</span>';
                    const toggleBtn = element.querySelector('.toggle-literal-btn');
                    if (toggleBtn) toggleBtn.textContent = '▼';
                    if (literalContentEl) literalContentEl.style.display = 'block';
                    if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = 'none';
                } else if (translation.literalRetranslation) {
                    literalEl.style.display = 'block';
                    literalEl.innerHTML = renderMarkdown(translation.literalRetranslation);
                    const toggleBtn = element.querySelector('.toggle-literal-btn');
                    if (toggleBtn) toggleBtn.textContent = '▼';
                    if (literalContentEl) literalContentEl.style.display = 'block';
                    if (regenerateLiteralBtn) regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
                } else {
                    literalEl.style.display = 'none';
                    const toggleBtn = element.querySelector('.toggle-literal-btn');
                    if (toggleBtn) toggleBtn.textContent = '▼';
                    if (literalContentEl) {
                        literalContentEl.style.display = currentLiteralModel ? 'block' : 'none';
                    }
                    if (regenerateLiteralBtn) {
                        regenerateLiteralBtn.style.display = currentLiteralModel ? 'inline-block' : 'none';
                    }
                }
            }
            if (nuancesEl) {
                if (translation.nuances) {
                    nuancesEl.style.display = 'block';
                    nuancesEl.innerHTML = renderMarkdown(translation.nuances);
                    const toggleBtn = element.querySelector('.toggle-nuances-btn');
                    if (toggleBtn) toggleBtn.textContent = '▼';
                } else {
                    nuancesEl.style.display = 'none';
                    const toggleBtn = element.querySelector('.toggle-nuances-btn');
                    if (toggleBtn) toggleBtn.textContent = '▼';
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

    if (!config || !config.selectedModel || !config.openRouterApiKey) {
        ui.displayError("Cannot retry: no model selected or no API key");
        return;
    }

    translation.status = 'pending';
    translation.error = null;
    renderTranslations(pill);

    const instructions = translation.promptContent;
    const userMessage = await buildUserMessage(pill, translation.source, instructions);
    const session = await loadSession(currentSessionId);
    const reasoningLevel = session?.reasoning ?? 'none';

    try {
        const result = await translateStructured(
            config.openRouterApiKey,
            userMessage,
            SYSTEM_PROMPT,
            config.selectedModel,
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