/**
 * Translation data types
 */

export interface Translation {
    id: string;
    source: string;
    translation: string;
    model: string;
    modelName: string;
    prompt: string;
    promptContent: string;
    timestamp: number;
    status: 'pending' | 'complete' | 'error';
    error: string | null;
}
