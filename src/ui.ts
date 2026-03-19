/**
 * UI Helper Functions Module
 * Contains all UI manipulation and display functions
 */

/**
 * Displays an error message using a Bootstrap alert
 * @param {string} message - Error message to display
 * @returns {void}
 */
export function displayError(message: string): void {
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
export function updateBalanceDisplay(credits: string): void {
    const balanceDisplay = document.getElementById('balance-display');
    if (balanceDisplay) {
        balanceDisplay.textContent = "Balance: " + credits;
    }
}

/**
 * Updates the sync button visual state
 * @param {boolean} enabled - Whether sync is enabled
 * @param {boolean} syncing - Whether currently syncing
 * @param {boolean} [needsReauth] - Whether re-authorization is needed
 * @returns {void}
 */
export function updateSyncButton(enabled: boolean, syncing: boolean, needsReauth?: boolean): void {
    // TODO: Implement sync button UI updates
}

/**
 * Shows the sync progress indicator
 * @param {number} current - Current progress count
 * @param {number} total - Total items to sync
 * @returns {void}
 */
export function showSyncProgress(current: number, total: number): void {
    // TODO: Implement sync progress display
}

/**
 * Hides the sync progress indicator
 * @param {boolean} [complete] - Whether sync completed successfully
 * @returns {void}
 */
export function hideSyncProgress(complete?: boolean): void {
    // TODO: Implement hiding sync progress
}
