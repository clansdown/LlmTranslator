/**
 * Default Translation Tags
 * Hardcoded default tags per language for guiding translation register/formality
 */

import type { TranslationTag } from './types/translationTag';

/**
 * Returns default translation tags for a given language
 * @param {string} languageId - Language identifier (e.g. 'korean', 'japanese')
 * @returns {TranslationTag[]} Array of default tags for that language
 */
export function getDefaultTags(languageId: string): TranslationTag[] {
    switch (languageId) {
        case 'korean':
        case 'ko':
            return [
                {
                    name: 'nida',
                    openTag: '<nida>',
                    closeTag: '</nida>',
                    guidance: 
`Translate the enclosed text using the formal, deferential speech style ending in -ㅂ니다/습니다 (하십시오체). 
Apply this style regardless of the surrounding context, ensuring maximum formality and politeness for 
official or highly respectful settings. Use honorific vocabulary, infixes, and verb forms appropriate for addressing superiors, 
elders, or customers. Also use humble forms for the speaker's own actions when relevant. 
Choose vocabulary appropriate to this style of speech, especially where the original was philosophical, abstract, academic, or precise.`
                },
                {
                    name: 'yo',
                    openTag: '<yo>',
                    closeTag: '</yo>',
                    guidance: 
`Translate the enclosed text using the polite, standard conversational style ending in -요 (해요체). 
Use standard vocabulary appropriate for everyday social interactions and general politeness. 
Use honorific infixes and humble forms where relevant, but the overall tone should be approachable.`
                },
                {
                    name: 'banmal',
                    openTag: '<banmal>',
                    closeTag: '</banmal>',
                    guidance: 
`Translate the enclosed text using the informal/casual style (반말). 
Omit honorific suffixes like -요 or -습니다, addressing the listener as an equal or someone younger.
Use casual verb endings and vocabulary appropriate for close friends, family, or subordinates.`
                }
            ];
        case 'japanese':
        case 'ja':
            return [
                {
                    name: 'sonkeigo',
                    openTag: '<sonkeigo>',
                    closeTag: '</sonkeigo>',
                    guidance: 
`Translate the enclosed text using respectful/honorific language (尊敬語). Use honorific verb
forms (お/ご〜になる, なさる, いらっしゃる, おっしゃる, 召し上がる, ご覧になる) and
honorific noun prefixes (お/ご). Use elevated, formal vocabulary throughout. Avoid contractions
and casual forms. Combine with です/ます endings for complete politeness.`
                },
                {
                    name: 'kenjougo',
                    openTag: '<kenjougo>',
                    closeTag: '</kenjougo>',
                    guidance: 
`Translate the enclosed text using humble language (謙譲語). Use humble verb forms for the
speaker's own actions (お/ご〜する/いたす, 申す, いただく, 参る, おる, 伺う). Lower the
speaker's status through verb choice. Use modest, self-effacing vocabulary. Combine with
です/ます endings for politeness.`
                },
                {
                    name: 'teineigo',
                    openTag: '<teineigo>',
                    closeTag: '</teineigo>',
                    guidance: 
`Translate the enclosed text using standard polite language (丁寧語). Use です/ます verb
endings consistently. Use polite vocabulary appropriate for general social interactions.
This is the neutral polite register — natural and approachable. Use honorific and humble
forms where relevant, but keep the overall tone accessible.`
                },
                {
                    name: 'casual',
                    openTag: '<casual>',
                    closeTag: '</casual>',
                    guidance: 
`Translate the enclosed text using casual/plain speech (常体/タメ口). Use plain/dictionary
verb forms without です/ます. Use casual sentence-ending particles (よ, ね, な, の)
where natural. Use colloquial vocabulary and contracted forms (してる instead of している,
じゃ instead of では). The tone should be informal and intimate.`
                }
            ];
        default:
            return [];
    }
}
