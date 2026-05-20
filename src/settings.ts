/**
 * Settings Module
 * Handles settings modal dialog and session management
 */

import * as storage from './storage';
import * as ui from './ui';
import * as translation from './translation';
import { saveApiKey } from './main';
import { LANGUAGES } from './languages';
import { getDefaultTags } from './defaultTranslationTags';
import * as cloudSync from './cloudSync';
import { showBackgroundUpdateModal } from './backgroundUpdate';
import { STATE } from './state';
import type { Config } from './types/config';
import type { VisionModel } from './types/api';
import type { TranslationTag } from './types/translationTag';
import type { ReasoningLevel } from './types/session';

/**
 * Application configuration (injected from main.ts)
 */
let config: Config | null = null;

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
    maxTokensInput: HTMLInputElement;
    apiKeyInput: HTMLInputElement;
    toggleApiKeyButton: HTMLButtonElement;
    saveSettingsButton: HTMLButtonElement;
    sessionListSelect: HTMLSelectElement;
    sessionNameInput: HTMLInputElement;
    sessionInterlocutorNameInput: HTMLInputElement;
    sessionModelSelect: HTMLSelectElement;
    sessionLiteralModelSelect: HTMLSelectElement;
    sessionInterpretationModelSelect: HTMLSelectElement;
    sessionInterpretationReasoningSelect: HTMLSelectElement;
    sessionQuickQuestionModelSelect: HTMLSelectElement;
    sessionQuickQuestionReasoningSelect: HTMLSelectElement;
    sessionBackgroundInput: HTMLTextAreaElement;
    sessionReasoningSelect: HTMLSelectElement;
    sessionTranslationInstructionsInput: HTMLTextAreaElement;
    sessionTheirLanguageSelect: HTMLSelectElement;
    sessionMyLanguageSelect: HTMLSelectElement;
    deleteSessionButton: HTMLButtonElement;
    newSessionButton: HTMLButtonElement;
    saveSessionButton: HTMLButtonElement;
    modelsTabSearchInput: HTMLInputElement;
    modelsTabListContainer: HTMLDivElement;
    modelsTabClearButton: HTMLButtonElement;
    selectAllModelsBtn: HTMLButtonElement;
    deselectAllModelsBtn: HTMLButtonElement;
    defaultMyLanguageSelect: HTMLSelectElement;
    defaultModelSelect: HTMLSelectElement;
    defaultReasoningSelect: HTMLSelectElement;
    defaultLiteralModelSelect: HTMLSelectElement;
    defaultInterpretationModelSelect: HTMLSelectElement;
    defaultInterpretationReasoningSelect: HTMLSelectElement;
    defaultQuickQuestionModelSelect: HTMLSelectElement;
    defaultQuickQuestionReasoningSelect: HTMLSelectElement;
    sessionQuestionModelSelect: HTMLSelectElement;
    sessionQuestionReasoningSelect: HTMLSelectElement;
    sessionWordDefModelSelect: HTMLSelectElement;
    sessionWordDefReasoningSelect: HTMLSelectElement;
    defaultQuestionModelSelect: HTMLSelectElement;
    defaultQuestionReasoningSelect: HTMLSelectElement;
    defaultWordDefModelSelect: HTMLSelectElement;
    defaultWordDefReasoningSelect: HTMLSelectElement;
    tagsListContainer: HTMLDivElement;
    tagNameInput: HTMLInputElement;
    tagGuidanceInput: HTMLInputElement;
    addTagButton: HTMLButtonElement;
    resetTagsButton: HTMLButtonElement;
    cloudSyncEnabledInput: HTMLInputElement;
    cloudSyncDeleteRemoteInput: HTMLInputElement;
    cloudSyncNowButton: HTMLButtonElement;
    cloudSyncResyncButton: HTMLButtonElement;
    cloudSyncExportButton: HTMLButtonElement;
    cloudSyncLastSpan: HTMLSpanElement;
    cloudSyncStatusDiv: HTMLDivElement;
    proposeBackgroundButton: HTMLButtonElement;
    languageSelect: HTMLSelectElement;
    languageInstructionsTextarea: HTMLTextAreaElement;
    addContextButton: HTMLButtonElement;
    contextNameInput: HTMLInputElement;
    contextContentTextarea: HTMLTextAreaElement;
    contextSaveButton: HTMLButtonElement;
    contextCancelButton: HTMLButtonElement;
    contextsListContainer: HTMLDivElement;
    sessionContextChipsContainer: HTMLDivElement;
    sessionContextDropdown: HTMLDivElement;
}

let refs: SettingsReferences | null = null;

/** @type {TranslationTag[]} */
let currentEditorTags: TranslationTag[] = [];

/** @type {Record<string, string>} */
let languageInstructionDrafts: Record<string, string> = {};

/**
 * @typedef {Object} ContextDefinition
 * @property {string} id - Unique ID
 * @property {string} name - Display name
 * @property {string} content - Context content text
 */
interface ContextDefinition {
    id: string;
    name: string;
    content: string;
}

/** @type {ContextDefinition[]} */
let contextDefinitions: ContextDefinition[] = [];

/** @type {string | null} */
let editingContextId: string | null = null;

/** @type {string[]} */
let selectedSessionContextIds: string[] = [];

/** @type {Record<string, string>} */
let languageInstructionOriginals: Record<string, string> = {};

/** @type {string} */
let currentLanguageDraft: string = 'english';

/**
 * Sets the application config reference
 * @param {Config} appConfig - Application configuration object
 * @returns {void}
 */
export function setConfig(appConfig: Config): void {
    config = appConfig;
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
            maxTokensInput: settingsModalElement.querySelector('#settings-max-tokens') as HTMLInputElement,
            apiKeyInput: settingsModalElement.querySelector('#settings-api-key') as HTMLInputElement,
            toggleApiKeyButton: settingsModalElement.querySelector('#settings-toggle-key-visibility') as HTMLButtonElement,
            saveSettingsButton: settingsModalElement.querySelector('#settings-save-btn') as HTMLButtonElement,
            sessionListSelect: settingsModalElement.querySelector('#settings-session-list') as HTMLSelectElement,
            sessionNameInput: settingsModalElement.querySelector('#settings-session-name') as HTMLInputElement,
            sessionInterlocutorNameInput: settingsModalElement.querySelector('#settings-session-interlocutor-name') as HTMLInputElement,
            sessionModelSelect: settingsModalElement.querySelector('#settings-session-model') as HTMLSelectElement,
            sessionLiteralModelSelect: settingsModalElement.querySelector('#settings-session-literal-model') as HTMLSelectElement,
            sessionInterpretationModelSelect: settingsModalElement.querySelector('#settings-session-interpretation-model') as HTMLSelectElement,
            sessionInterpretationReasoningSelect: settingsModalElement.querySelector('#settings-session-interpretation-reasoning') as HTMLSelectElement,
            sessionQuickQuestionModelSelect: settingsModalElement.querySelector('#settings-session-quick-question-model') as HTMLSelectElement,
            sessionQuickQuestionReasoningSelect: settingsModalElement.querySelector('#settings-session-quick-question-reasoning') as HTMLSelectElement,
            sessionBackgroundInput: settingsModalElement.querySelector('#settings-session-background') as HTMLTextAreaElement,
            sessionReasoningSelect: settingsModalElement.querySelector('#settings-session-reasoning') as HTMLSelectElement,
            sessionTranslationInstructionsInput: settingsModalElement.querySelector('#settings-session-translation-instructions') as HTMLTextAreaElement,
            sessionTheirLanguageSelect: settingsModalElement.querySelector('#settings-session-their-language') as HTMLSelectElement,
            sessionMyLanguageSelect: settingsModalElement.querySelector('#settings-session-my-language') as HTMLSelectElement,
            deleteSessionButton: settingsModalElement.querySelector('#settings-delete-session-btn') as HTMLButtonElement,
            newSessionButton: settingsModalElement.querySelector('#settings-new-session-btn') as HTMLButtonElement,
            saveSessionButton: settingsModalElement.querySelector('#settings-save-session-btn') as HTMLButtonElement,
            modelsTabSearchInput: settingsModalElement.querySelector('#settings-models-search') as HTMLInputElement,
            modelsTabListContainer: settingsModalElement.querySelector('#settings-models-list') as HTMLDivElement,
            modelsTabClearButton: settingsModalElement.querySelector('#settings-models-search-clear') as HTMLButtonElement,
            selectAllModelsBtn: settingsModalElement.querySelector('#settings-select-all-models') as HTMLButtonElement,
            deselectAllModelsBtn: settingsModalElement.querySelector('#settings-deselect-all-models') as HTMLButtonElement,
            defaultMyLanguageSelect: settingsModalElement.querySelector('#settings-default-my-language') as HTMLSelectElement,
            defaultModelSelect: settingsModalElement.querySelector('#settings-default-model') as HTMLSelectElement,
            defaultReasoningSelect: settingsModalElement.querySelector('#settings-default-reasoning') as HTMLSelectElement,
            defaultLiteralModelSelect: settingsModalElement.querySelector('#settings-default-literal-model') as HTMLSelectElement,
            defaultInterpretationModelSelect: settingsModalElement.querySelector('#settings-default-interpretation-model') as HTMLSelectElement,
            defaultInterpretationReasoningSelect: settingsModalElement.querySelector('#settings-default-interpretation-reasoning') as HTMLSelectElement,
            defaultQuickQuestionModelSelect: settingsModalElement.querySelector('#settings-default-quick-question-model') as HTMLSelectElement,
            defaultQuickQuestionReasoningSelect: settingsModalElement.querySelector('#settings-default-quick-question-reasoning') as HTMLSelectElement,
            sessionQuestionModelSelect: settingsModalElement.querySelector('#settings-session-question-model') as HTMLSelectElement,
            sessionQuestionReasoningSelect: settingsModalElement.querySelector('#settings-session-question-reasoning') as HTMLSelectElement,
            sessionWordDefModelSelect: settingsModalElement.querySelector('#settings-session-word-def-model') as HTMLSelectElement,
            sessionWordDefReasoningSelect: settingsModalElement.querySelector('#settings-session-word-def-reasoning') as HTMLSelectElement,
            defaultQuestionModelSelect: settingsModalElement.querySelector('#settings-default-question-model') as HTMLSelectElement,
            defaultQuestionReasoningSelect: settingsModalElement.querySelector('#settings-default-question-reasoning') as HTMLSelectElement,
            defaultWordDefModelSelect: settingsModalElement.querySelector('#settings-default-word-def-model') as HTMLSelectElement,
            defaultWordDefReasoningSelect: settingsModalElement.querySelector('#settings-default-word-def-reasoning') as HTMLSelectElement,
            tagsListContainer: settingsModalElement.querySelector('#settings-tags-list') as HTMLDivElement,
            tagNameInput: settingsModalElement.querySelector('#settings-tag-name') as HTMLInputElement,
            tagGuidanceInput: settingsModalElement.querySelector('#settings-tag-guidance') as HTMLInputElement,
            addTagButton: settingsModalElement.querySelector('#settings-add-tag-btn') as HTMLButtonElement,
            resetTagsButton: settingsModalElement.querySelector('#settings-reset-tags-btn') as HTMLButtonElement,
            cloudSyncEnabledInput: settingsModalElement.querySelector('#settings-cloud-sync-enabled') as HTMLInputElement,
            cloudSyncDeleteRemoteInput: settingsModalElement.querySelector('#settings-cloud-sync-delete-remote') as HTMLInputElement,
            cloudSyncNowButton: settingsModalElement.querySelector('#settings-cloud-sync-now') as HTMLButtonElement,
            cloudSyncResyncButton: settingsModalElement.querySelector('#settings-cloud-sync-resync') as HTMLButtonElement,
            cloudSyncExportButton: settingsModalElement.querySelector('#settings-cloud-sync-export') as HTMLButtonElement,
            cloudSyncLastSpan: settingsModalElement.querySelector('#settings-cloud-sync-last') as HTMLSpanElement,
            cloudSyncStatusDiv: settingsModalElement.querySelector('#settings-cloud-sync-status') as HTMLDivElement,
            proposeBackgroundButton: settingsModalElement.querySelector('#settings-propose-background-btn') as HTMLButtonElement,
            languageSelect: settingsModalElement.querySelector('#settings-language-select') as HTMLSelectElement,
            languageInstructionsTextarea: settingsModalElement.querySelector('#settings-language-instructions') as HTMLTextAreaElement,
            addContextButton: settingsModalElement.querySelector('#settings-add-context-btn') as HTMLButtonElement,
            contextNameInput: settingsModalElement.querySelector('#settings-context-name') as HTMLInputElement,
            contextContentTextarea: settingsModalElement.querySelector('#settings-context-content') as HTMLTextAreaElement,
            contextSaveButton: settingsModalElement.querySelector('#settings-context-save-btn') as HTMLButtonElement,
            contextCancelButton: settingsModalElement.querySelector('#settings-context-cancel-btn') as HTMLButtonElement,
            contextsListContainer: settingsModalElement.querySelector('#settings-contexts-list') as HTMLDivElement,
            sessionContextChipsContainer: settingsModalElement.querySelector('#settings-session-context-chips') as HTMLDivElement,
            sessionContextDropdown: settingsModalElement.querySelector('#settings-session-context-dropdown') as HTMLDivElement
        };

        setupEventListeners();
        settingsModalInstance = new (window as any).bootstrap.Modal(settingsModalElement);
    }

    selectedSessionIdInModal = translation.getCurrentSessionId();

    populateSettingsForm().then(function() {
        settingsModalInstance.show();
    });
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

    refs.newSessionButton.addEventListener('click', async function() {
        const name = window.prompt("Enter a name for the new conversation:", "New Conversation");
        if (name === null) return; // User cancelled
        const newSessionId = await translation.createSession(name.trim() || undefined);
        await renderSessionList();
        refs!.sessionListSelect.value = newSessionId;
        selectedSessionIdInModal = newSessionId;
        loadSessionIntoEditor(newSessionId);
        await refreshSessionSelector();
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
        syncModelsFromApproval();
    });

    refs.deselectAllModelsBtn.addEventListener('click', function() {
        if (config) {
            config.approvedModelIds = [];
        }
        const checkboxes = refs!.modelsTabListContainer.querySelectorAll('.model-approval-checkbox');
        checkboxes.forEach(function(cb) { (cb as HTMLInputElement).checked = false; });
        syncModelsFromApproval();
    });

    refs.addTagButton.addEventListener('click', addTag);
    refs.tagNameInput.addEventListener('keydown', function(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            event.preventDefault();
            addTag();
        }
    });
    refs.tagGuidanceInput.addEventListener('keydown', function(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            event.preventDefault();
            addTag();
        }
    });
    refs.resetTagsButton.addEventListener('click', resetTagsToDefaults);

    if (refs.proposeBackgroundButton) {
        refs.proposeBackgroundButton.addEventListener('click', function() {
            if (selectedSessionIdInModal) {
                showBackgroundUpdateModal(selectedSessionIdInModal);
            }
        });
    }

    refs.sessionTheirLanguageSelect.addEventListener('change', function() {
        const theirLanguage = refs!.sessionTheirLanguageSelect.value;
        const defaults = getDefaultTags(theirLanguage);
        if (defaults.length > 0) {
            currentEditorTags = mergeTags(currentEditorTags, defaults);
            renderTagList();
        }
    });

    refs.cloudSyncEnabledInput.addEventListener('change', function() {
        if (refs!.cloudSyncEnabledInput.checked) {
            cloudSync.enableCloudSync().then(function() {
                populateCloudSyncSettings();
            });
        } else {
            cloudSync.disableCloudSync();
            populateCloudSyncSettings();
        }
    });

    refs.cloudSyncDeleteRemoteInput.addEventListener('change', function() {
        cloudSync.setDeleteRemoteOnLocalDelete(refs!.cloudSyncDeleteRemoteInput.checked);
    });

    refs.cloudSyncNowButton.addEventListener('click', async function() {
        await cloudSync.triggerManualSync();
        populateCloudSyncSettings();
    });

    refs.cloudSyncResyncButton.addEventListener('click', async function() {
        await cloudSync.triggerCompleteResync();
        populateCloudSyncSettings();
    });

    refs.cloudSyncExportButton.addEventListener('click', async function() {
        refs!.cloudSyncStatusDiv.textContent = 'Exporting...';
        refs!.cloudSyncExportButton.disabled = true;
        try {
            const result = await cloudSync.exportToDirectory();
            let status = 'Export complete (' + result.fileCount + ' files, ' + formatHumanReadableByteCount(result.byteCount) + ')';
            if (result.skippedCount > 0) {
                status += ' \u2014 ' + result.skippedCount + ' skipped';
            }
            refs!.cloudSyncStatusDiv.textContent = status;
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Export failed';
            refs!.cloudSyncStatusDiv.textContent = msg;
            console.error('[settings] Export failed:', e);
        } finally {
            refs!.cloudSyncExportButton.disabled = false;
        }
    });

    if (settingsModalElement) {
        settingsModalElement.querySelectorAll('[data-bs-toggle="tab"]').forEach(function(btn) {
            btn.addEventListener('shown.bs.tab', async function() {
                await refreshModelDropdowns();
            });
        });

        const subTabButtons = settingsModalElement.querySelectorAll('[data-conversation-subtab]');
        subTabButtons.forEach(function(btn) {
            btn.addEventListener('click', function() {
                const targetTab = (btn as HTMLElement).dataset.conversationSubtab;

                subTabButtons.forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');

                const contextPane = settingsModalElement!.querySelector('#conversation-subtab-context') as HTMLElement;
                const modelsPane = settingsModalElement!.querySelector('#conversation-subtab-models') as HTMLElement;
                if (contextPane) { contextPane.style.display = targetTab === 'context' ? '' : 'none'; }
                if (modelsPane) { modelsPane.style.display = targetTab === 'models' ? '' : 'none'; }
            });
        });
    }

    refs.languageSelect.addEventListener('change', function() {
        const oldLang = currentLanguageDraft;
        const newLang = refs!.languageSelect.value;
        languageInstructionDrafts[oldLang] = refs!.languageInstructionsTextarea.value;
        currentLanguageDraft = newLang;
        refs!.languageInstructionsTextarea.value = languageInstructionDrafts[newLang] ?? '';
        storage.savePreference('lastLanguageInstructions', newLang).catch(function() {});
    });

    refs.languageInstructionsTextarea.addEventListener('input', function() {
        languageInstructionDrafts[currentLanguageDraft] = refs!.languageInstructionsTextarea.value;
    });

    refs.addContextButton.addEventListener('click', function() {
        startEditContext(null);
    });

    refs.contextSaveButton.addEventListener('click', async function() {
        const name = refs!.contextNameInput.value.trim();
        const content = refs!.contextContentTextarea.value.trim();
        if (!name) {
            ui.displayError('Context name is required');
            return;
        }
        if (!content) {
            ui.displayError('Context content is required');
            return;
        }
        if (editingContextId) {
            const existing = contextDefinitions.find(function(c) { return c.id === editingContextId; });
            if (existing) {
                existing.name = name;
                existing.content = content;
            }
        } else {
            contextDefinitions.push({ id: crypto.randomUUID(), name: name, content: content });
        }
        editingContextId = null;
        const editForm = document.getElementById('settings-context-edit-form') as HTMLElement | null;
        if (editForm) editForm.style.display = 'none';
        await saveContextDefinitions();
        renderContextList();
    });

    refs.contextCancelButton.addEventListener('click', function() {
        editingContextId = null;
        const editForm = document.getElementById('settings-context-edit-form') as HTMLElement | null;
        if (editForm) editForm.style.display = 'none';
    });

    refs.sessionContextChipsContainer.addEventListener('click', function() {
        showContextDropdown();
    });

    document.addEventListener('click', function(e) {
        if (refs && refs.sessionContextDropdown.style.display !== 'none') {
            const target = e.target as Node;
            const chipsContainer = refs.sessionContextChipsContainer;
            const dropdown = refs.sessionContextDropdown;
            if (!chipsContainer.contains(target) && !dropdown.contains(target)) {
                dropdown.style.display = 'none';
            }
        }
    });
}

/**
 * Populates the settings form with current config values
 * @returns {Promise<void>}
 */
async function populateSettingsForm(): Promise<void> {
    if (!refs || !config) return;

    refs.minPriceInput.value = config.minPrice !== null ? String(config.minPrice) : '';
    refs.maxPriceInput.value = config.maxPrice !== null ? String(config.maxPrice) : '';
    refs.temperatureInput.value = String(config.temperature);
    refs.questionTemperatureInput.value = String(config.questionTemperature);
    refs.maxTokensInput.value = String(Math.round(config.maxTokens / 1024));
    refs.apiKeyInput.value = config.openRouterApiKey ?? '';

    renderSessionList();
    clearSessionEditor();
    populateModelDropdown();
    populateLanguageDropdowns();
    populateDefaultMyLanguageDropdown();
    await populateDefaultModelDropdowns();
    populateModelsTab();
    populateCloudSyncSettings();
    populateLanguageSelect();
    await loadLanguageInstructions();
    await populateContextsTab();
}

/**
 * Populates the cloud sync settings controls
 * @returns {void}
 */
function populateCloudSyncSettings(): void {
    if (!refs) return;

    refs.cloudSyncEnabledInput.checked = STATE.cloudSync.enabled;
    refs.cloudSyncDeleteRemoteInput.checked = STATE.cloudSync.deleteRemoteOnLocalDelete;

    const lastSync = STATE.cloudSync.lastSyncTime;
    if (lastSync) {
        const d = new Date(lastSync);
        refs.cloudSyncLastSpan.textContent = 'Last sync: ' + d.toLocaleString();
    } else {
        refs.cloudSyncLastSpan.textContent = 'Last sync: never';
    }

    if (STATE.cloudSync.isSyncing) {
        refs.cloudSyncStatusDiv.textContent = 'Syncing...';
        refs.cloudSyncNowButton.disabled = true;
    } else if (STATE.cloudSync.lastError) {
        refs.cloudSyncStatusDiv.textContent = 'Error: ' + STATE.cloudSync.lastError;
        refs.cloudSyncNowButton.disabled = false;
    } else if (STATE.cloudSync.enabled) {
        refs.cloudSyncStatusDiv.textContent = 'Cloud sync is active';
        refs.cloudSyncNowButton.disabled = false;
    } else {
        refs.cloudSyncStatusDiv.textContent = 'Cloud sync is disabled';
        refs.cloudSyncNowButton.disabled = false;
    }
}

/**
 * Formats a byte count into a human-readable string (e.g. "15.3 MB")
 * @param {number} bytes - Byte count
 * @returns {string} Formatted string with units
 */
function formatHumanReadableByteCount(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return value.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

/**
 * Merges default tags into existing tags, avoiding duplicates by name.
 * Creates deep copies to avoid shared references.
 * @param {TranslationTag[]} existing - Current tags
 * @param {TranslationTag[]} defaults - Default tags to merge in
 * @returns {TranslationTag[]} Merged tags with deep copies
 */
function mergeTags(existing: TranslationTag[], defaults: TranslationTag[]): TranslationTag[] {
    const merged = existing.map(function(t) { return { ...t }; });
    for (const def of defaults) {
        if (!merged.some(function(t) { return t.name === def.name; })) {
            merged.push({ ...def });
        }
    }
    return merged;
}

/**
 * Sets the available models for the session model dropdown
 * @param {VisionModel[]} availableModels - Array of available models
 * @returns {void}
 */
export function setModels(availableModels: VisionModel[], updateUI: boolean = true): void {
    models = availableModels;
    if (updateUI) {
        populateModelDropdown();
        populateDefaultModelDropdowns();
    }
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
 * Rebuilds the in-memory models array from allModels filtered by current approvedModelIds
 * @returns {void}
 */
function syncModelsFromApproval(): void {
    if (!config) return;
    const approvedSet = new Set(config.approvedModelIds ?? []);
    models = config.approvedModelIds === null
        ? [...allModels]
        : allModels.filter(function(m) { return approvedSet.has(m.id + '::' + (m.providerName ?? '')); });
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
            syncModelsFromApproval();
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
    setModels(approvedModels, false);
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
    disabledPlaceholder.textContent = 'Default';
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
    interpDisabledPlaceholder.textContent = 'Default';
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

    refs.sessionQuickQuestionModelSelect.innerHTML = '';

    const qqDisabledPlaceholder = document.createElement('option');
    qqDisabledPlaceholder.value = '';
    qqDisabledPlaceholder.textContent = 'Default';
    refs.sessionQuickQuestionModelSelect.appendChild(qqDisabledPlaceholder);

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
        refs.sessionQuickQuestionModelSelect.appendChild(option);
    }

    refs.sessionQuestionModelSelect.innerHTML = '';

    const questionDisabledPlaceholder = document.createElement('option');
    questionDisabledPlaceholder.value = '';
    questionDisabledPlaceholder.textContent = 'Default';
    refs.sessionQuestionModelSelect.appendChild(questionDisabledPlaceholder);

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
        refs.sessionQuestionModelSelect.appendChild(option);
    }

    refs.sessionWordDefModelSelect.innerHTML = '';

    const wordDefDisabledPlaceholder = document.createElement('option');
    wordDefDisabledPlaceholder.value = '';
    wordDefDisabledPlaceholder.textContent = 'Default';
    refs.sessionWordDefModelSelect.appendChild(wordDefDisabledPlaceholder);

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
        refs.sessionWordDefModelSelect.appendChild(option);
    }
}

/**
 * Populates the default model dropdowns in the Settings tab
 * @returns {Promise<void>}
 */
async function populateDefaultModelDropdowns(): Promise<void> {
    if (!refs) return;

    refs.defaultModelSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select model...';
    refs.defaultModelSelect.appendChild(placeholder);

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
        refs.defaultModelSelect.appendChild(option);
    }

    refs.defaultLiteralModelSelect.innerHTML = '';
    const disabledPlaceholder = document.createElement('option');
    disabledPlaceholder.value = '';
    disabledPlaceholder.textContent = 'Default';
    refs.defaultLiteralModelSelect.appendChild(disabledPlaceholder);

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
        refs.defaultLiteralModelSelect.appendChild(option);
    }

    refs.defaultInterpretationModelSelect.innerHTML = '';
    const interpDisabledPlaceholder = document.createElement('option');
    interpDisabledPlaceholder.value = '';
    interpDisabledPlaceholder.textContent = 'Default';
    refs.defaultInterpretationModelSelect.appendChild(interpDisabledPlaceholder);

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
        refs.defaultInterpretationModelSelect.appendChild(option);
    }

    refs.defaultQuickQuestionModelSelect.innerHTML = '';
    const qqDisabledPlaceholder = document.createElement('option');
    qqDisabledPlaceholder.value = '';
    qqDisabledPlaceholder.textContent = 'Default';
    refs.defaultQuickQuestionModelSelect.appendChild(qqDisabledPlaceholder);

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
        refs.defaultQuickQuestionModelSelect.appendChild(option);
    }

    refs.defaultQuestionModelSelect.innerHTML = '';
    const questionDisabledPlaceholder = document.createElement('option');
    questionDisabledPlaceholder.value = '';
    questionDisabledPlaceholder.textContent = 'Default';
    refs.defaultQuestionModelSelect.appendChild(questionDisabledPlaceholder);

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
        refs.defaultQuestionModelSelect.appendChild(option);
    }

    refs.defaultWordDefModelSelect.innerHTML = '';
    const wordDefDefPlaceholder = document.createElement('option');
    wordDefDefPlaceholder.value = '';
    wordDefDefPlaceholder.textContent = 'Select model...';
    refs.defaultWordDefModelSelect.appendChild(wordDefDefPlaceholder);

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
        refs.defaultWordDefModelSelect.appendChild(option);
    }

    const [defaultModelPref, defaultReasoningPref, defaultLiteralModelPref, defaultInterpretationModelPref, defaultInterpretationReasoningPref, defaultQuickQuestionModelPref, defaultQuickQuestionReasoningPref, defaultQuestionModelPref, defaultQuestionReasoningPref, defaultWordDefModelPref, defaultWordDefReasoningPref] = await Promise.all([
        storage.getPreference("defaultModel"),
        storage.getPreference("defaultReasoning"),
        storage.getPreference("defaultLiteralModel"),
        storage.getPreference("defaultInterpretationModel"),
        storage.getPreference("defaultInterpretationReasoning"),
        storage.getPreference("defaultQuickQuestionModel"),
        storage.getPreference("defaultQuickQuestionReasoning"),
        storage.getPreference("defaultQuestionModel"),
        storage.getPreference("defaultQuestionReasoning"),
        storage.getPreference("defaultWordDefModel"),
        storage.getPreference("defaultWordDefReasoning")
    ]);

    console.log('[defaults] Loaded from OPFS - model:', defaultModelPref, 'reasoning:', defaultReasoningPref, 'literalModel:', defaultLiteralModelPref, 'interpretationModel:', defaultInterpretationModelPref, 'interpretationReasoning:', defaultInterpretationReasoningPref);

    refs.defaultModelSelect.value = defaultModelPref ?? '';
    refs.defaultReasoningSelect.value = defaultReasoningPref ?? 'none';
    refs.defaultLiteralModelSelect.value = defaultLiteralModelPref ?? '';
    refs.defaultInterpretationModelSelect.value = defaultInterpretationModelPref ?? '';
    refs.defaultInterpretationReasoningSelect.value = defaultInterpretationReasoningPref ?? 'none';
    refs.defaultQuickQuestionModelSelect.value = defaultQuickQuestionModelPref ?? '';
    refs.defaultQuickQuestionReasoningSelect.value = defaultQuickQuestionReasoningPref ?? 'none';
    refs.defaultQuestionModelSelect.value = defaultQuestionModelPref ?? '';
    refs.defaultQuestionReasoningSelect.value = defaultQuestionReasoningPref ?? 'none';
    refs.defaultWordDefModelSelect.value = defaultWordDefModelPref ?? '';
    refs.defaultWordDefReasoningSelect.value = defaultWordDefReasoningPref ?? 'none';
}

/**
 * Populates the language select dropdown in the Languages tab
 * @returns {Promise<void>}
 */
async function populateLanguageSelect(): Promise<void> {
    if (!refs) return;
    refs.languageSelect.innerHTML = '';
    for (const lang of LANGUAGES) {
        const option = document.createElement('option');
        option.value = lang.id;
        option.textContent = lang.name;
        refs.languageSelect.appendChild(option);
    }
    const lastLang = await storage.getPreference('lastLanguageInstructions');
    refs.languageSelect.value = lastLang ?? 'english';
}

/**
 * Loads language instruction drafts from preferences
 * @returns {Promise<void>}
 */
async function loadLanguageInstructions(): Promise<void> {
    languageInstructionDrafts = {};
    languageInstructionOriginals = {};
    for (const lang of LANGUAGES) {
        const val = await storage.getPreference('langInstructions_' + lang.id);
        if (val) {
            languageInstructionDrafts[lang.id] = val;
            languageInstructionOriginals[lang.id] = val;
        }
    }
    console.log('[languageInstructions] Loaded drafts:', JSON.stringify(languageInstructionDrafts));
    if (refs) {
        currentLanguageDraft = refs.languageSelect.value;
        refs.languageInstructionsTextarea.value = languageInstructionDrafts[currentLanguageDraft] ?? '';
        console.log('[languageInstructions] Set textarea for:', currentLanguageDraft);
    }
}

/**
 * Saves all language instruction drafts to preferences
 * @returns {Promise<void>}
 */
async function saveLanguageInstructions(): Promise<void> {
    if (!refs) return;
    languageInstructionDrafts[currentLanguageDraft] = refs.languageInstructionsTextarea.value;
    for (const lang of LANGUAGES) {
        const key = 'langInstructions_' + lang.id;
        const draft = languageInstructionDrafts[lang.id] ?? '';
        const original = languageInstructionOriginals[lang.id] ?? '';
        if (draft !== original) {
            if (draft) {
                await storage.savePreference(key, draft);
            } else {
                await storage.deletePreference(key);
            }
        }
    }
    languageInstructionOriginals = { ...languageInstructionDrafts };
    console.log('[languageInstructions] Saved. Drafts:', JSON.stringify(languageInstructionDrafts));
}

/**
 * Loads context definitions from preferences
 * @returns {Promise<void>}
 */
async function loadContextDefinitions(): Promise<void> {
    const val = await storage.getPreference('contextDefinitions');
    if (val) {
        try {
            contextDefinitions = JSON.parse(val) as ContextDefinition[];
        } catch {
            contextDefinitions = [];
        }
    } else {
        contextDefinitions = [];
    }
}

/**
 * Saves context definitions to preferences
 * @returns {Promise<void>}
 */
async function saveContextDefinitions(): Promise<void> {
    if (contextDefinitions.length > 0) {
        await storage.savePreference('contextDefinitions', JSON.stringify(contextDefinitions));
    } else {
        await storage.deletePreference('contextDefinitions');
    }
}

/**
 * Populates the Contexts tab with stored definitions
 * @returns {Promise<void>}
 */
async function populateContextsTab(): Promise<void> {
    await loadContextDefinitions();
    renderContextList();
}

/**
 * Renders the context definitions list using the template
 * @returns {void}
 */
function renderContextList(): void {
    if (!refs) return;
    refs.contextsListContainer.innerHTML = '';
    const template = document.getElementById('context-definition-item-template') as HTMLTemplateElement | null;
    if (!template) return;

    for (const ctx of contextDefinitions) {
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const container = clone.firstElementChild as HTMLElement;
        (container.querySelector('.context-def-name') as HTMLElement).textContent = ctx.name;
        (container.querySelector('.context-def-preview') as HTMLElement).textContent = ctx.content.length > 80 ? ctx.content.substring(0, 80) + '...' : ctx.content;
        const editBtn = container.querySelector('.context-edit-btn') as HTMLButtonElement | null;
        const deleteBtn = container.querySelector('.context-delete-btn') as HTMLButtonElement | null;
        if (editBtn) {
            editBtn.addEventListener('click', function() {
                startEditContext(ctx.id);
            });
        }
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async function() {
                contextDefinitions = contextDefinitions.filter(function(c) { return c.id !== ctx.id; });
                await saveContextDefinitions();
                renderContextList();
            });
        }
        refs.contextsListContainer.appendChild(clone);
    }
}

/**
 * Shows the context edit form for a given context ID, or clears for new
 * @param {string | null} contextId - Context ID to edit, or null for new
 * @returns {void}
 */
function startEditContext(contextId: string | null): void {
    if (!refs) return;
    editingContextId = contextId;
    const editForm = document.getElementById('settings-context-edit-form') as HTMLElement | null;
    if (!editForm) return;
    editForm.style.display = '';
    if (contextId) {
        const ctx = contextDefinitions.find(function(c) { return c.id === contextId; });
        if (ctx) {
            refs.contextNameInput.value = ctx.name;
            refs.contextContentTextarea.value = ctx.content;
        }
    } else {
        refs.contextNameInput.value = '';
        refs.contextContentTextarea.value = '';
    }
}

/**
 * Renders chips for selected contexts in the Conversations tab
 * @param {string[]} selectedIds - Array of selected context IDs
 * @returns {void}
 */
function renderContextChips(selectedIds: string[]): void {
    if (!refs) return;
    refs.sessionContextChipsContainer.innerHTML = '';
    const template = document.getElementById('context-chip-template') as HTMLTemplateElement | null;
    if (!template) return;

    for (const ctxId of selectedIds) {
        const ctx = contextDefinitions.find(function(c) { return c.id === ctxId; });
        if (!ctx) continue;
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const container = clone.firstElementChild as HTMLElement;
        (container.querySelector('.context-chip-name') as HTMLElement).textContent = ctx.name;
        const removeBtn = container.querySelector('.btn-close') as HTMLButtonElement | null;
        if (removeBtn) {
            removeBtn.addEventListener('click', function() {
                selectedSessionContextIds = selectedSessionContextIds.filter(function(id) { return id !== ctxId; });
                renderContextChips(selectedSessionContextIds);
            });
        }
        refs.sessionContextChipsContainer.appendChild(clone);
    }
}

/**
 * Shows dropdown with matching unselected contexts
 * @param {string} query - Search query
 * @returns {void}
 */
function showContextDropdown(): void {
    if (!refs) return;
    const dropdown = refs.sessionContextDropdown;
    dropdown.innerHTML = '';
    const template = document.getElementById('context-dropdown-item-template') as HTMLTemplateElement | null;
    if (!template) return;

    if (contextDefinitions.length === 0) {
        const noOpts = document.createElement('div');
        noOpts.className = 'px-2 py-1 text-muted small';
        noOpts.textContent = 'No contexts defined. Create them in the Contexts tab.';
        dropdown.appendChild(noOpts);
        dropdown.style.display = '';
        return;
    }

    const matches = contextDefinitions.filter(function(ctx) {
        return !selectedSessionContextIds.includes(ctx.id);
    });

    if (matches.length === 0) {
        const noOpts = document.createElement('div');
        noOpts.className = 'px-2 py-1 text-muted small';
        noOpts.textContent = 'All contexts are already selected.';
        dropdown.appendChild(noOpts);
        dropdown.style.display = '';
        return;
    }

    for (const ctx of matches) {
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const container = clone.firstElementChild as HTMLElement;
        (container.querySelector('.context-dropdown-name') as HTMLElement).textContent = ctx.name;
        (container.querySelector('.context-dropdown-preview') as HTMLElement).textContent = ctx.content.length > 60 ? ctx.content.substring(0, 60) + '...' : ctx.content;
        container.addEventListener('click', function() {
            selectedSessionContextIds.push(ctx.id);
            renderContextChips(selectedSessionContextIds);
            dropdown.style.display = 'none';
        });
        dropdown.appendChild(clone);
    }
    dropdown.style.display = '';
}

/**
 * Checks if model dropdowns match the current models array and repopulates with
 * selection preserved if they don't
 * @returns {Promise<void>}
 */
async function refreshModelDropdowns(): Promise<void> {
    if (!refs) return;

    const selects = [
        refs.sessionModelSelect,
        refs.sessionLiteralModelSelect,
        refs.sessionInterpretationModelSelect,
        refs.sessionQuickQuestionModelSelect,
        refs.sessionQuestionModelSelect,
        refs.sessionWordDefModelSelect,
        refs.defaultModelSelect,
        refs.defaultLiteralModelSelect,
        refs.defaultInterpretationModelSelect,
        refs.defaultQuickQuestionModelSelect,
        refs.defaultQuestionModelSelect,
        refs.defaultWordDefModelSelect
    ];

    let needsRefresh = false;
    for (const select of selects) {
        if (select.options.length - 1 !== models.length) { needsRefresh = true; break; }
        for (let i = 0; i < models.length; i++) {
            if (select.options[i + 1].value !== models[i].id) { needsRefresh = true; break; }
        }
        if (needsRefresh) break;
    }

    if (!needsRefresh) return;

    const saved = selects.map(function(s) { return s.value; });
    populateModelDropdown();
    await populateDefaultModelDropdowns();
    for (let i = 0; i < selects.length; i++) {
        if (saved[i]) selects[i].value = saved[i];
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
 * Populates the default "my language" dropdown in settings
 * @returns {void}
 */
function populateDefaultMyLanguageDropdown(): void {
    if (!refs) return;

    refs.defaultMyLanguageSelect.innerHTML = '';

    for (const lang of LANGUAGES) {
        const option = document.createElement('option');
        option.value = lang.id;
        option.textContent = lang.name;
        refs.defaultMyLanguageSelect.appendChild(option);
    }

    refs.defaultMyLanguageSelect.value = config?.defaultMyLanguage ?? 'english';
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

    const maxTokensStr = refs.maxTokensInput.value.trim();
    const maxTokensK = parseInt(maxTokensStr, 10);
    if (!isNaN(maxTokensK) && maxTokensK > 0) {
        config.maxTokens = maxTokensK * 1024;
        await storage.savePreference('maxTokens', String(config.maxTokens));
    }

    const defaultModel = refs.defaultModelSelect.value || null;
    const defaultReasoning = refs.defaultReasoningSelect.value;
    const defaultLiteralModel = refs.defaultLiteralModelSelect.value || null;
    const defaultInterpretationModel = refs.defaultInterpretationModelSelect.value || null;
    const defaultInterpretationReasoning = refs.defaultInterpretationReasoningSelect.value;
    const defaultQuickQuestionModel = refs.defaultQuickQuestionModelSelect.value || null;
    const defaultQuickQuestionReasoning = refs.defaultQuickQuestionReasoningSelect.value;
    const defaultQuestionModel = refs.defaultQuestionModelSelect.value || null;
    const defaultQuestionReasoning = refs.defaultQuestionReasoningSelect.value;
    const defaultWordDefModel = refs.defaultWordDefModelSelect.value || null;
    const defaultWordDefReasoning = refs.defaultWordDefReasoningSelect.value;

    await saveApprovedModels();

    const defaultMyLanguageStr = refs.defaultMyLanguageSelect.value.trim();
    if (defaultMyLanguageStr) {
        config.defaultMyLanguage = defaultMyLanguageStr;
        await storage.savePreference('defaultMyLanguage', defaultMyLanguageStr);
    }

    if (defaultModel) {
        await storage.savePreference('defaultModel', defaultModel);
    } else {
        await storage.deletePreference('defaultModel');
    }

    await storage.savePreference('defaultReasoning', defaultReasoning);
    config.defaultReasoning = defaultReasoning as ReasoningLevel;

    if (defaultLiteralModel) {
        await storage.savePreference('defaultLiteralModel', defaultLiteralModel);
    } else {
        await storage.deletePreference('defaultLiteralModel');
    }
    config.defaultLiteralModel = defaultLiteralModel;

    if (defaultInterpretationModel) {
        await storage.savePreference('defaultInterpretationModel', defaultInterpretationModel);
    } else {
        await storage.deletePreference('defaultInterpretationModel');
    }
    config.defaultInterpretationModel = defaultInterpretationModel;

    await storage.savePreference('defaultInterpretationReasoning', defaultInterpretationReasoning);
    config.defaultInterpretationReasoning = defaultInterpretationReasoning as ReasoningLevel;

    if (defaultQuickQuestionModel) {
        await storage.savePreference('defaultQuickQuestionModel', defaultQuickQuestionModel);
    } else {
        await storage.deletePreference('defaultQuickQuestionModel');
    }
    config.quickQuestionModel = defaultQuickQuestionModel;

    await storage.savePreference('defaultQuickQuestionReasoning', defaultQuickQuestionReasoning);
    config.defaultQuickQuestionReasoning = defaultQuickQuestionReasoning as ReasoningLevel;

    config.defaultQuestionModel = defaultQuestionModel;
    config.defaultQuestionReasoning = defaultQuestionReasoning as ReasoningLevel;

    if (defaultQuestionModel) {
        await storage.savePreference('defaultQuestionModel', defaultQuestionModel);
    } else {
        await storage.deletePreference('defaultQuestionModel');
    }

    await storage.savePreference('defaultQuestionReasoning', defaultQuestionReasoning);

    config.defaultWordDefModel = defaultWordDefModel;
    config.defaultWordDefReasoning = defaultWordDefReasoning as ReasoningLevel;

    if (defaultWordDefModel) {
        await storage.savePreference('defaultWordDefModel', defaultWordDefModel);
    } else {
        await storage.deletePreference('defaultWordDefModel');
    }

    await storage.savePreference('defaultWordDefReasoning', defaultWordDefReasoning);

    console.log('[defaults] Saved - model:', defaultModel, 'reasoning:', defaultReasoning, 'literalModel:', defaultLiteralModel, 'interpretationModel:', defaultInterpretationModel, 'interpretationReasoning:', defaultInterpretationReasoning, 'quickQuestionModel:', defaultQuickQuestionModel, 'quickQuestionReasoning:', defaultQuickQuestionReasoning, 'questionModel:', defaultQuestionModel, 'questionReasoning:', defaultQuestionReasoning, 'wordDefModel:', defaultWordDefModel, 'wordDefReasoning:', defaultWordDefReasoning);

    await saveLanguageInstructions();
    await saveContextDefinitions();

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
            refs.sessionInterpretationReasoningSelect.value = session.interpretationReasoning ?? '';
            refs.sessionQuickQuestionModelSelect.value = session.quickQuestionModel ?? '';
            refs.sessionQuickQuestionReasoningSelect.value = session.quickQuestionReasoning ?? '';
            refs.sessionQuestionModelSelect.value = session.questionModel ?? '';
            refs.sessionQuestionReasoningSelect.value = session.questionReasoning ?? '';
            refs.sessionWordDefModelSelect.value = session.wordDefModel ?? '';
            refs.sessionWordDefReasoningSelect.value = session.wordDefReasoning ?? '';
            refs.sessionBackgroundInput.value = session.background ?? '';
            refs.sessionReasoningSelect.value = session.reasoning ?? '';
            refs.sessionTranslationInstructionsInput.value = session.translationInstructions ?? '';
            refs.sessionTheirLanguageSelect.value = session.theirLanguage ?? 'english';
            refs.sessionMyLanguageSelect.value = session.myLanguage ?? config?.defaultMyLanguage ?? 'english';
            currentEditorTags = session.translationTags ? JSON.parse(JSON.stringify(session.translationTags)) : [];
            renderTagList();
            selectedSessionContextIds = session.selectedContextIds ? session.selectedContextIds.slice() : [];
            renderContextChips(selectedSessionContextIds);
        } else if (refs) {
            refs.sessionNameInput.value = '';
            refs.sessionInterlocutorNameInput.value = '';
            refs.sessionModelSelect.value = '';
            refs.sessionLiteralModelSelect.value = '';
            refs.sessionInterpretationModelSelect.value = '';
            refs.sessionInterpretationReasoningSelect.value = '';
            refs.sessionQuickQuestionModelSelect.value = '';
            refs.sessionQuickQuestionReasoningSelect.value = '';
            refs.sessionQuestionModelSelect.value = '';
            refs.sessionQuestionReasoningSelect.value = '';
            refs.sessionWordDefModelSelect.value = '';
            refs.sessionWordDefReasoningSelect.value = '';
            refs.sessionBackgroundInput.value = '';
            refs.sessionReasoningSelect.value = '';
            refs.sessionTranslationInstructionsInput.value = '';
            currentEditorTags = [];
            renderTagList();
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
    refs.sessionTranslationInstructionsInput.value = '';
    refs.sessionTheirLanguageSelect.value = 'english';
    refs.sessionMyLanguageSelect.value = config?.defaultMyLanguage ?? 'english';
    currentEditorTags = [];
    renderTagList();
    selectedSessionContextIds = [];
    renderContextChips(selectedSessionContextIds);
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
 * Renders the tag list in the settings editor using the tag-item template
 * @returns {void}
 */
function renderTagList(): void {
    if (!refs) return;
    refs.tagsListContainer.innerHTML = '';

    if (currentEditorTags.length === 0) {
        refs.tagsListContainer.textContent = 'No tags defined.';
        return;
    }

    const template = document.getElementById('settings-tag-item-template') as HTMLTemplateElement;
    if (!template) {
        refs.tagsListContainer.textContent = 'Tag template not found.';
        return;
    }

    currentEditorTags.forEach(function(tag, index) {
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const root = clone.firstElementChild as HTMLElement;
        const nameEl = root.querySelector('.tag-name') as HTMLDivElement;
        const textarea = root.querySelector('.tag-guidance-textarea') as HTMLTextAreaElement;
        const deleteBtn = root.querySelector('button') as HTMLButtonElement;

        nameEl.textContent = tag.openTag + '...' + tag.closeTag;
        textarea.value = tag.guidance;

        textarea.addEventListener('input', function() {
            currentEditorTags[index].guidance = textarea.value;
        });

        deleteBtn.addEventListener('click', function() {
            removeTag(index);
        });

        refs!.tagsListContainer.appendChild(clone);
    });
}

/**
 * Adds a new tag from the input fields
 * @returns {void}
 */
function addTag(): void {
    if (!refs) return;
    const name = refs.tagNameInput.value.trim();
    const guidance = refs.tagGuidanceInput.value.trim();

    if (!name) {
        ui.displayError('Tag name is required');
        return;
    }
    if (!guidance) {
        ui.displayError('Tag guidance is required');
        return;
    }

    const tag: TranslationTag = {
        name: name,
        openTag: '<' + name + '>',
        closeTag: '</' + name + '>',
        guidance: guidance
    };

    currentEditorTags.push(tag);
    renderTagList();

    refs.tagNameInput.value = '';
    refs.tagGuidanceInput.value = '';
    refs.tagNameInput.focus();
}

/**
 * Removes a tag at the given index
 * @param {number} index - Index of tag to remove
 * @returns {void}
 */
function removeTag(index: number): void {
    if (index >= 0 && index < currentEditorTags.length) {
        currentEditorTags.splice(index, 1);
        renderTagList();
    }
}

/**
 * Resets tags to language defaults for the current session
 * @returns {void}
 */
function resetTagsToDefaults(): void {
    if (!refs || !selectedSessionIdInModal) return;

    const theirLanguage = refs.sessionTheirLanguageSelect.value;
    const defaults = getDefaultTags(theirLanguage);
    if (defaults.length > 0) {
        currentEditorTags = defaults.map(function(t) { return { ...t }; });
        renderTagList();
    }
    // If no defaults for this language, keep existing tags
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
    session.interpretationReasoning = (refs.sessionInterpretationReasoningSelect.value || undefined) as ReasoningLevel | undefined;
    session.quickQuestionModel = refs.sessionQuickQuestionModelSelect.value || null;
    session.quickQuestionReasoning = (refs.sessionQuickQuestionReasoningSelect.value || undefined) as ReasoningLevel | undefined;
    session.questionModel = refs.sessionQuestionModelSelect.value || null;
    session.questionReasoning = (refs.sessionQuestionReasoningSelect.value || undefined) as ReasoningLevel | undefined;
    session.wordDefModel = refs.sessionWordDefModelSelect.value || null;
    session.wordDefReasoning = (refs.sessionWordDefReasoningSelect.value || undefined) as ReasoningLevel | undefined;
    session.background = refs.sessionBackgroundInput.value;
    session.reasoning = (refs.sessionReasoningSelect.value || null) as ReasoningLevel | null;
    session.translationInstructions = refs.sessionTranslationInstructionsInput.value || null;
    session.translationTags = currentEditorTags.length > 0 ? currentEditorTags : undefined;
    session.theirLanguage = refs.sessionTheirLanguageSelect.value;
    session.myLanguage = refs.sessionMyLanguageSelect.value;
    session.interlocutorName = refs.sessionInterlocutorNameInput.value.trim() || undefined;
    session.selectedContextIds = selectedSessionContextIds.length > 0 ? selectedSessionContextIds.slice() : undefined;
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