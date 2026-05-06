/**
 * Default Translation Tags
 * Hardcoded default tags per language for guiding translation register/formality
 */

import type { TranslationTag } from './types/translationTag';

/**
 * Returns default translation tags for a given language
 * @param {string} languageId - Language identifier (e.g. 'ko', 'ja')
 * @returns {TranslationTag[]} Array of default tags for that language
 */
export function getDefaultTags(languageId: string): TranslationTag[] {
    switch (languageId) {
        case 'ko':
            return [
                {
                    name: 'nida',
                    openTag: '<nida>',
                    closeTag: '</nida>',
                    guidance: `Translate the enclosed text using the formal, deferential speech style ending in -ㅂ니다/습니다 (하십시오체). 
                        Apply this style regardless of the surrounding context, ensuring maximum formality and politeness for 
                        official or highly respectful settings. Use honorific vocabulary, infixes, and verb forms appropriate for addressing superiors, 
                        elders, or customers. Also use humble forms for the speaker's own actions when relevant. This is the most formal and respectful style in Korean.`
                },
                {
                    name: 'yo',
                    openTag: '<yo>',
                    closeTag: '</yo>',
                    guidance: `Translate the enclosed text using the polite, standard conversational style ending in -요 (해요체). 
                    Use standard vocabulary appropriate for everyday social interactions and general politeness.`
                },
                {
                    name: 'banmal',
                    openTag: '<banmal>',
                    closeTag: '</banmal>',
                    guidance: `Translate the enclosed text using the informal/casual style (반말). 
                    Omit honorific suffixes like -요 or -습니다, addressing the listener as an equal or someone younger.`
                }
            ];
        case 'ja':
            return [
                {
                    name: 'sonkeigo',
                    openTag: '<sonkeigo>',
                    closeTag: '</sonkeigo>',
                    guidance: 'Use respectful language (尊敬語). Elevates the status of the person being spoken about. For customers, superiors, or those deserving respect.'
                },
                {
                    name: 'kenjougo',
                    openTag: '<kenjougo>',
                    closeTag: '</kenjougo>',
                    guidance: 'Use humble language (謙譲語). Lowers the speaker\'s own status. For speaking about yourself or your group to outsiders.'
                },
                {
                    name: 'teineigo',
                    openTag: '<teineigo>',
                    closeTag: '</teineigo>',
                    guidance: 'Use polite language (丁寧語). Standard polite register using -masu/desu forms. Safe default for most situations.'
                },
                {
                    name: 'casual',
                    openTag: '<casual>',
                    closeTag: '</casual>',
                    guidance: 'Use casual/plain language (常体/タメ口). No -masu/desu endings. For friends, family, or subordinates.'
                }
            ];
        default:
            return [];
    }
}
