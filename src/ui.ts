/**
 * UI Helper Functions Module
 * Contains all UI manipulation and display functions
 */

import { STATE } from './state';

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
        balanceDisplay.textContent = credits;
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

/**
 * Updates the cloud sync UI elements (toolbar button icon/state)
 * @returns {void}
 */
export function updateCloudSyncUI(): void {
    const btn = document.getElementById('cloud-sync-btn') as HTMLButtonElement | null;
    if (!btn) return;

    const sync = STATE.cloudSync;

    if (!sync.enabled) {
        btn.style.display = 'none';
        return;
    }

    btn.style.display = '';

    if (sync.isSyncing) {
        btn.textContent = '↻';
        btn.className = 'btn btn-outline-warning btn-sm';
        btn.disabled = true;
    } else if (sync.lastError) {
        btn.textContent = '!';
        btn.className = 'btn btn-outline-danger btn-sm';
        btn.disabled = false;
        btn.title = 'Sync error: ' + sync.lastError;
    } else if (sync.lastSyncTime) {
        const minutesAgo = Math.floor((Date.now() - new Date(sync.lastSyncTime).getTime()) / 60000);
        if (minutesAgo > 10) {
            btn.textContent = '↑';
            btn.className = 'btn btn-outline-info btn-sm';
            btn.title = 'Last synced ' + minutesAgo + ' min ago';
        } else {
            btn.textContent = '☁';
            btn.className = 'btn btn-outline-success btn-sm';
            btn.title = 'Synced ' + minutesAgo + ' min ago';
        }
        btn.disabled = false;
    } else {
        btn.textContent = '☁';
        btn.className = 'btn btn-outline-secondary btn-sm';
        btn.title = 'Never synced';
        btn.disabled = false;
    }
}
