/**
 * Translation Tag data types
 */

/**
 * A translation tag definition for guiding LLM register/formality
 * @property {string} name - Tag name without brackets, e.g. "nida"
 * @property {string} openTag - Opening tag, e.g. "<nida>"
 * @property {string} closeTag - Closing tag, e.g. "</nida>"
 * @property {string} guidance - Instruction text sent to the LLM
 */
export interface TranslationTag {
    name: string;
    openTag: string;
    closeTag: string;
    guidance: string;
}
