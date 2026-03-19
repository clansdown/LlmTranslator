/**
 * Main application initialization module
 */

import { savePreference, getPreference } from './storage';
import { fetchBalance, fetchZdrModels } from './openrouter';
import * as ui from './ui';
import type { Config } from './types/config';
import type { VisionModel } from './types/api';

/**
 * Application configuration object
 * Contains runtime configuration that code will need access to
 */
const config: Config = {
    openRouterApiKey: null,
    selectedModel: null
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
 * Populates the model dropdown with available ZDR models
 * @param {VisionModel[]} models - Array of available vision models
 * @param {string} [selectedId] - Optional model ID to select by default
 * @returns {void}
 */
function populateModelDropdown(models: VisionModel[], selectedId?: string): void {
    const dropdown = document.getElementById("model-selector") as HTMLSelectElement | null;
    if (!dropdown) {
        return;
    }

    dropdown.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select model...";
    dropdown.appendChild(placeholder);

    for (const model of models) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name;
        dropdown.appendChild(option);
    }

    dropdown.disabled = false;

    if (selectedId && models.some(m => m.id === selectedId)) {
        dropdown.value = selectedId;
        config.selectedModel = selectedId;
    } else if (models.length > 0) {
        dropdown.value = models[0].id;
        config.selectedModel = models[0].id;
        savePreference("selectedModel", models[0].id).catch(() => {});
    }
}

/**
 * Handles model fetch errors by disabling dropdown with error message
 * @returns {void}
 */
function handleModelFetchError(): void {
    const dropdown = document.getElementById("model-selector") as HTMLSelectElement | null;
    if (!dropdown) {
        return;
    }

    dropdown.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Unable to Fetch Models";
    dropdown.appendChild(option);
    dropdown.disabled = true;
}

/**
 * Fetches and loads ZDR models into the dropdown
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
        const models = await fetchZdrModels(apiKey);
        console.log("[loadModels] Fetched models:", models.length, models);
        const savedModelId = await getPreference("selectedModel");
        console.log("[loadModels] Saved model ID:", savedModelId);
        populateModelDropdown(models, savedModelId ?? undefined);
        console.log("[loadModels] Dropdown populated");
    } catch (error) {
        console.error("[loadModels] Error:", error);
        handleModelFetchError();
        ui.displayError(error instanceof Error ? error.message : "Failed to load models");
    }
}

/**
 * Sets the OpenRouter API key in config and persists it to OPFS
 * @param {string} key - API key to set
 * @returns {Promise<void>}
 * @throws {Error} If saving to OPFS fails
 */
async function setApiKey(key: string): Promise<void> {
    console.log("[setApiKey] Called with key length:", key.length);
    config.openRouterApiKey = key;

    try {
        await savePreference("apiKey", key);
    } catch (error) {
        ui.displayError(error instanceof Error ? error.message : "Failed to save API key");
        throw error;
    }

    await refreshBalance();
    console.log("[setApiKey] Calling loadModels...");
    await loadModels();
}

/**
 * Loads the API key from OPFS storage if it exists
 * @returns {Promise<void>}
 */
async function loadApiKey(): Promise<void> {
    try {
        const key = await getPreference("apiKey");
        if (key) {
            await setApiKey(key);
        }
    } catch (error) {
        ui.displayError(error instanceof Error ? error.message : "Failed to load API key");
    }
}

/**
 * Sets up the API key input change handler
 * @returns {void}
 */
function setupApiKeyInput(): void {
    const input = document.getElementById("api-key-input") as HTMLInputElement | null;
    if (!input) {
        return;
    }

    input.addEventListener("change", async function(): Promise<void> {
        const key = input.value.trim();
        if (key) {
            try {
                await setApiKey(key);
            } catch (error) {
                // Error already displayed in setApiKey
            }
        }
    });
}

/**
 * Sets up the model selector dropdown change handler
 * @returns {void}
 */
function setupModelSelector(): void {
    const dropdown = document.getElementById("model-selector") as HTMLSelectElement | null;
    if (!dropdown) {
        return;
    }

    dropdown.addEventListener("change", function(): void {
        const selectedId = dropdown.value;
        if (selectedId) {
            config.selectedModel = selectedId;
            savePreference("selectedModel", selectedId).catch(() => {
                ui.displayError("Failed to save model selection");
            });
        }
    });
}

/**
 * Initializes the application on page load
 * @returns {Promise<void>}
 */
export async function init(): Promise<void> {
    setupApiKeyToggle();
    setupApiKeyInput();
    setupModelSelector();
    await loadApiKey();
    console.log("LLM Translator initialized");
}

/**
 * Sets up the API key visibility toggle button
 * @returns {void}
 */
function setupApiKeyToggle(): void {
    const toggleButton = document.getElementById("toggle-key-visibility");
    const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement | null;

    if (!toggleButton || !apiKeyInput) {
        return;
    }

    toggleButton.addEventListener("click", function(): void {
        const isPassword = apiKeyInput.type === "password";
        apiKeyInput.type = isPassword ? "text" : "password";
        toggleButton.textContent = isPassword ? "🔒" : "👁";
    });
}

init();
