/**
 * Settings Module
 * Handles settings modal dialog and prompt management
 */

import * as storage from './storage';
import * as ui from './ui';
import { DEFAULT_PROMPTS, generateUuid } from './default_prompts';
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
    promptListSelect: HTMLSelectElement;
    promptNameInput: HTMLInputElement;
    promptContentTextarea: HTMLTextAreaElement;
    addPromptButton: HTMLButtonElement;
    deletePromptButton: HTMLButtonElement;
    savePromptButton: HTMLButtonElement;
    saveSettingsButton: HTMLButtonElement;
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
            promptListSelect: settingsModalElement.querySelector('#settings-prompt-list') as HTMLSelectElement,
            promptNameInput: settingsModalElement.querySelector('#settings-prompt-name') as HTMLInputElement,
            promptContentTextarea: settingsModalElement.querySelector('#settings-prompt-content') as HTMLTextAreaElement,
            addPromptButton: settingsModalElement.querySelector('#settings-add-prompt-btn') as HTMLButtonElement,
            deletePromptButton: settingsModalElement.querySelector('#settings-delete-prompt-btn') as HTMLButtonElement,
            savePromptButton: settingsModalElement.querySelector('#settings-save-prompt-btn') as HTMLButtonElement,
            saveSettingsButton: settingsModalElement.querySelector('#settings-save-btn') as HTMLButtonElement
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
}

/**
 * Populates the settings form with current config values
 * @returns {void}
 */
function populateSettingsForm(): void {
    if (!refs || !config) return;

    refs.minPriceInput.value = config.minPrice !== null ? String(config.minPrice) : '';
    refs.maxPriceInput.value = config.maxPrice !== null ? String(config.maxPrice) : '';

    renderPromptList();
    clearPromptEditor();
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
