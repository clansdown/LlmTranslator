/**
 * Main application initialization module
 */

import { savePreference, getPreference, deletePreference } from './storage';
import { fetchBalance, fetchZdrModels, setConfig as setOpenRouterConfig } from './openrouter';
import { Modal } from 'bootstrap';
import * as ui from './ui';
import * as settings from './settings';
import * as translation from './translation';
import { initAuth, getClerk, mountAuthComponent, isSignedIn } from './auth';
import { initCloudSync, setSyncReloadCallback } from './cloudSync';
import { setConfig as setBackgroundUpdateConfig } from './backgroundUpdate';
import type { Config } from './types/config';
import type { ReasoningLevel } from './types/session';

/**
 * Application configuration object
 * Contains runtime configuration that code will need access to
 */
const config: Config = {
    openRouterApiKey: null,
    selectedModel: null,
    minPrice: null,
    maxPrice: null,
    defaultMyLanguage: 'english',
    approvedModelIds: null,
    temperature: 0.2,
    questionTemperature: 0.35,
    quickQuestionModel: null,
    maxTokens: 32768,
    defaultQuestionModel: null,
    defaultQuestionReasoning: 'none',
    defaultWordDefModel: null,
    defaultWordDefReasoning: 'none',
    defaultQuickQuestionReasoning: 'none',
    defaultReasoning: 'none',
    defaultLiteralModel: null,
    defaultInterpretationModel: null,
    defaultInterpretationReasoning: 'none'
};

/**
 * Refreshes the OpenRouter account balance
 * @returns {Promise<void>}
 */
async function refreshBalance(): Promise<void> {
    const apiKey = config.openRouterApiKey;
    if (!apiKey) {
        return;
    }

    try {
        const balanceInfo = await fetchBalance(apiKey);
        ui.updateBalanceDisplay("$" + (balanceInfo.totalCredits - balanceInfo.totalUsage).toFixed(2));
    } catch (error) {
        ui.displayError(error instanceof Error ? error.message : "Failed to fetch balance");
    }
}

/**
 * Fetches and loads ZDR models and passes them to settings and translation modules
 * @returns {Promise<void>}
 */
async function loadModels(): Promise<void> {
    const apiKey = config.openRouterApiKey;
    if (!apiKey) {
        return;
    }

    try {
        let models = await fetchZdrModels(apiKey);
        models = settings.filterModelsByPrice(models);

        const approvedModels = settings.filterModelsByApproval(models);

        settings.setAllModels(models);
        settings.setModels(approvedModels);
        translation.setModelNameMap(approvedModels);
        translation.setModelOverrideOptions(approvedModels);

        const savedModelId = await getPreference("selectedModel");
        if (savedModelId && approvedModels.some(function(m) { return m.id === savedModelId; })) {
            config.selectedModel = savedModelId;
            translation.updateButtonStates();
        } else if (approvedModels.length > 0) {
            config.selectedModel = approvedModels[0].id;
            savePreference("selectedModel", approvedModels[0].id).catch(function() {});
            translation.updateButtonStates();
        }

        const savedQQModelId = await getPreference("defaultQuickQuestionModel");
        if (savedQQModelId && approvedModels.some(function(m) { return m.id === savedQQModelId; })) {
            config.quickQuestionModel = savedQQModelId;
        }

        const savedLiteralModelId = await getPreference("defaultLiteralModel");
        if (savedLiteralModelId && approvedModels.some(function(m) { return m.id === savedLiteralModelId; })) {
            config.defaultLiteralModel = savedLiteralModelId;
        }

        const savedInterpretationModelId = await getPreference("defaultInterpretationModel");
        if (savedInterpretationModelId && approvedModels.some(function(m) { return m.id === savedInterpretationModelId; })) {
            config.defaultInterpretationModel = savedInterpretationModelId;
        }
    } catch (error) {
        console.error("[loadModels] Error:", error);
        ui.displayError(error instanceof Error ? error.message : "Failed to load models");
    }
}

/**
 * Saves the API key to config and storage.
 * Writes to the shared /credentials/ directory so all FindForge apps can use it,
 * then syncs to the cloud immediately. Also writes to legacy preferences/apiKey
 * as a permanent fallback.
 * @param {string} key - API key to save
 * @returns {Promise<void>}
 */
export async function saveApiKey(key: string): Promise<void> {
    config.openRouterApiKey = key;
    const { writeCredential } = await import('./opfs');
    await writeCredential('openrouter', key);
    const { syncCredentialToCloud } = await import('./cloudSync');
    await syncCredentialToCloud('openrouter');
    await savePreference("apiKey", key);
    await refreshBalance();
    await loadModels();
}

/**
 * Checks the URL for a ?key= parameter and uses it if no key is stored
 * Strips the key parameter from the URL after reading
 * @returns {Promise<void>}
 */
async function loadUrlApiKey(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const urlKey = params.get('key');

    if (!urlKey) {
        return;
    }

    params.delete('key');
    const newUrl = window.location.pathname +
        (params.toString() ? '?' + params.toString() : '') +
        window.location.hash;
    history.replaceState(null, '', newUrl);

    if (!config.openRouterApiKey) {
        try {
            await saveApiKey(urlKey);
        } catch (error) {
            ui.displayError(error instanceof Error ? error.message : "Failed to set API key from URL");
        }
    }
}

/**
 * Loads the API key from /credentials/ first (shared across FindForge apps),
 * then falls back to the legacy per-app preferences/apiKey.
 * @returns {Promise<void>}
 */
async function loadApiKey(): Promise<void> {
    try {
        const { readCredential } = await import('./opfs');
        const credKey = await readCredential('openrouter');
        if (credKey && !config.openRouterApiKey) {
            config.openRouterApiKey = credKey;
            await refreshBalance();
            await loadModels();
            return;
        }
        const key = await getPreference("apiKey");
        if (key && !config.openRouterApiKey) {
            await saveApiKey(key);
        }
    } catch (error) {
        ui.displayError(error instanceof Error ? error.message : "Failed to load API key");
    }
}

/**
 * Loads settings from OPFS into config
 * @returns {Promise<void>}
 */
async function loadSettings(): Promise<void> {
    const minPriceStr = await getPreference("minPrice");
    if (minPriceStr) {
        config.minPrice = parseFloat(minPriceStr);
    }

    const maxPriceStr = await getPreference("maxPrice");
    if (maxPriceStr) {
        config.maxPrice = parseFloat(maxPriceStr);
    }

    const approvedModelsStr = await getPreference("approvedModels");
    if (approvedModelsStr) {
        try {
            const parsed = JSON.parse(approvedModelsStr);
            const hasOldFormat = Array.isArray(parsed) && parsed.some(function(id) { return typeof id === 'string' && !id.includes('::'); });
            if (hasOldFormat) {
                config.approvedModelIds = null;
                await deletePreference('approvedModels');
            } else {
                config.approvedModelIds = parsed;
            }
        } catch {
            config.approvedModelIds = null;
        }
    }

    const temperatureStr = await getPreference("temperature");
    if (temperatureStr) {
        const parsed = parseFloat(temperatureStr);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 2) {
            config.temperature = parsed;
        }
    }

    const questionTemperatureStr = await getPreference("questionTemperature");
    if (questionTemperatureStr) {
        const parsed = parseFloat(questionTemperatureStr);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 2) {
            config.questionTemperature = parsed;
        }
    }

    const maxTokensStr = await getPreference("maxTokens");
    if (maxTokensStr) {
        const parsed = parseInt(maxTokensStr, 10);
        if (!isNaN(parsed) && parsed > 0) {
            config.maxTokens = parsed;
        }
    }

    const defaultMyLanguage = await getPreference("defaultMyLanguage");
    if (defaultMyLanguage) {
        config.defaultMyLanguage = defaultMyLanguage;
    }

    const defaultQuestionModel = await getPreference("defaultQuestionModel");
    if (defaultQuestionModel) {
        config.defaultQuestionModel = defaultQuestionModel;
    }

    const defaultQuestionReasoning = await getPreference("defaultQuestionReasoning");
    if (defaultQuestionReasoning) {
        config.defaultQuestionReasoning = defaultQuestionReasoning as ReasoningLevel;
    }

    const defaultWordDefModel = await getPreference("defaultWordDefModel");
    if (defaultWordDefModel) {
        config.defaultWordDefModel = defaultWordDefModel;
    }

    const defaultWordDefReasoning = await getPreference("defaultWordDefReasoning");
    if (defaultWordDefReasoning) {
        config.defaultWordDefReasoning = defaultWordDefReasoning as ReasoningLevel;
    }

    const defaultReasoning = await getPreference("defaultReasoning");
    if (defaultReasoning) {
        config.defaultReasoning = defaultReasoning as ReasoningLevel;
    }

    const defaultInterpretationReasoning = await getPreference("defaultInterpretationReasoning");
    if (defaultInterpretationReasoning) {
        config.defaultInterpretationReasoning = defaultInterpretationReasoning as ReasoningLevel;
    }

    const defaultQuickQuestionReasoning = await getPreference("defaultQuickQuestionReasoning");
    if (defaultQuickQuestionReasoning) {
        config.defaultQuickQuestionReasoning = defaultQuickQuestionReasoning as ReasoningLevel;
    }
}

/**
 * Initializes the application on page load
 * @returns {Promise<void>}
 */
export async function init(): Promise<void> {
    translation.setConfig(config);
    setOpenRouterConfig(config);
    setBackgroundUpdateConfig(config);

    // Initialize sync journal before any storage writes
    const { init: initJournal } = await import('./syncJournal');
    await initJournal();

    await loadSettings();

    await loadUrlApiKey();

    await translation.initializeDefaultSession();

    const savedSessionId = await getPreference('currentSession');
    if (savedSessionId) {
        const sessions = await translation.loadSessionsList();
        if (sessions.some(function(s) { return s.id === savedSessionId; })) {
            await translation.setCurrentSession(savedSessionId);
        }
    }

    await populateSessionSelector();

    translation.setupTranslateButtons();
    translation.setupTextareaKeyHandlers();
    translation.setupDraftAutoSave();
    setupSessionSelectorHandler();
    setupNewSessionButtonHandler();
    settings.setConfig(config);

    settings.setupSettingsButton(document.getElementById("config-button") as HTMLButtonElement);

    const cloudSyncBtn = document.getElementById('cloud-sync-btn') as HTMLButtonElement | null;
    if (cloudSyncBtn) {
        cloudSyncBtn.addEventListener('click', async function() {
            const { triggerManualSync } = await import('./cloudSync');
            await triggerManualSync();
        });
    }

    await loadApiKey();
    await setupAuthButton();

    setSyncReloadCallback(async function(changedPaths: string[]): Promise<void> {
        const currentId = translation.getCurrentSessionId();
        const currentSessionTimestamps: number[] = [];
        let needsSessionList = false;
        let needsConfigReload = false;
        let needsApiKeyReload = false;

        for (const path of changedPaths) {
            if (path.startsWith('sessions/')) {
                const match = path.match(/^sessions\/([^/]+)\/translations\/(\d+)\.json$/);
                if (match) {
                    const sessionId = match[1];
                    const timestamp = parseInt(match[2], 10);
                    if (sessionId === currentId) {
                        currentSessionTimestamps.push(timestamp);
                    }
                }
                needsSessionList = true;
            }
            if (path.startsWith('preferences/')) {
                needsConfigReload = true;
            }
            if (path === 'credentials/openrouter') {
                needsApiKeyReload = true;
            }
        }

        if (needsSessionList) {
            await populateSessionSelector();
        }

        for (const timestamp of currentSessionTimestamps) {
            await translation.appendTranslationFromSync(timestamp);
        }

        if (needsConfigReload) {
            await loadSettings();
            await loadApiKey();
            const qqModel = await getPreference("defaultQuickQuestionModel");
            config.quickQuestionModel = qqModel || null;
            const litModel = await getPreference("defaultLiteralModel");
            config.defaultLiteralModel = litModel || null;
            const intModel = await getPreference("defaultInterpretationModel");
            config.defaultInterpretationModel = intModel || null;
        }

        if (needsApiKeyReload) {
            await loadApiKey();
        }
    });

    await initCloudSync();

    console.log("LLM Translator initialized");
}

/**
 * Sets up the optional Clerk auth button in the toolbar
 * @returns {Promise<void>}
 */
async function setupAuthButton(): Promise<void> {
    const authActive = await initAuth();
    if (!authActive) return;

    const clerk = getClerk()!;
    const authBtn = document.getElementById('auth-btn') as HTMLButtonElement;
    const hasLoggedIn = (await getPreference('clerkHasLoggedIn')) === 'true';

    if (isSignedIn()) {
        authBtn.innerHTML = '<i class="bi bi-box-arrow-right" title="Sign out"></i>';
        await savePreference('clerkHasLoggedIn', 'true');
    } else {
        authBtn.textContent = hasLoggedIn ? 'Log in' : 'Create account';
    }
    authBtn.style.display = '';

    const template = document.getElementById('auth-modal-template') as HTMLTemplateElement;
    const clone = template.content.cloneNode(true) as DocumentFragment;
    document.body.appendChild(clone);
    const modalEl = document.body.querySelector('.modal.fade:last-child') as HTMLElement;
    const modal = new Modal(modalEl as Element);
    const modalBody = modalEl.querySelector('#auth-modal-body') as HTMLElement;

    authBtn.addEventListener('click', async function() {
        if (isSignedIn()) {
            await clerk.signOut();
            window.location.reload();
        } else {
            mountAuthComponent(modalBody, hasLoggedIn ? 'signIn' : 'signUp');
            modal.show();
        }
    });

    modalEl.addEventListener('hidden.bs.modal', async function() {
        modalBody.innerHTML = '';
        if (isSignedIn()) {
            const { initCloudSync } = await import('./cloudSync');
            await initCloudSync();
        }
    });
}

/**
 * Populates the session selector dropdown with available sessions
 * @returns {Promise<void>}
 */
async function populateSessionSelector(): Promise<void> {
    const selector = document.getElementById("session-selector") as HTMLSelectElement | null;
    if (!selector) return;

    const sessions = await translation.loadSessionsList();
    selector.innerHTML = "";

    for (const session of sessions) {
        const option = document.createElement("option");
        option.value = session.id;
        option.textContent = session.name;
        selector.appendChild(option);
    }

    const currentId = translation.getCurrentSessionId();
    selector.value = currentId;
}

/**
 * Sets up the session selector change handler
 * @returns {void}
 */
function setupSessionSelectorHandler(): void {
    const selector = document.getElementById("session-selector") as HTMLSelectElement | null;
    if (!selector) return;

    selector.addEventListener("change", async function(): Promise<void> {
        const newSessionId = selector.value;
        if (newSessionId) {
            await translation.saveCurrentSession();
            await translation.setCurrentSession(newSessionId);
        }
    });
}

/**
 * Sets up the new session button click handler
 * @returns {void}
 */
function setupNewSessionButtonHandler(): void {
    const button = document.getElementById("new-session-btn");
    if (!button) return;

    button.addEventListener("click", async function(): Promise<void> {
        const name = window.prompt("Enter a name for the new conversation:", "New Conversation");
        if (name === null) return; // User cancelled
        await translation.saveCurrentSession();
        const newSessionId = await translation.createSession(name ?? undefined);
        await populateSessionSelector();
        const selector = document.getElementById("session-selector") as HTMLSelectElement | null;
        if (selector) {
            selector.value = newSessionId;
        }
    });
}

init();