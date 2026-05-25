import { Clerk } from '@clerk/clerk-js';

/** @type {Clerk | null} */
let clerkInstance: Clerk | null = null;
let clerkEnabled = false;

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