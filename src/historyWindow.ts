/**
 * History Window Module
 * Pure helpers for grouping translation timestamps into active days and for
 * selecting the timestamps that fall within a chosen set of days.
 * An "active day" is a calendar day (local time) on which at least one
 * translation was recorded; active days are not necessarily contiguous.
 */

/**
 * Returns the local-midnight start of the day containing a timestamp
 * @param {number} timestamp - Milliseconds since epoch
 * @returns {number} Milliseconds since epoch at local midnight of that day
 */
export function getDayStart(timestamp: number): number {
    return new Date(timestamp).setHours(0, 0, 0, 0);
}

/**
 * Groups timestamps into the distinct days on which they occurred
 * @param {number[]} timestamps - Milliseconds since epoch
 * @returns {number[]} Day starts (local midnight) with activity, newest first
 */
export function groupTimestampsByDay(timestamps: number[]): number[] {
    const days = new Set<number>();
    for (const timestamp of timestamps) {
        days.add(getDayStart(timestamp));
    }
    return Array.from(days).sort(function(a: number, b: number): number { return b - a; });
}

/**
 * Selects the timestamps that fall on any of the given days
 * @param {number[]} timestamps - Milliseconds since epoch
 * @param {number[]} days - Day starts (local midnight) to include
 * @returns {number[]} Timestamps on those days, in the order supplied
 */
export function selectTimestampsInDays(timestamps: number[], days: number[]): number[] {
    const daySet = new Set<number>(days);
    return timestamps.filter(function(timestamp: number): boolean {
        return daySet.has(getDayStart(timestamp));
    });
}
