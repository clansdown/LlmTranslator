/**
 * Main application initialization module
 */

import { savePreference, getPreference } from './storage';
import { fetchBalance } from './openrouter';
import type { Config } from './types/config';

/**
 * Application configuration object
 * Contains runtime configuration that code will need access to
 */
const config: Config = {
    openRouterApiKey: null
};

/**
 * Displays an error message using a Bootstrap alert
 * @param {string} message - Error message to display
 * @returns {void}
 */
function displayError(message: string): void {
    const template = document.getElementById('error-alert-template') as HTMLTemplateElement | null;
    if (!template) {
        return;
    }
    const clone = template.content.cloneNode(true);
    const container = (clone as DocumentFragment).firstElementChild as HTMLElement;
    const messageSpan = (clone as Element).querySelector('.error-message');
    if (messageSpan) {
        messageSpan.textContent = message;
    }
    document.getElementById('error-container')?.appendChild(container);
}

/**
 * Updates the balance display in the toolbar
 * @param {string} credits - Formatted credits string
 * @returns {void}
 */
function updateBalanceDisplay(credits: string): void {
    const balanceDisplay = document.getElementById('balance-display');
    if (balanceDisplay) {
        balanceDisplay.textContent = "Balance: " + credits;
    }
}

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
        updateBalanceDisplay("$" + balanceInfo.totalCredits.toFixed(2));
    } catch (error) {
        displayError(error instanceof Error ? error.message : "Failed to fetch balance");
    }
}

/**
 * Sets the OpenRouter API key in config and persists it to OPFS
 * @param {string} key - API key to set
 * @returns {Promise<void>}
 * @throws {Error} If saving to OPFS fails
 */
async function setApiKey(key: string): Promise<void> {
    config.openRouterApiKey = key;

    try {
        await savePreference("apiKey", key);
    } catch (error) {
        displayError(error instanceof Error ? error.message : "Failed to save API key");
        throw error;
    }

    await refreshBalance();
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
        displayError(error instanceof Error ? error.message : "Failed to load API key");
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
 * Initializes the application on page load
 * @returns {Promise<void>}
 */
export async function init(): Promise<void> {
    setupApiKeyToggle();
    setupApiKeyInput();
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
