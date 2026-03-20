/**
 * Translation prompt templates
 * Hardcoded instructional text appended to all translation prompts
 */

/**
 * Instructional text appended to all translation prompts
 * Ensures clean output without explanations
 */
const INSTRUCTIONAL_TEXT: string = "\n\nOnly output the translated text, no explanations or additional commentary.";

/**
 * Prompt template for input pane (translate foreign text to user's language)
 * [LANGUAGE] placeholder is replaced with selected language at runtime
 */
export const INPUT_PROMPT_TEMPLATE: string = 
    "Translate the user's text into [LANGUAGE]:" + INSTRUCTIONAL_TEXT;

/**
 * Prompt template for output pane (translate user's text to target language)
 * [PROMPT] placeholder is replaced with the selected prompt's content at runtime
 */
export const OUTPUT_PROMPT_TEMPLATE: string = 
    "[PROMPT]" + INSTRUCTIONAL_TEXT;
