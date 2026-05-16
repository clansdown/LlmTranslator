/**
 * Background Update Module
 * Proposes updates to session background text based on conversation history analysis
 */

import { streamSendChatMessage } from './openrouter';
import { listSessionTranslations, loadSession, saveSession } from './storage';
import { BACKGROUND_UPDATE_SYSTEM_PROMPT, BACKGROUND_MERGE_SYSTEM_PROMPT } from './prompts';
import { getModelName } from './translation';
import { Modal } from 'bootstrap';
import type { Config } from './types/config';
import type { Translation } from './types/translation';
import type { TranslationSession } from './types/session';

const MAX_HISTORY_MESSAGES: number = 128;
const REASONING_LABELS: Record<string, string> = {
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Max',
};

/**
 * Gets the friendly display label for a reasoning level
 * @param {string} level - Reasoning level string
 * @returns {string} Friendly label
 */
function getReasoningLabel(level: string): string {
    return REASONING_LABELS[level] ?? level;
}

let config: Config | null = null;
let backgroundUpdateModalOpen: boolean = false;

/**
 * Sets the application configuration
 * @param {Config} appConfig - Application configuration object
 * @returns {void}
 */
export function setConfig(appConfig: Config): void {
    config = appConfig;
}

/**
 * Result from parsing the LLM's analysis response
 */
interface AnalysisResult {
    changes: string;
    additions: string;
    noUpdates: boolean;
}

/**
 * Opens the background update proposal modal and streams LLM analysis
 * @param {string} sessionId - The session ID to analyze
 * @returns {void}
 */
export function showBackgroundUpdateModal(sessionId: string): void {
    if (!sessionId || backgroundUpdateModalOpen) return;

    const template = document.getElementById('background-update-modal-template') as HTMLTemplateElement | null;
    if (!template) return;

    backgroundUpdateModalOpen = true;

    const clone = template.content.cloneNode(true) as DocumentFragment;
    const modalEl = clone.firstElementChild as HTMLElement;
    document.body.appendChild(clone);

    const streamingArea = modalEl.querySelector('.background-update-streaming') as HTMLElement;
    const statusEl = modalEl.querySelector('.background-update-status') as HTMLElement;
    const loadingEl = modalEl.querySelector('.background-update-loading') as HTMLElement;
    const thinkingEl = modalEl.querySelector('.translation-thinking') as HTMLElement;
    const thinkingContentEl = modalEl.querySelector('.thinking-content') as HTMLElement;
    const contentEl = modalEl.querySelector('.background-update-content') as HTMLElement;
    const resultEl = modalEl.querySelector('.background-update-result') as HTMLElement;
    const changesSection = modalEl.querySelector('.proposed-changes-section') as HTMLElement;
    const changesList = modalEl.querySelector('.proposed-changes-list') as HTMLElement;
    const additionsSection = modalEl.querySelector('.proposed-additions-section') as HTMLElement;
    const additionsList = modalEl.querySelector('.proposed-additions-list') as HTMLElement;
    const noticeEl = modalEl.querySelector('.background-update-notice') as HTMLElement;
    const editArea = modalEl.querySelector('.background-update-edit') as HTMLElement;
    const editTextarea = modalEl.querySelector('#background-update-edit-textarea') as HTMLTextAreaElement;
    const mergeBtn = modalEl.querySelector('#background-update-merge-btn') as HTMLButtonElement;
    const editBtn = modalEl.querySelector('#background-update-edit-btn') as HTMLButtonElement;
    const saveBtn = modalEl.querySelector('#background-update-save-btn') as HTMLButtonElement;

    let abortStream: (() => void) | null = null;
    let cleanedUp: boolean = false;
    let oldBackground: string = '';
    let proposedChanges: string = '';
    let proposedAdditions: string = '';

    const modal = new Modal(modalEl);

    /**
     * Cleans up the modal, aborting any active stream
     * @returns {void}
     */
    function cleanup(): void {
        if (cleanedUp) return;
        cleanedUp = true;
        if (abortStream) {
            abortStream();
            abortStream = null;
        }
        modalEl.removeEventListener('hidden.bs.modal', cleanup);
        if (modalEl.isConnected) {
            modalEl.remove();
        }
        backgroundUpdateModalOpen = false;
    }

    /**
     * Shows an error in the modal
     * @param {string} message - Error message to display
     * @returns {void}
     */
    function showError(message: string): void {
        if (statusEl) statusEl.style.display = 'none';
        if (loadingEl) loadingEl.style.display = 'none';
        streamingArea.style.display = 'none';
        resultEl.style.display = 'block';
        changesSection.style.display = 'none';
        additionsSection.style.display = 'none';
        noticeEl.innerHTML = '<div class="alert alert-danger">' + escapeHtml(message) + '</div>';
        noticeEl.style.display = '';
        editArea.style.display = 'none';
        mergeBtn.style.display = 'none';
        editBtn.style.display = 'none';
        saveBtn.style.display = 'none';
    }

    /**
     * Renders file count for sync progress
     * @param {number} current - Current file index
     * @param {number} total - Total file count
     * @returns {void}
     */
    function showNoUpdates(): void {
        streamingArea.style.display = 'none';
        resultEl.style.display = 'block';
        changesSection.style.display = 'none';
        additionsSection.style.display = 'none';
        noticeEl.innerHTML = '<div class="alert alert-info">The LLM reviewed the conversation history and current background. No updates were recommended.</div>';
        noticeEl.style.display = '';
        editArea.style.display = 'none';
        mergeBtn.style.display = 'none';
        editBtn.style.display = 'none';
        saveBtn.style.display = 'none';
    }

    /**
     * Parses an analysis response into structured result
     * @param {string} text - Raw LLM response text
     * @returns {AnalysisResult} Parsed result
     */
    function parseAnalysisResult(text: string): AnalysisResult {
        const changesMatch = text.match(/<PROPOSED_CHANGES>([\s\S]*?)<\/PROPOSED_CHANGES>/i);
        const additionsMatch = text.match(/<PROPOSED_ADDITIONS>([\s\S]*?)<\/PROPOSED_ADDITIONS>/i);

        const changes = changesMatch ? changesMatch[1].trim() : '';
        const additions = additionsMatch ? additionsMatch[1].trim() : '';

        const noUpdates = (
            !changes || changes.includes('No changes') || changes.includes('No additions') ||
            (!additions || additions.includes('No additions') || additions.includes('No changes'))
        ) && (
            !additions || additions.includes('No additions') || additions.includes('No changes') ||
            (!changes || changes.includes('No changes'))
        );

        return { changes, additions, noUpdates };
    }

    /**
     * Formats bullet list text into HTML
     * @param {string} text - Raw bullet list text
     * @returns {string} HTML formatted list
     */
    function formatBulletList(text: string): string {
        if (!text || !text.trim()) return '';

        const lines = text.split('\n').filter(function(line: string) {
            const trimmed = line.trim();
            return trimmed && (trimmed.startsWith('-') || trimmed.startsWith('*'));
        });

        if (lines.length === 0) return '<p class="text-muted">' + escapeHtml(text) + '</p>';

        const items = lines.map(function(line: string) {
            const content = line.replace(/^[-*]\s*/, '');
            return '<li>' + escapeHtml(content) + '</li>';
        });

        return '<ul class="mb-0">' + items.join('') + '</ul>';
    }

    /**
     * Displays parsed proposals in the result area
     * @param {string} changes - Proposed changes text
     * @param {string} additions - Proposed additions text
     * @returns {void}
     */
    function showProposals(changes: string, additions: string): void {
        streamingArea.style.display = 'none';
        resultEl.style.display = 'block';
        noticeEl.style.display = 'none';
        editArea.style.display = 'none';

        const hasChanges = changes && !changes.includes('No changes');
        const hasAdditions = additions && !additions.includes('No additions');

        changesSection.style.display = hasChanges ? '' : 'none';
        if (hasChanges) {
            changesList.innerHTML = formatBulletList(changes);
        }

        additionsSection.style.display = hasAdditions ? '' : 'none';
        if (hasAdditions) {
            additionsList.innerHTML = formatBulletList(additions);
        }

        mergeBtn.style.display = '';
        editBtn.style.display = '';
        saveBtn.style.display = 'none';
    }

    /**
     * Handles auto-merge via LLM: streams merged result for user review
     * @returns {Promise<void>}
     */
    async function handleMerge(): Promise<void> {
        if (!config?.openRouterApiKey) {
            showError('API key not available');
            return;
        }

        const session = await loadSession(sessionId);
        const model = session?.questionModel ?? config?.defaultQuestionModel ?? session?.model;
        if (!model) {
            showError('No model configured for this session');
            return;
        }

        resultEl.style.display = 'none';
        editArea.style.display = 'none';
        streamingArea.style.display = 'block';
        thinkingEl.style.display = '';
        thinkingContentEl.textContent = 'Applying changes...';
        contentEl.style.display = 'none';
        mergeBtn.style.display = 'none';
        editBtn.style.display = 'none';
        saveBtn.style.display = 'none';

        const mergeMessage = 'Current background:\n' + oldBackground + '\n\nProposed changes:\n' + proposedChanges + '\n\nProposed additions:\n' + proposedAdditions + '\n\nProduce a single merged background text.';

        let mergedText: string = '';

        const handle = streamSendChatMessage(
            config.openRouterApiKey,
            mergeMessage,
            BACKGROUND_MERGE_SYSTEM_PROMPT,
            model,
            {
                onChunk: function(fullText: string, _reasoning: string) {
                    mergedText = fullText;
                    if (thinkingEl) thinkingEl.style.display = 'none';
                    if (contentEl) {
                        contentEl.style.display = 'block';
                        contentEl.textContent = fullText;
                    }
                },
                onDone: function(finalText: string, _reasoning: string, _generationId: string | null) {
                    mergedText = finalText;
                    abortStream = null;
                    showEditForReview(mergedText);
                },
                onError: function(error: Error) {
                    abortStream = null;
                    showError('Merge failed: ' + error.message);
                }
            },
            'none',
            0.2
        );

        abortStream = handle.abort;
    }

    /**
     * Shows the edit textarea for manual editing or review
     * @param {string} text - Text to display in the textarea
     * @returns {void}
     */
    function showEditForReview(text: string): void {
        streamingArea.style.display = 'none';
        resultEl.style.display = 'none';
        editArea.style.display = 'block';
        mergeBtn.style.display = 'none';
        editBtn.style.display = 'none';
        saveBtn.style.display = '';
        editTextarea.value = text;
    }

    /**
     * Shows manual edit mode with old background and proposed additions
     * @returns {void}
     */
    function showManualEdit(): void {
        resultEl.style.display = 'none';
        editArea.style.display = 'block';
        mergeBtn.style.display = 'none';
        editBtn.style.display = 'none';
        saveBtn.style.display = '';

        let text: string = oldBackground;
        if (proposedAdditions && !proposedAdditions.includes('No additions') && proposedAdditions.trim()) {
            text += '\n\n--- Proposed Additions ---\n' + proposedAdditions;
        }
        editTextarea.value = text;
    }

    /**
     * Saves the updated background and closes the modal
     * @returns {Promise<void>}
     */
    async function saveAndClose(): Promise<void> {
        const newBackground = editTextarea.value;

        const session = await loadSession(sessionId);
        if (session) {
            session.background = newBackground;
            await saveSession(session);
        }

        const settingsTextarea = document.getElementById('settings-session-background') as HTMLTextAreaElement | null;
        if (settingsTextarea) {
            settingsTextarea.value = newBackground;
        }

        modal.hide();
    }

    /**
     * Builds conversation history for analysis with both source and translation
     * @param {string} sessionId - Session ID
     * @returns {Promise<string>} Formatted history block
     */
    async function buildAnalysisHistory(sessionIdLocal: string): Promise<string> {
        const [inputItems, outputItems, questionItems] = await Promise.all([
            listSessionTranslations(sessionIdLocal, 'input', MAX_HISTORY_MESSAGES),
            listSessionTranslations(sessionIdLocal, 'output', MAX_HISTORY_MESSAGES),
            listSessionTranslations(sessionIdLocal, 'question', MAX_HISTORY_MESSAGES)
        ]);

        const allItems: Translation[] = [...inputItems, ...outputItems, ...questionItems];
        allItems.sort(function(a: Translation, b: Translation): number { return a.timestamp - b.timestamp; });

        const recentItems: Translation[] = allItems.slice(-MAX_HISTORY_MESSAGES);

        let history: string = '<HISTORY>\n';
        for (const t of recentItems) {
            if (!t.entries || t.entries.length === 0) continue;
            const entry = t.entries[t.activeEntryIndex ?? 0];
            if (!entry) continue;

            if (t.pill === 'input') {
                history += '<THEM>' + entry.source + '</THEM>\n';
                if (entry.translation) {
                    history += '<THEM_TRANSLATION>' + entry.translation + '</THEM_TRANSLATION>\n';
                }
            } else if (t.pill === 'output') {
                history += '<ME>' + entry.source + '</ME>\n';
                if (entry.translation) {
                    history += '<ME_TRANSLATION>' + entry.translation + '</ME_TRANSLATION>\n';
                }
            } else if (t.pill === 'question') {
                history += '<USERQUESTION>' + entry.source + '</USERQUESTION>\n';
                if (entry.translation) {
                    history += '<AGENTANSWER>' + entry.translation + '</AGENTANSWER>\n';
                }
            }
        }
        history += '</HISTORY>';

        return history;
    }

    /**
     * Starts the LLM analysis stream
     * @returns {Promise<void>}
     */
    async function startAnalysis(): Promise<void> {
        if (!config?.openRouterApiKey) {
            showError('API key not available');
            return;
        }

        const session = await loadSession(sessionId);
        const model = session?.questionModel ?? config?.defaultQuestionModel ?? session?.model;
        if (!model) {
            showError('No model configured for this session');
            return;
        }
        const reasoningLevel = session?.questionReasoning ?? session?.reasoning ?? 'none';

        oldBackground = session?.background ?? '';
        const history: string = await buildAnalysisHistory(sessionId);

        const userMessage: string = '<BACKGROUND>\n' + oldBackground + '\n</BACKGROUND>\n\n' + history;

        if (loadingEl) loadingEl.style.display = 'none';

        const thinkingLabel = reasoningLevel !== 'none' ? `(${getReasoningLabel(reasoningLevel)} thinking)` : '';
        if (statusEl) {
            statusEl.style.display = '';
            statusEl.textContent = `Analyzing with ${getModelName(model)} ${thinkingLabel}...`;
        }
        if (thinkingEl && thinkingContentEl) {
            thinkingEl.style.display = '';
            thinkingContentEl.textContent = '';
        }

        const handle = streamSendChatMessage(
            config.openRouterApiKey,
            userMessage,
            BACKGROUND_UPDATE_SYSTEM_PROMPT,
            model,
            {
                onChunk: function(fullText: string, reasoning: string): void {
                    if (!fullText.includes('<PROPOSED')) {
                        if (thinkingEl && thinkingContentEl) {
                            thinkingEl.style.display = '';
                            if (reasoning) {
                                thinkingContentEl.textContent = reasoning;
                            }
                        }
                    } else {
                        if (statusEl) statusEl.style.display = 'none';
                        if (thinkingEl) thinkingEl.style.display = 'none';
                    }
                    if (contentEl) {
                        contentEl.style.display = 'block';
                        contentEl.textContent = fullText;
                    }
                },
                onDone: function(finalText: string, _reasoning: string, _generationId: string | null): void {
                    abortStream = null;
                    const result = parseAnalysisResult(finalText);

                    if (result.noUpdates) {
                        showNoUpdates();
                    } else {
                        proposedChanges = result.changes;
                        proposedAdditions = result.additions;
                        showProposals(result.changes, result.additions);
                    }
                },
                onError: function(error: Error): void {
                    abortStream = null;
                    showError('Analysis failed: ' + error.message);
                }
            },
            reasoningLevel,
            0.2
        );

        abortStream = handle.abort;
    }

    // Wire up button handlers
    mergeBtn.addEventListener('click', handleMerge);
    editBtn.addEventListener('click', showManualEdit);
    saveBtn.addEventListener('click', saveAndClose);

    modalEl.addEventListener('hidden.bs.modal', cleanup);
    modal.show();

    if (loadingEl) loadingEl.style.display = '';

    startAnalysis();
}

/**
 * Escapes HTML entities in text
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}