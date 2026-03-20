/**
 * Predefined language options for translation
 */

export interface LanguageOption {
    id: string;
    name: string;
}

/** @type {LanguageOption[]} */
export const LANGUAGES: LanguageOption[] = [
    { id: "english", name: "English" },
    { id: "chinese", name: "Chinese" },
    { id: "korean", name: "Korean" },
    { id: "japanese", name: "Japanese" },
    { id: "spanish", name: "Spanish" },
    { id: "french", name: "French" },
    { id: "german", name: "German" },
    { id: "arabic", name: "Arabic" },
    { id: "portuguese", name: "Portuguese" },
    { id: "russian", name: "Russian" },
    { id: "hindi", name: "Hindi" },
    { id: "italian", name: "Italian" }
];
