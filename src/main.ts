/**
 * Main application initialization module
 */

import { savePreference, getPreference } from './storage';
import { fetchBalance, fetchZdrModels } from './openrouter';
import * as ui from './ui';
import * as settings from './settings';
import * as translation from './translation';
import type { Config } from './types/config';

/**
 * Application configuration object
 * Contains runtime configuration that code will need access to
 */
const config: Config = {
    openRouterApiKey: null,
    selectedModel: null,
    minPrice: null,
    maxPrice: null,
    selectedPromptId: null
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
        ui.updateBalanceDisplay("$" + balanceInfo.totalCredits.toFixed(2));
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
    console.log("[loadModels] Called, apiKey:", apiKey ? "exists" : "null");
    if (!apiKey) {
        console.log("[loadModels] No API key, returning early");
        return;
    }

    try {
        console.log("[loadModels] Fetching ZDR models...");
        let models = await fetchZdrModels(apiKey);
        console.log("[loadModels] Fetched models:", models.length, models);
        models = settings.filterModelsByPrice(models);
        console.log("[loadModels] Models after price filter:", models.length);

        settings.setModels(models);
        translation.setModelNameMap(models);

        const savedModelId = await getPreference("selectedModel");
        console.log("[loadModels] Saved model ID:", savedModelId);
        if (savedModelId && models.some(function(m) { return m.id === savedModelId; })) {
            config.selectedModel = savedModelId;
            translation.updateButtonStates();
        } else if (models.length > 0) {
            config.selectedModel = models[0].id;
            savePreference("selectedModel", models[0].id).catch(function() {});
            translation.updateButtonStates();
        }
        console.log("[loadModels] Dropdown populated");
    } catch (error) {
        console.error("[loadModels] Error:", error);
        ui.displayError(error instanceof Error ? error.message : "Failed to load models");
    }
}

/**
 * Saves the API key to config and storage
 * @param {string} key - API key to save
 * @returns {Promise<void>}
 */
export async function saveApiKey(key: string): Promise<void> {
    console.log("[saveApiKey] Saving API key, length:", key.length);
    config.openRouterApiKey = key;
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

    console.log("[loadUrlApiKey] Found key in URL");

    params.delete('key');
    const newUrl = window.location.pathname +
        (params.toString() ? '?' + params.toString() : '') +
        window.location.hash;
    history.replaceState(null, '', newUrl);

    if (!config.openRouterApiKey) {
        try {
            await saveApiKey(urlKey);
            console.log("[loadUrlApiKey] API key set from URL");
        } catch (error) {
            ui.displayError(error instanceof Error ? error.message : "Failed to set API key from URL");
        }
    } else {
        console.log("[loadUrlApiKey] API key already set, ignoring URL key");
    }
}

/**
 * Loads the API key from OPFS storage if it exists
 * @returns {Promise<void>}
 */
async function loadApiKey(): Promise<void> {
    try {
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

    const selectedPromptId = await getPreference("selectedPrompt");
    if (selectedPromptId) {
        config.selectedPromptId = selectedPromptId;
    }
}

/**
 * Initializes the application on page load
 * @returns {Promise<void>}
 */
export async function init(): Promise<void> {
    translation.setConfig(config);

    await loadSettings();

    await loadUrlApiKey();

    await translation.initializeDefaultSession();
    await populateSessionSelector();

    const sessions = await translation.loadSessionsList();
    if (sessions.length > 0) {
        const currentId = translation.getCurrentSessionId();
        const session = sessions.find(function(s) { return s.id === currentId; });
        if (session) {
            if (session.inputLanguage) {
                translation.populateLanguageDropdowns(session.inputLanguage);
            }
        }
    }

    translation.setupLanguageDropdownHandlers();
    translation.setupTranslateButtons();
    translation.setupTextareaKeyHandlers();
    setupSessionSelectorHandler();
    setupNewSessionButtonHandler();
    await translation.loadTranslationHistory();

    settings.setConfig(config);
    await settings.initializeDefaultPromptsIfNeeded();
    await settings.loadPromptsIntoMemory();

    settings.setupSettingsButton(document.getElementById("config-button") as HTMLButtonElement);
    settings.setupPromptDropdown();
    settings.updatePromptDropdown();

    await loadApiKey();
    console.log("LLM Translator initialized");
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