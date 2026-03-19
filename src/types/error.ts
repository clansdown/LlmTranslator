/**
 * Detailed error information from API responses
 */
export interface ErrorInfo {
    message: string;
    status?: number;
    code?: string;
    type?: string;
    rawResponse?: string;
    timestamp?: number;
}

/**
 * Type guard to check if an object is ErrorInfo
 */
export function isErrorInfo(value: unknown): value is ErrorInfo {
    if (typeof value !== 'object' || value === null) return false;
    const err = value as ErrorInfo;
    return typeof err.message === 'string';
}
