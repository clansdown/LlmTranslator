/**
 * Clerk authentication UI.
 *
 * Owns the toolbar auth button and the sign-in/sign-up modal. The button doubles
 * as the log-in affordance: when a session is missing or has expired it renders
 * as a prominent "Log in" button, and clicking it re-authenticates the user.
 *
 * The modal is only ever opened in response to a user click — nothing pops it up
 * automatically.
 */
import { Modal } from 'bootstrap';
import { initAuth, isSignedIn, signOut, mountAuthComponent, onAuthRequired, onAuthStateChanged } from './auth';
import { STATE } from './state';
import { getPreference, savePreference } from './storage';
import { initCloudSync } from './cloudSync';

/** Clerk sign-in/sign-up modal, created during {@link initAuthUi}. */
let authModal: Modal | null = null;

/** Element the Clerk component is mounted into. */
let authModalBody: HTMLElement | null = null;

/** Whether the user has signed in before (selects sign-in vs sign-up). */
let hasLoggedIn: boolean = false;

/**
 * Opens the Clerk sign-in/sign-up modal.
 * @param {'signIn' | 'signUp'} mode - Which Clerk component to mount
 * @returns {void}
 */
export function openAuthModal(mode: 'signIn' | 'signUp'): void {
    if (!authModal || !authModalBody) return;
    mountAuthComponent(authModalBody, mode);
    authModal.show();
}

/**
 * Updates the toolbar auth button to reflect the current authentication state.
 * Renders as "Log in" when the session is missing, expired, or a cloud-sync
 * call has reported that a session is required.
 * @returns {void}
 */
export function setAuthButtonState(): void {
    const authBtn = document.getElementById('auth-btn') as HTMLButtonElement | null;
    if (!authBtn) return;

    const needsReauth: boolean = STATE.cloudSync.needsReauth;

    if (isSignedIn() && !needsReauth) {
        authBtn.className = 'btn btn-outline-secondary btn-sm';
        authBtn.innerHTML = '<i class="bi bi-box-arrow-right" title="Sign out"></i>';
        authBtn.title = '';
    } else {
        authBtn.className = 'btn btn-outline-danger btn-sm';
        authBtn.textContent = hasLoggedIn ? 'Log in' : 'Create account';
        authBtn.title = needsReauth ? 'Session expired — log in again' : '';
    }
}

/**
 * Handles a click on the toolbar auth button: sign out when signed in, or open
 * the sign-in modal (clearing any stale session first).
 * @returns {Promise<void>}
 */
async function handleAuthButtonClick(): Promise<void> {
    if (isSignedIn() && !STATE.cloudSync.needsReauth) {
        await signOut();
        window.location.reload();
        return;
    }

    // Session missing or expired — clear any stale session, then offer sign-in.
    if (isSignedIn()) {
        await signOut();
    }
    openAuthModal(hasLoggedIn ? 'signIn' : 'signUp');
}

/**
 * Initializes the Clerk auth UI: the toolbar button and the sign-in modal.
 * No-op when Clerk is not configured.
 * @returns {Promise<void>}
 */
export async function initAuthUi(): Promise<void> {
    const authActive = await initAuth();
    if (!authActive) return;

    hasLoggedIn = (await getPreference('clerkHasLoggedIn')) === 'true';

    const template = document.getElementById('auth-modal-template') as HTMLTemplateElement | null;
    const authBtn = document.getElementById('auth-btn') as HTMLButtonElement | null;
    if (!template || !authBtn) return;

    // Capture references before inserting the clone into the DOM.
    const clone = template.content.cloneNode(true) as DocumentFragment;
    const modalEl = clone.firstElementChild as HTMLElement;
    authModalBody = modalEl.querySelector('#auth-modal-body') as HTMLElement;
    document.body.appendChild(clone);
    authModal = new Modal(modalEl);

    authBtn.addEventListener('click', function() {
        handleAuthButtonClick().catch(function(e) {
            console.error('[authUi] Auth button handler failed:', e);
        });
    });
    authBtn.style.display = '';

    modalEl.addEventListener('hidden.bs.modal', async function() {
        if (authModalBody) authModalBody.innerHTML = '';
        if (isSignedIn()) {
            STATE.cloudSync.needsReauth = false;
            hasLoggedIn = true;
            await savePreference('clerkHasLoggedIn', 'true');
            setAuthButtonState();
            await initCloudSync();
        }
    });

    // Keep the button in sync with Clerk's own auth state, and with any module
    // (e.g. cloud sync) that reports a session is required.
    onAuthStateChanged(function() { setAuthButtonState(); });
    onAuthRequired(function() { setAuthButtonState(); });

    if (isSignedIn()) {
        await savePreference('clerkHasLoggedIn', 'true');
    }
    setAuthButtonState();
}
