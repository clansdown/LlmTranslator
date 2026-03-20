/**
 * Translation Module
 * Handles translation functionality for input and output panes
 */

import { translateText } from './openrouter';
import { savePreference } from './storage';
import * as ui from './ui';
import { LANGUAGES } from './languages';
import { INPUT_PROMPT_TEMPLATE, OUTPUT_PROMPT_TEMPLATE } from './prompts';
import type { Translation } from './types/translation';
import type { Config } from './types/config';

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
            await savePreference('inputLanguage', langId);
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

    const translations = pill === 'input' ? inputTranslations : outputTranslations;

    let promptName: string;
    let promptContent: string;

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
        promptContent = INPUT_PROMPT_TEMPLATE.replace('[LANGUAGE]', language.name);
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

        const { getPrompts } = await import('./settings');
        const prompts = getPrompts();
        const selectedPrompt = prompts.find(function(p) { return p.id === promptId; });

        if (!selectedPrompt) {
            ui.displayError("Please select a prompt");
            return;
        }

        promptName = selectedPrompt.name;
        promptContent = OUTPUT_PROMPT_TEMPLATE.replace('[PROMPT]', selectedPrompt.content);
    }

    const translation: Translation = {
        id: generateUuid(),
        source: sourceText,
        translation: '',
        model: config.selectedModel,
        modelName: getModelName(config.selectedModel),
        prompt: promptName,
        promptContent: promptContent,
        timestamp: Date.now(),
        status: 'pending',
        error: null
    };

    translations.push(translation);
    renderTranslations(pill);

    try {
        const result = await translateText(
            config.openRouterApiKey,
            sourceText,
            promptContent,
            config.selectedModel
        );

        translation.translation = result;
        translation.status = 'complete';
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

    for (let i = 0; i < translations.length; i++) {
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

            container.insertBefore(element, container.firstChild);
        }

        const sourceEl = element.querySelector('.translation-source') as HTMLElement | null;
        const targetEl = element.querySelector('.translation-target') as HTMLElement | null;
        const spinnerEl = element.querySelector('.translation-spinner') as HTMLElement | null;
        const errorEl = element.querySelector('.translation-error') as HTMLElement | null;
        const promptEl = element.querySelector('.translation-prompt') as HTMLElement | null;
        const modelNameEl = element.querySelector('.translation-model-name') as HTMLElement | null;

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
        } else if (translation.status === 'error') {
            if (spinnerEl) spinnerEl.style.display = 'none';
            if (targetEl) targetEl.style.display = 'none';
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
                targetEl.textContent = translation.translation;
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

    try {
        const result = await translateText(
            config.openRouterApiKey,
            translation.source,
            translation.promptContent,
            config.selectedModel
        );

        translation.translation = result;
        translation.status = 'complete';
    } catch (error) {
        translation.status = 'error';
        translation.error = error instanceof Error ? error.message : "Translation failed";
    }

    renderTranslations(pill);
    await refreshBalance();
}
