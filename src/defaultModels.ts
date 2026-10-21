/**
 * Default model selection
 *
 * Derives a sensible default model from the fetched model catalogue rather than
 * hardcoding version-specific model ids, which churn frequently. Only the model
 * families and the variants to avoid are declared here; the version is always read
 * from the catalogue.
 */

import { DEBUG_API_CALLS } from './debug';
import type { VisionModel } from './types/api';

/**
 * A model family to search for a default, in priority order.
 * @property {string} family - Human-readable family name, used for logging
 * @property {RegExp} versionPattern - Matches the model id and captures the version, e.g. "4.1"
 * @property {RegExp} excludePattern - Variants of the family that must never be chosen as the default
 */
export interface DefaultModelRule {
    family: string;
    versionPattern: RegExp;
    excludePattern: RegExp;
}

/**
 * Priority-ordered families used to derive a default model.
 */
export const DEFAULT_MODEL_RULES: DefaultModelRule[] = [
    {
        family: 'deepseek-flash',
        versionPattern: /^deepseek\/deepseek-v(\d+(?:\.\d+)?)-flash/,
        excludePattern: /-(vision|exp|audio|image)/
    },
    {
        family: 'gemini-flash',
        versionPattern: /^google\/gemini-(\d+(?:\.\d+)?)-flash/,
        excludePattern: /-(lite|image|tts|audio|live|embedding)/
    },
    {
        family: 'openai-luna',
        versionPattern: /^openai\/gpt-(\d+(?:\.\d+)?)-luna/,
        excludePattern: /-pro/
    }
];

/**
 * Parses a dotted version string into a numeric tuple
 * @param {string} versionText - Version text, e.g. "4.1"
 * @returns {number[]} Numeric tuple, e.g. [4, 1]
 */
function parseVersion(versionText: string): number[] {
    return versionText.split('.').map(function(part: string): number {
        return parseInt(part, 10);
    });
}

/**
 * Compares two numeric version tuples, padding the shorter one with zeroes
 * @param {number[]} firstVersion - First version tuple
 * @param {number[]} secondVersion - Second version tuple
 * @returns {number} Negative when the first is older, positive when newer, zero when equal
 */
function compareVersions(firstVersion: number[], secondVersion: number[]): number {
    const length = Math.max(firstVersion.length, secondVersion.length);
    for (let index = 0; index < length; index++) {
        const difference = (firstVersion[index] ?? 0) - (secondVersion[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

/**
 * Reads a trailing numeric snapshot suffix from a model id
 * @param {string} modelId - Model id, e.g. "deepseek/deepseek-v4.1-flash-1017"
 * @returns {number} Snapshot number, or -1 when the id carries no snapshot suffix
 */
function snapshotSuffix(modelId: string): number {
    const match = modelId.match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : -1;
}

/**
 * Selects the newest model id matching a rule
 * Prefers the highest version, then a dated snapshot, then the shorter id.
 * @param {DefaultModelRule} rule - Family rule to apply
 * @param {string[]} modelIds - Candidate model ids
 * @returns {string | null} The newest matching model id, or null when none match
 */
function selectNewestForRule(rule: DefaultModelRule, modelIds: string[]): string | null {
    const candidates: Array<{id: string, version: number[], snapshot: number}> = [];

    for (const modelId of modelIds) {
        if (rule.excludePattern.test(modelId)) {
            continue;
        }
        const match = modelId.match(rule.versionPattern);
        if (!match) {
            continue;
        }
        candidates.push({
            id: modelId,
            version: parseVersion(match[1]),
            snapshot: snapshotSuffix(modelId)
        });
    }

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort(function(first, second) {
        const versionDifference = compareVersions(second.version, first.version);
        if (versionDifference !== 0) {
            return versionDifference;
        }
        const firstHasSnapshot = first.snapshot >= 0 ? 1 : 0;
        const secondHasSnapshot = second.snapshot >= 0 ? 1 : 0;
        if (firstHasSnapshot !== secondHasSnapshot) {
            return secondHasSnapshot - firstHasSnapshot;
        }
        if (first.snapshot !== second.snapshot) {
            return second.snapshot - first.snapshot;
        }
        if (first.id.length !== second.id.length) {
            return first.id.length - second.id.length;
        }
        return first.id < second.id ? -1 : (first.id > second.id ? 1 : 0);
    });

    return candidates[0].id;
}

/**
 * Derives a default model from the catalogue, trying each family in priority order
 * @param {VisionModel[]} models - Candidate models (the app's approved/filtered list)
 * @returns {string | null} The chosen model id, or null when no rule matched
 */
export function deriveDefaultModel(models: VisionModel[]): string | null {
    const modelIds = models.map(function(model: VisionModel): string {
        return model.id;
    });

    for (const rule of DEFAULT_MODEL_RULES) {
        const selectedModelId = selectNewestForRule(rule, modelIds);
        if (selectedModelId) {
            if (DEBUG_API_CALLS) {
                console.log(`[defaultModels] Default model "${selectedModelId}" chosen from family "${rule.family}"`);
            }
            return selectedModelId;
        }
    }

    return null;
}

/**
 * Inputs for {@link resolveEffectiveModel}
 * @property {string | null} sessionModel - The current session's explicitly chosen model, if any
 * @property {string | null} defaultModel - The "New Conversation Defaults" model preference, if any
 * @property {VisionModel[]} available - Models currently selectable (post price + approval filtering)
 */
export interface ResolveEffectiveModelOptions {
    sessionModel: string | null;
    defaultModel: string | null;
    available: VisionModel[];
}

/**
 * Outcome of {@link resolveEffectiveModel}
 * @property {string | null} model - The effective model id to use, or null when nothing is selectable
 * @property {string | null} missingChoice - Highest-priority recorded choice that was unavailable, if any
 */
export interface ModelResolution {
    model: string | null;
    missingChoice: string | null;
}

/**
 * Resolves the model to use: a recorded choice first, then a derived default
 * @param {ResolveEffectiveModelOptions} options - Recorded choices and candidate models
 * @returns {ModelResolution} Effective model plus any recorded choice that was unavailable
 */
export function resolveEffectiveModel(options: ResolveEffectiveModelOptions): ModelResolution {
    const availableIds = new Set(options.available.map(function(model: VisionModel): string {
        return model.id;
    }));

    let missingChoice: string | null = null;

    if (options.sessionModel) {
        if (availableIds.has(options.sessionModel)) {
            return { model: options.sessionModel, missingChoice: null };
        }
        missingChoice = options.sessionModel;
    }

    if (options.defaultModel) {
        if (availableIds.has(options.defaultModel)) {
            return { model: options.defaultModel, missingChoice: missingChoice };
        }
        if (missingChoice === null) {
            missingChoice = options.defaultModel;
        }
    }

    const derivedModel = deriveDefaultModel(options.available);
    const fallbackModel = options.available.length > 0 ? options.available[0].id : null;

    return { model: derivedModel ?? fallbackModel, missingChoice: missingChoice };
}
