/**
 * Settings Module
 * Handles settings modal dialog, prompt management, and session management
 */

import * as storage from './storage';
import * as ui from './ui';
import { DEFAULT_PROMPTS, generateUuid } from './default_prompts';
import { saveApiKey } from './main';
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
    sessionBackgroundInput: HTMLTextAreaElement;
    sessionReasoningSelect: HTMLSelectElement;
    deleteSessionButton: HTMLButtonElement;
    saveSessionButton: HTMLButtonElement;
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
            sessionBackgroundInput: settingsModalElement.querySelector('#settings-session-background') as HTMLTextAreaElement,
            sessionReasoningSelect: settingsModalElement.querySelector('#settings-session-reasoning') as HTMLSelectElement,
            deleteSessionButton: settingsModalElement.querySelector('#settings-delete-session-btn') as HTMLButtonElement,
            saveSessionButton: settingsModalElement.querySelector('#settings-save-session-btn') as HTMLButtonElement
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
}

/**
 * Populates the settings form with current config values
 * @returns {void}
 */
function populateSettingsForm(): void {
    if (!refs || !config) return;

    refs.minPriceInput.value = config.minPrice !== null ? String(config.minPrice) : '';
    refs.maxPriceInput.value = config.maxPrice !== null ? String(config.maxPrice) : '';
    refs.apiKeyInput.value = config.openRouterApiKey ?? '';

    renderPromptList();
    clearPromptEditor();

    renderSessionList();
    clearSessionEditor();
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
    clearPromptEditor();
    selectedPromptIdInModal = null;

    updatePromptDropdown();
}

/**
 * Saves the settings (price filters)
 * @returns {Promise<void>}
 */
async function saveSettings(): Promise<void> {
    if (!refs || !config) return;

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
            refs.sessionBackgroundInput.value = session.background ?? '';
            refs.sessionReasoningSelect.value = session.reasoning ?? 'none';
        } else if (refs) {
            refs.sessionNameInput.value = '';
            refs.sessionBackgroundInput.value = '';
            refs.sessionReasoningSelect.value = 'none';
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
    refs.sessionBackgroundInput.value = '';
    refs.sessionReasoningSelect.value = 'none';
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
 * Saves the current session (name and background)
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
    session.background = refs.sessionBackgroundInput.value;
    session.reasoning = refs.sessionReasoningSelect.value as 'none' | 'minimal' | 'low' | 'medium' | 'high';
    await storage.saveSession(session);

    await renderSessionList();

    await refreshSessionSelector();
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