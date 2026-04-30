/**
 * Settings Module
 * Handles settings modal dialog, prompt management, and session management
 */

import * as storage from './storage';
import * as ui from './ui';
import * as translation from './translation';
import { DEFAULT_PROMPTS, generateUuid } from './default_prompts';
import { saveApiKey } from './main';
import { LANGUAGES } from './languages';
import type { Prompt } from './types/prompt';
import type { Config } from './types/config';
import type { VisionModel } from './types/api';

/**
 * Application configuration (injected from main.ts)
 */
let config: Config | null = null;

/**
 * In-memory prompts array - source of truth for prompts
 * @type {Prompt[]}
 */
let prompts: Prompt[] = [];

/**
 * Available models for the model dropdown
 * @type {VisionModel[]}
 */
let models: VisionModel[] = [];

/**
 * All fetched models (unfiltered) for the Models tab
 * @type {VisionModel[]}
 */
let allModels: VisionModel[] = [];

/**
 * Currently selected prompt ID in the settings modal
 * @type {string | null}
 */
let selectedPromptIdInModal: string | null = null;

/**
 * Currently selected session ID in the settings modal
 * @type {string | null}
 */
let selectedSessionIdInModal: string | null = null;

/**
 * Reference to the settings modal element
 * @type {HTMLDivElement | null}
 */
let settingsModalElement: HTMLDivElement | null = null;

/**
 * Bootstrap modal instance
 * @type {any}
 */
let settingsModalInstance: any = null;

/**
 * Captured DOM references for the settings modal
 */
interface SettingsReferences {
    minPriceInput: HTMLInputElement;
    maxPriceInput: HTMLInputElement;
    temperatureInput: HTMLInputElement;
    questionTemperatureInput: HTMLInputElement;
    apiKeyInput: HTMLInputElement;
    toggleApiKeyButton: HTMLButtonElement;
    promptListSelect: HTMLSelectElement;
    promptNameInput: HTMLInputElement;
    promptContentTextarea: HTMLTextAreaElement;
    addPromptButton: HTMLButtonElement;
    deletePromptButton: HTMLButtonElement;
    savePromptButton: HTMLButtonElement;
    saveSettingsButton: HTMLButtonElement;
    sessionListSelect: HTMLSelectElement;
    sessionNameInput: HTMLInputElement;
    sessionInterlocutorNameInput: HTMLInputElement;
    sessionModelSelect: HTMLSelectElement;
    sessionLiteralModelSelect: HTMLSelectElement;
    sessionInterpretationModelSelect: HTMLSelectElement;
    sessionInterpretationReasoningSelect: HTMLSelectElement;
    sessionBackgroundInput: HTMLTextAreaElement;
    sessionReasoningSelect: HTMLSelectElement;
    sessionPromptOverrideInput: HTMLTextAreaElement;
    sessionTheirLanguageSelect: HTMLSelectElement;
    sessionMyLanguageSelect: HTMLSelectElement;
    sessionWritePromptSelect: HTMLSelectElement;
    deleteSessionButton: HTMLButtonElement;
    saveSessionButton: HTMLButtonElement;
    modelsTabSearchInput: HTMLInputElement;
    modelsTabListContainer: HTMLDivElement;
    modelsTabClearButton: HTMLButtonElement;
    selectAllModelsBtn: HTMLButtonElement;
    deselectAllModelsBtn: HTMLButtonElement;
}

let refs: SettingsReferences | null = null;

/**
 * Sets the application config reference
 * @param {Config} appConfig - Application configuration object
 * @returns {void}
 */
export function setConfig(appConfig: Config): void {
    config = appConfig;
}

/**
 * Gets the prompts array for external use
 * @returns {Prompt[]}
 */
export function getPrompts(): Prompt[] {
    return prompts;
}

/**
 * Loads prompts from OPFS into memory
 * @returns {Promise<void>}
 */
export async function loadPromptsIntoMemory(): Promise<void> {
    prompts = await storage.listPrompts();
}

/**
 * Initializes default prompts if none exist
 * @returns {Promise<void>}
 */
export async function initializeDefaultPromptsIfNeeded(): Promise<void> {
    await storage.initializeDefaultPrompts(DEFAULT_PROMPTS);
    prompts = await storage.listPrompts();
}

/**
 * Sets up the settings button click handler
 * @param {HTMLButtonElement} button - The settings button element
 * @returns {void}
 */
export function setupSettingsButton(button: HTMLButtonElement): void {
    button.addEventListener('click', function() {
        openSettingsModal();
    });
}

/**
 * Opens the settings modal, creating it if necessary
 * @returns {void}
 */
function openSettingsModal(): void {
    if (!settingsModalElement) {
        const template = document.getElementById('settings-modal-template') as HTMLTemplateElement;
        if (!template) {
            console.error('Settings modal template not found');
            return;
        }
        const clone = template.content.cloneNode(true) as DocumentFragment;
        settingsModalElement = clone.firstElementChild as HTMLDivElement;
        document.body.appendChild(settingsModalElement);

        refs = {
            minPriceInput: settingsModalElement.querySelector('#settings-min-price') as HTMLInputElement,
            maxPriceInput: settingsModalElement.querySelector('#settings-max-price') as HTMLInputElement,
            temperatureInput: settingsModalElement.querySelector('#settings-temperature') as HTMLInputElement,
            questionTemperatureInput: settingsModalElement.querySelector('#settings-question-temperature') as HTMLInputElement,
            apiKeyInput: settingsModalElement.querySelector('#settings-api-key') as HTMLInputElement,
            toggleApiKeyButton: settingsModalElement.querySelector('#settings-toggle-key-visibility') as HTMLButtonElement,
            promptListSelect: settingsModalElement.querySelector('#settings-prompt-list') as HTMLSelectElement,
            promptNameInput: settingsModalElement.querySelector('#settings-prompt-name') as HTMLInputElement,
            promptContentTextarea: settingsModalElement.querySelector('#settings-prompt-content') as HTMLTextAreaElement,
            addPromptButton: settingsModalElement.querySelector('#settings-add-prompt-btn') as HTMLButtonElement,
            deletePromptButton: settingsModalElement.querySelector('#settings-delete-prompt-btn') as HTMLButtonElement,
            savePromptButton: settingsModalElement.querySelector('#settings-save-prompt-btn') as HTMLButtonElement,
            saveSettingsButton: settingsModalElement.querySelector('#settings-save-btn') as HTMLButtonElement,
            sessionListSelect: settingsModalElement.querySelector('#settings-session-list') as HTMLSelectElement,
            sessionNameInput: settingsModalElement.querySelector('#settings-session-name') as HTMLInputElement,
            sessionInterlocutorNameInput: settingsModalElement.querySelector('#settings-session-interlocutor-name') as HTMLInputElement,
            sessionModelSelect: settingsModalElement.querySelector('#settings-session-model') as HTMLSelectElement,
            sessionLiteralModelSelect: settingsModalElement.querySelector('#settings-session-literal-model') as HTMLSelectElement,
            sessionInterpretationModelSelect: settingsModalElement.querySelector('#settings-session-interpretation-model') as HTMLSelectElement,
            sessionInterpretationReasoningSelect: settingsModalElement.querySelector('#settings-session-interpretation-reasoning') as HTMLSelectElement,
            sessionBackgroundInput: settingsModalElement.querySelector('#settings-session-background') as HTMLTextAreaElement,
            sessionReasoningSelect: settingsModalElement.querySelector('#settings-session-reasoning') as HTMLSelectElement,
            sessionPromptOverrideInput: settingsModalElement.querySelector('#settings-session-prompt-override') as HTMLTextAreaElement,
            sessionTheirLanguageSelect: settingsModalElement.querySelector('#settings-session-their-language') as HTMLSelectElement,
            sessionMyLanguageSelect: settingsModalElement.querySelector('#settings-session-my-language') as HTMLSelectElement,
            sessionWritePromptSelect: settingsModalElement.querySelector('#settings-session-write-prompt') as HTMLSelectElement,
            deleteSessionButton: settingsModalElement.querySelector('#settings-delete-session-btn') as HTMLButtonElement,
            saveSessionButton: settingsModalElement.querySelector('#settings-save-session-btn') as HTMLButtonElement,
            modelsTabSearchInput: settingsModalElement.querySelector('#settings-models-search') as HTMLInputElement,
            modelsTabListContainer: settingsModalElement.querySelector('#settings-models-list') as HTMLDivElement,
            modelsTabClearButton: settingsModalElement.querySelector('#settings-models-search-clear') as HTMLButtonElement,
            selectAllModelsBtn: settingsModalElement.querySelector('#settings-select-all-models') as HTMLButtonElement,
            deselectAllModelsBtn: settingsModalElement.querySelector('#settings-deselect-all-models') as HTMLButtonElement
        };

        setupEventListeners();
        settingsModalInstance = new (window as any).bootstrap.Modal(settingsModalElement);
    }

    populateSettingsForm();
    settingsModalInstance.show();
}

/**
 * Sets up event listeners for the settings modal
 * @returns {void}
 */
function setupEventListeners(): void {
    if (!refs) return;

    refs.toggleApiKeyButton.addEventListener('click', function() {
        const isPassword = refs!.apiKeyInput.type === 'password';
        refs!.apiKeyInput.type = isPassword ? 'text' : 'password';
        refs!.toggleApiKeyButton.textContent = isPassword ? '🔒' : '👁';
    });

    refs.apiKeyInput.addEventListener('change', async function() {
        const key = refs!.apiKeyInput.value.trim();
        if (key) {
            await saveApiKey(key);
        }
    });

    refs.promptListSelect.addEventListener('change', function() {
        const selectedId = refs!.promptListSelect.value;
        selectedPromptIdInModal = selectedId || null;
        loadPromptIntoEditor(selectedId);
    });

    refs.addPromptButton.addEventListener('click', function() {
        clearPromptEditor();
        selectedPromptIdInModal = null;
    });

    refs.deletePromptButton.addEventListener('click', async function() {
        await deleteSelectedPrompt();
    });

    refs.savePromptButton.addEventListener('click', async function() {
        await saveCurrentPrompt();
    });

    refs.saveSettingsButton.addEventListener('click', async function() {
        await saveSettings();
    });

    refs.sessionListSelect.addEventListener('change', function() {
        const selectedId = refs!.sessionListSelect.value;
        selectedSessionIdInModal = selectedId || null;
        loadSessionIntoEditor(selectedId);
        updateDeleteSessionButton();
    });

    refs.deleteSessionButton.addEventListener('click', async function() {
        await deleteSelectedSession();
    });

    refs.saveSessionButton.addEventListener('click', async function() {
        await saveSession();
    });

    refs.modelsTabSearchInput.addEventListener('input', function() {
        updateModelsTabSearch(refs!.modelsTabSearchInput.value);
    });

    refs.modelsTabClearButton.addEventListener('click', function() {
        refs!.modelsTabSearchInput.value = '';
        updateModelsTabSearch('');
    });

    refs.selectAllModelsBtn.addEventListener('click', function() {
        if (config) {
            config.approvedModelIds = allModels.map(function(m) { return m.id + '::' + (m.providerName ?? ''); });
        }
        const checkboxes = refs!.modelsTabListContainer.querySelectorAll('.model-approval-checkbox');
        checkboxes.forEach(function(cb) { (cb as HTMLInputElement).checked = true; });
    });

    refs.deselectAllModelsBtn.addEventListener('click', function() {
        if (config) {
            config.approvedModelIds = [];
        }
        const checkboxes = refs!.modelsTabListContainer.querySelectorAll('.model-approval-checkbox');
        checkboxes.forEach(function(cb) { (cb as HTMLInputElement).checked = false; });
    });
}

/**
 * Populates the settings form with current config values
 * @returns {void}
 */
function populateSettingsForm(): void {
    if (!refs || !config) return;

    refs.minPriceInput.value = config.minPrice !== null ? String(config.minPrice) : '';
    refs.maxPriceInput.value = config.maxPrice !== null ? String(config.maxPrice) : '';
    refs.temperatureInput.value = String(config.temperature);
    refs.questionTemperatureInput.value = String(config.questionTemperature);
    refs.apiKeyInput.value = config.openRouterApiKey ?? '';

    renderPromptList();
    clearPromptEditor();

    renderSessionList();
    clearSessionEditor();
    populateModelDropdown();
    populateLanguageDropdowns();
    populateWritePromptDropdown();
    populateModelsTab();
}

/**
 * Renders the prompt list from in-memory prompts array
 * @returns {void}
 */
function renderPromptList(): void {
    if (!refs) return;

    refs.promptListSelect.innerHTML = '';

    for (const prompt of prompts) {
        const option = document.createElement('option');
        option.value = prompt.id;
        option.textContent = prompt.name;
        refs.promptListSelect.appendChild(option);
    }
}

/**
 * Loads a prompt into the editor fields
 * @param {string} promptId - Prompt ID to load
 * @returns {void}
 */
function loadPromptIntoEditor(promptId: string): void {
    if (!refs) return;

    const prompt = prompts.find(function(p) { return p.id === promptId; });
    if (prompt) {
        refs.promptNameInput.value = prompt.name;
        refs.promptContentTextarea.value = prompt.content;
    } else {
        clearPromptEditor();
    }
}

/**
 * Clears the prompt editor fields
 * @returns {void}
 */
function clearPromptEditor(): void {
    if (!refs) return;
    refs.promptNameInput.value = '';
    refs.promptContentTextarea.value = '';
}

/**
 * Saves the currently edited prompt
 * @returns {Promise<void>}
 */
async function saveCurrentPrompt(): Promise<void> {
    if (!refs || !config) return;

    const name = refs.promptNameInput.value.trim();
    const content = refs.promptContentTextarea.value.trim();

    if (!name) {
        ui.displayError('Prompt name is required');
        return;
    }

    if (!content) {
        ui.displayError('Prompt content is required');
        return;
    }

    const now = Date.now();
    const prompt: Prompt = {
        id: selectedPromptIdInModal ?? generateUuid(),
        name: name,
        content: content,
        createdAt: selectedPromptIdInModal ? (prompts.find(function(p) { return p.id === selectedPromptIdInModal; })?.createdAt ?? now) : now,
        updatedAt: now
    };

    await storage.savePrompt(prompt);

    prompts = await storage.listPrompts();

    renderPromptList();
    populateWritePromptDropdown();

    refs.promptListSelect.value = prompt.id;
    selectedPromptIdInModal = prompt.id;

    updatePromptDropdown();
}

/**
 * Deletes the selected prompt
 * @returns {Promise<void>}
 */
async function deleteSelectedPrompt(): Promise<void> {
    if (!refs || !selectedPromptIdInModal) {
        ui.displayError('No prompt selected to delete');
        return;
    }

    await storage.deletePrompt(selectedPromptIdInModal);

    prompts = await storage.listPrompts();

    if (config && config.selectedPromptId === selectedPromptIdInModal) {
        config.selectedPromptId = null;
        await storage.savePreference('selectedPrompt', '');
    }

    renderPromptList();
    populateWritePromptDropdown();
    clearPromptEditor();
    selectedPromptIdInModal = null;

    updatePromptDropdown();
}

/**
 * Sets the available models for the session model dropdown
 * @param {VisionModel[]} availableModels - Array of available models
 * @returns {void}
 */
export function setModels(availableModels: VisionModel[]): void {
    models = availableModels;
    populateModelDropdown();
}

/**
 * Sets all fetched models (unfiltered) for the Models tab
 * @param {VisionModel[]} fetchedModels - Array of all fetched models
 * @returns {void}
 */
export function setAllModels(fetchedModels: VisionModel[]): void {
    allModels = fetchedModels;
}

/**
 * Filters models by approved list from config
 * @param {VisionModel[]} availableModels - Array of models to filter
 * @returns {VisionModel[]} Filtered models (approved only, or all if no approval list)
 */
export function filterModelsByApproval(availableModels: VisionModel[]): VisionModel[] {
    if (!config || config.approvedModelIds === null) {
        return availableModels;
    }
    const approvedSet = new Set(config.approvedModelIds);
    return availableModels.filter(function(model) {
        const key = model.id + '::' + (model.providerName ?? '');
        return approvedSet.has(key);
    });
}

/**
 * Populates the Models tab checkbox list
 * @returns {void}
 */
export function populateModelsTab(): void {
    if (!refs || allModels.length === 0) return;

    const container = refs.modelsTabListContainer;
    container.innerHTML = '';

    const approvedSet = new Set<string>(config?.approvedModelIds ?? []);

    const sorted = [...allModels].sort(function(a, b) {
        const nameA = a.name.toLowerCase();
        const nameB = b.name.toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return 0;
    });

    for (const model of sorted) {
        const div = document.createElement('div');
        div.className = 'form-check';

        const compositeKey = model.id + '::' + (model.providerName ?? '');
        const input = document.createElement('input');
        input.className = 'form-check-input model-approval-checkbox';
        input.type = 'checkbox';
        input.value = compositeKey;
        input.id = 'model-approval-' + compositeKey.replace(/[^a-zA-Z0-9]/g, '_');

        const promptCost = model.pricing ? (parseFloat(model.pricing.prompt) * 1_000_000).toFixed(2) : '?';
        const completionCost = model.pricing ? (parseFloat(model.pricing.completion) * 1_000_000).toFixed(2) : '?';
        const providerPart = model.providerName ? ' by ' + model.providerName : '';
        const label = document.createElement('label');
        label.className = 'form-check-label small';
        label.htmlFor = input.id;
        label.textContent = `${model.name}${providerPart} ($${promptCost}/$${completionCost})`;

        const isApproved = config?.approvedModelIds === null || approvedSet.has(compositeKey);
        input.checked = isApproved;

        input.addEventListener('change', function() {
            if (input.checked) {
                if (config && config.approvedModelIds !== null) {
                    if (!config.approvedModelIds.includes(compositeKey)) {
                        config.approvedModelIds.push(compositeKey);
                    }
                }
            } else {
                if (config && config.approvedModelIds !== null) {
                    config.approvedModelIds = config.approvedModelIds.filter(function(id) { return id !== compositeKey; });
                }
            }
        });

        div.appendChild(input);
        div.appendChild(label);
        container.appendChild(div);
    }
}

/**
 * Updates the Models tab search filter
 * @param {string} query - Search query string
 * @returns {void}
 */
export function updateModelsTabSearch(query: string): void {
    if (!refs) return;
    const lowerQuery = query.toLowerCase();
    const checkboxes = refs.modelsTabListContainer.querySelectorAll('.form-check');
    for (const div of checkboxes) {
        const label = div.querySelector('label');
        const text = label?.textContent?.toLowerCase() ?? '';
        (div as HTMLElement).style.display = text.includes(lowerQuery) ? '' : 'none';
    }
}

/**
 * Saves approved models to storage and refreshes dropdowns
 * @returns {Promise<void>}
 */
export async function saveApprovedModels(): Promise<void> {
    if (!config) return;

    if (config.approvedModelIds !== null) {
        await storage.savePreference('approvedModels', JSON.stringify(config.approvedModelIds));
    } else {
        await storage.deletePreference('approvedModels');
    }

    const approvedModels = filterModelsByApproval(models);
    setModels(approvedModels);
    translation.setModelNameMap(approvedModels);
    translation.setModelOverrideOptions(approvedModels);

    if (config.selectedModel && !approvedModels.some(function(m) { return m.id === config!.selectedModel; })) {
        if (approvedModels.length > 0) {
            config.selectedModel = approvedModels[0].id;
            await storage.savePreference('selectedModel', config.selectedModel);
            translation.updateButtonStates();
        }
    }
}

/**
 * Populates the session model dropdown in conversation settings
 * @returns {void}
 */
function populateModelDropdown(): void {
    if (!refs) return;

    refs.sessionModelSelect.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select model...';
    refs.sessionModelSelect.appendChild(placeholder);

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
        refs.sessionModelSelect.appendChild(option);
    }

    refs.sessionLiteralModelSelect.innerHTML = '';

    const disabledPlaceholder = document.createElement('option');
    disabledPlaceholder.value = '';
    disabledPlaceholder.textContent = 'Disabled';
    refs.sessionLiteralModelSelect.appendChild(disabledPlaceholder);

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
        refs.sessionLiteralModelSelect.appendChild(option);
    }

    refs.sessionInterpretationModelSelect.innerHTML = '';

    const interpDisabledPlaceholder = document.createElement('option');
    interpDisabledPlaceholder.value = '';
    interpDisabledPlaceholder.textContent = 'Disabled';
    refs.sessionInterpretationModelSelect.appendChild(interpDisabledPlaceholder);

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
        refs.sessionInterpretationModelSelect.appendChild(option);
    }
}

/**
 * Populates the read and write language dropdowns
 * @returns {void}
 */
function populateLanguageDropdowns(): void {
    if (!refs) return;

    refs.sessionTheirLanguageSelect.innerHTML = '';
    refs.sessionMyLanguageSelect.innerHTML = '';

    for (const lang of LANGUAGES) {
        const theirOption = document.createElement('option');
        theirOption.value = lang.id;
        theirOption.textContent = lang.name;
        refs.sessionTheirLanguageSelect.appendChild(theirOption);

        const myOption = document.createElement('option');
        myOption.value = lang.id;
        myOption.textContent = lang.name;
        refs.sessionMyLanguageSelect.appendChild(myOption);
    }
}

/**
 * Populates the write prompt dropdown
 * @returns {void}
 */
function populateWritePromptDropdown(): void {
    if (!refs) return;

    refs.sessionWritePromptSelect.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select prompt...';
    refs.sessionWritePromptSelect.appendChild(placeholder);

    for (const prompt of prompts) {
        const option = document.createElement('option');
        option.value = prompt.id;
        option.textContent = prompt.name;
        refs.sessionWritePromptSelect.appendChild(option);
    }
}

/**
 * Saves the settings (price filters)
 * @returns {Promise<void>}
 */
async function saveSettings(): Promise<void> {
    if (!refs || !config) return;

    const conversationsTab = settingsModalElement?.querySelector('#conversations-content');
    const isConversationsTabActive = conversationsTab?.classList.contains('active');
    if (isConversationsTabActive && selectedSessionIdInModal) {
        await saveSession();
    }

    const minPriceStr = refs.minPriceInput.value.trim();
    const maxPriceStr = refs.maxPriceInput.value.trim();

    config.minPrice = minPriceStr ? parseFloat(minPriceStr) : null;
    config.maxPrice = maxPriceStr ? parseFloat(maxPriceStr) : null;

    if (config.minPrice !== null) {
        await storage.savePreference('minPrice', String(config.minPrice));
    } else {
        await storage.deletePreference('minPrice');
    }

    if (config.maxPrice !== null) {
        await storage.savePreference('maxPrice', String(config.maxPrice));
    } else {
        await storage.deletePreference('maxPrice');
    }

    const temperatureStr = refs.temperatureInput.value.trim();
    const temperature = parseFloat(temperatureStr);
    if (!isNaN(temperature) && temperature >= 0 && temperature <= 2) {
        config.temperature = temperature;
        await storage.savePreference('temperature', String(temperature));
    }

    const questionTemperatureStr = refs.questionTemperatureInput.value.trim();
    const questionTemperature = parseFloat(questionTemperatureStr);
    if (!isNaN(questionTemperature) && questionTemperature >= 0 && questionTemperature <= 2) {
        config.questionTemperature = questionTemperature;
        await storage.savePreference('questionTemperature', String(questionTemperature));
    }

    await saveApprovedModels();

    settingsModalInstance.hide();
}

/**
 * Filters models by price range
 * @param {VisionModel[]} models - Array of models to filter
 * @returns {VisionModel[]} Filtered models
 */
export function filterModelsByPrice(models: VisionModel[]): VisionModel[] {
    if (!config || (config.minPrice === null && config.maxPrice === null)) {
        return models;
    }

    return models.filter(function(model: VisionModel): boolean {
        if (!model.pricing) return true;

        const promptCost = parseFloat(model.pricing.prompt) * 1_000_000;
        const completionCost = parseFloat(model.pricing.completion) * 1_000_000;
        const maxCost = Math.max(promptCost, completionCost);

        if (config!.minPrice !== null && maxCost < config!.minPrice) return false;
        if (config!.maxPrice !== null && maxCost > config!.maxPrice) return false;

        return true;
    });
}

/**
 * Populates the prompt dropdown in the main UI
 * @returns {void}
 */
export function updatePromptDropdown(): void {
    const dropdown = document.getElementById('prompt-dropdown') as HTMLSelectElement | null;
    if (!dropdown) return;

    dropdown.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select prompt...';
    dropdown.appendChild(placeholder);

    for (const prompt of prompts) {
        const option = document.createElement('option');
        option.value = prompt.id;
        option.textContent = prompt.name;
        dropdown.appendChild(option);
    }

    if (config && config.selectedPromptId) {
        dropdown.value = config.selectedPromptId;
    }
}

/**
 * Sets up the prompt dropdown change handler in the main UI
 * @returns {void}
 */
export function setupPromptDropdown(): void {
    const dropdown = document.getElementById('prompt-dropdown') as HTMLSelectElement | null;
    if (!dropdown || !config) return;

    dropdown.addEventListener('change', async function() {
        config!.selectedPromptId = dropdown.value || null;
        if (config!.selectedPromptId) {
            await storage.savePreference('selectedPrompt', config!.selectedPromptId);
        } else {
            await storage.deletePreference('selectedPrompt');
        }
    });
}

/**
 * Gets the selected prompt content
 * @returns {string | null} Prompt content or null if none selected
 */
export function getSelectedPromptContent(): string | null {
    if (!config || !config.selectedPromptId) return null;
    const prompt = prompts.find(function(p) { return p.id === config!.selectedPromptId; });
    return prompt?.content ?? null;
}

/**
 * Renders the session list from storage
 * @returns {Promise<void>}
 */
async function renderSessionList(): Promise<void> {
    if (!refs) return;

    const sessions = await storage.listSessions();
    refs.sessionListSelect.innerHTML = '';

    for (const session of sessions) {
        const option = document.createElement('option');
        option.value = session.id;
        option.textContent = session.name;
        refs.sessionListSelect.appendChild(option);
    }

    if (selectedSessionIdInModal && sessions.some(function(s) { return s.id === selectedSessionIdInModal; })) {
        refs.sessionListSelect.value = selectedSessionIdInModal;
        loadSessionIntoEditor(selectedSessionIdInModal);
    } else if (sessions.length > 0) {
        refs.sessionListSelect.value = sessions[0].id;
        selectedSessionIdInModal = sessions[0].id;
        loadSessionIntoEditor(sessions[0].id);
    }

    updateDeleteSessionButton();
}

/**
 * Loads a session into the editor fields
 * @param {string} sessionId - Session ID to load
 * @returns {void}
 */
function loadSessionIntoEditor(sessionId: string): void {
    if (!refs) return;

    storage.loadSession(sessionId).then(function(session) {
        if (session && refs) {
            refs.sessionNameInput.value = session.name;
            refs.sessionInterlocutorNameInput.value = session.interlocutorName ?? '';
            refs.sessionModelSelect.value = session.model ?? '';
            refs.sessionLiteralModelSelect.value = session.literalModel ?? '';
            refs.sessionInterpretationModelSelect.value = session.interpretationModel ?? '';
            refs.sessionInterpretationReasoningSelect.value = session.interpretationReasoning ?? 'none';
            refs.sessionBackgroundInput.value = session.background ?? '';
            refs.sessionReasoningSelect.value = session.reasoning ?? 'none';
            refs.sessionPromptOverrideInput.value = session.promptOverride ?? '';
            refs.sessionTheirLanguageSelect.value = session.theirLanguage ?? 'english';
            refs.sessionMyLanguageSelect.value = session.myLanguage ?? 'english';
            refs.sessionWritePromptSelect.value = session.writePromptId ?? '';
        } else if (refs) {
            refs.sessionNameInput.value = '';
            refs.sessionInterlocutorNameInput.value = '';
            refs.sessionModelSelect.value = '';
            refs.sessionLiteralModelSelect.value = '';
            refs.sessionInterpretationModelSelect.value = '';
            refs.sessionInterpretationReasoningSelect.value = 'none';
            refs.sessionBackgroundInput.value = '';
            refs.sessionReasoningSelect.value = 'none';
            refs.sessionPromptOverrideInput.value = '';
            refs.sessionTheirLanguageSelect.value = 'english';
            refs.sessionMyLanguageSelect.value = 'english';
            refs.sessionWritePromptSelect.value = '';
        }
    });
}

/**
 * Clears the session editor fields
 * @returns {void}
 */
function clearSessionEditor(): void {
    if (!refs) return;
    refs.sessionNameInput.value = '';
    refs.sessionInterlocutorNameInput.value = '';
    refs.sessionBackgroundInput.value = '';
    refs.sessionReasoningSelect.value = 'none';
    refs.sessionPromptOverrideInput.value = '';
    refs.sessionTheirLanguageSelect.value = 'english';
    refs.sessionMyLanguageSelect.value = 'english';
    refs.sessionWritePromptSelect.value = '';
}

/**
 * Updates the delete session button state
 * @returns {void}
 */
function updateDeleteSessionButton(): void {
    if (!refs) return;

    const isDefault = selectedSessionIdInModal === 'default';
    refs.deleteSessionButton.disabled = !selectedSessionIdInModal || isDefault;

    if (isDefault) {
        refs.deleteSessionButton.title = 'Cannot delete default session';
    } else {
        refs.deleteSessionButton.title = 'Delete this session';
    }
}

/**
 * Saves the current session (name, model, background, reasoning)
 * @returns {Promise<void>}
 */
async function saveSession(): Promise<void> {
    if (!refs || !selectedSessionIdInModal) {
        ui.displayError('No session selected');
        return;
    }

    const newName = refs.sessionNameInput.value.trim();
    if (!newName) {
        ui.displayError('Session name is required');
        return;
    }

    const session = await storage.loadSession(selectedSessionIdInModal);
    if (!session) {
        ui.displayError('Session not found');
        return;
    }

    session.name = newName;
    session.model = refs.sessionModelSelect.value || null;
    session.literalModel = refs.sessionLiteralModelSelect.value || null;
    session.interpretationModel = refs.sessionInterpretationModelSelect.value || null;
    session.interpretationReasoning = refs.sessionInterpretationReasoningSelect.value as 'none' | 'minimal' | 'low' | 'medium' | 'high';
    session.background = refs.sessionBackgroundInput.value;
    session.reasoning = refs.sessionReasoningSelect.value as 'none' | 'minimal' | 'low' | 'medium' | 'high';
    session.promptOverride = refs.sessionPromptOverrideInput.value || null;
    session.theirLanguage = refs.sessionTheirLanguageSelect.value;
    session.myLanguage = refs.sessionMyLanguageSelect.value;
    session.interlocutorName = refs.sessionInterlocutorNameInput.value.trim() || undefined;
    session.writePromptId = refs.sessionWritePromptSelect.value || null;
    await storage.saveSession(session);

    if (config && session.model) {
        config.selectedModel = session.model;
    }

    await renderSessionList();

    await refreshSessionSelector();
    translation.updateButtonStates();
}

/**
 * Deletes the selected session
 * @returns {Promise<void>}
 */
async function deleteSelectedSession(): Promise<void> {
    if (!refs || !selectedSessionIdInModal) {
        ui.displayError('No session selected');
        return;
    }

    if (selectedSessionIdInModal === 'default') {
        ui.displayError('Cannot delete the default session');
        return;
    }

    const success = await storage.deleteSession(selectedSessionIdInModal);
    if (!success) {
        ui.displayError('Failed to delete session');
        return;
    }

    const sessions = await storage.listSessions();
    if (sessions.length > 0) {
        selectedSessionIdInModal = sessions[0].id;
    } else {
        selectedSessionIdInModal = 'default';
    }

    await renderSessionList();
    await refreshSessionSelector();
}

/**
 * Refreshes the main UI session selector
 * @returns {Promise<void>}
 */
async function refreshSessionSelector(): Promise<void> {
    const selector = document.getElementById('session-selector') as HTMLSelectElement | null;
    if (!selector) return;

    const sessions = await storage.listSessions();
    selector.innerHTML = '';

    for (const session of sessions) {
        const option = document.createElement('option');
        option.value = session.id;
        option.textContent = session.name;
        selector.appendChild(option);
    }

    const { getCurrentSessionId } = await import('./translation');
    const currentId = getCurrentSessionId();
    selector.value = currentId;
}