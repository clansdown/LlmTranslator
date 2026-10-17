import { Clerk } from '@clerk/clerk-js';

/**
 * Thrown when an authenticated request fails because the user's Clerk session
 * is missing or has expired. Callers can use this to prompt for a re-login.
 */
export class AuthRequiredError extends Error {
    /**
     * @param {string} message - Human-readable failure reason
     */
    constructor(message: string) {
        super(message);
        this.name = 'AuthRequiredError';
    }
}

/** @type {Clerk | null} */
let clerkInstance: Clerk | null = null;
let clerkEnabled = false;

/** Listeners invoked when Clerk reports an auth-state change (registered before init). */
const pendingAuthStateListeners: Array<() => void> = [];

/** Listeners invoked when an API call reports that a session is required. */
const authRequiredListeners: Array<() => void> = [];

/**
 * Gets the current Clerk session token for API authentication
 * @param {{ skipCache?: boolean }} [options] - Pass skipCache: true to bypass Clerk's internal cache
 * @returns {Promise<string | null>} Session token or null if not signed in
 */
export async function getClerkToken(options?: { skipCache?: boolean }): Promise<string | null> {
    if (!clerkInstance?.isSignedIn || !clerkInstance.session) return null;
    try {
        return await clerkInstance.session.getToken(options);
    } catch (e) {
        console.error('[auth] Failed to get Clerk token:', e);
        return null;
    }
}

/**
 * Checks whether Clerk is available and a publishable key is present
 * @returns {boolean}
 */
export function isClerkEnabled(): boolean {
    return clerkEnabled;
}

/**
 * Initializes Clerk from window.CLERK_PUBLISHABLE_KEY
 * @returns {Promise<boolean>}
 */
export async function initAuth(): Promise<boolean> {
    const publishableKey = (window as any).CLERK_PUBLISHABLE_KEY as string | undefined;
    if (!publishableKey) {
        clerkEnabled = false;
        return false;
    }

    try {
        const clerkDomain = atob(publishableKey.split('_')[2]).slice(0, -1);
        await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`;
            script.async = true;
            script.crossOrigin = 'anonymous';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load @clerk/ui bundle'));
            document.head.appendChild(script);
        });

        const clerk = new Clerk(publishableKey);
        await clerk.load({ ui: { ClerkUI: (window as any).__internal_ClerkUICtor } });
        clerkInstance = clerk;
        clerkEnabled = true;

        // Attach any auth-state listeners registered before initialization.
        for (const listener of pendingAuthStateListeners) {
            clerk.addListener(function() { listener(); });
        }
        pendingAuthStateListeners.length = 0;

        return true;
    } catch (e) {
        console.error('[auth] Clerk init failed:', e);
        clerkEnabled = false;
        return false;
    }
}

/**
 * Returns the Clerk instance
 * @returns {Clerk | null}
 */
export function getClerk(): Clerk | null {
    return clerkInstance;
}

/**
 * Returns whether the user is currently signed in
 * @returns {boolean}
 */
export function isSignedIn(): boolean {
    return clerkInstance?.isSignedIn ?? false;
}

/**
 * Returns the current Clerk user ID, or null if not signed in
 * @returns {string | null}
 */
export function getUserId(): string | null {
    return clerkInstance?.user?.id ?? null;
}

/**
 * Mounts a Clerk sign-in or sign-up component into a container element
 * @param {HTMLElement} element - Container element
 * @param {'signIn' | 'signUp'} mode - Which component to mount
 * @returns {void}
 */
export function mountAuthComponent(element: HTMLElement, mode: 'signIn' | 'signUp'): void {
    if (mode === 'signIn') {
        clerkInstance?.mountSignIn(element as HTMLDivElement);
    } else {
        clerkInstance?.mountSignUp(element as HTMLDivElement);
    }
}

/**
 * Signs the current user out, clearing any stale Clerk session.
 * @returns {Promise<void>} Resolves once Clerk has signed out (best effort)
 */
export async function signOut(): Promise<void> {
    if (!clerkInstance) return;
    try {
        await clerkInstance.signOut();
    } catch (e) {
        console.error('[auth] Sign out failed:', e);
    }
}

/**
 * Registers a listener that runs whenever Clerk reports an auth-state change.
 * If Clerk is not initialized yet the listener is attached once it is.
 * @param {() => void} listener - Callback to invoke on change
 * @returns {void}
 */
export function onAuthStateChanged(listener: () => void): void {
    if (clerkInstance) {
        clerkInstance.addListener(function() { listener(); });
        return;
    }
    pendingAuthStateListeners.push(listener);
}

/**
 * Registers a listener that runs when an authenticated call reports that a
 * session is required (missing or expired).
 * @param {() => void} listener - Callback to invoke
 * @returns {void}
 */
export function onAuthRequired(listener: () => void): void {
    authRequiredListeners.push(listener);
}

/**
 * Notifies listeners that a session is required. Called by modules that talk
 * to authenticated APIs (e.g. cloud sync) when a request fails due to auth.
 * @returns {void}
 */
export function notifyAuthRequired(): void {
    for (const listener of authRequiredListeners) {
        try {
            listener();
        } catch (e) {
            console.error('[auth] onAuthRequired listener failed:', e);
        }
    }
}