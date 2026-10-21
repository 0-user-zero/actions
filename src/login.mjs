// Where the test login comes from: the action's inputs, or the environment variables a workflow may already set.
// It is passed to User Zero with the one run that needs it. User Zero uses it for that session only and does not keep it.
import { UserError } from './lib.mjs';

/** `getInput(name)` reads an action input ('' when unset). Returns { email, password }, or null when no login was passed. */
export function resolveLogin(getInput, env = process.env) {
    const email = getInput('login-email') || env.USERZERO_LOGIN_EMAIL || '';
    const password = getInput('login-password') || env.USERZERO_LOGIN_PASSWORD || '';
    if (!email && !password) return null;
    if (!email || !password) {
        throw new UserError(
            `Only the ${email ? 'email' : 'password'} of the test login was given: set both "login-email" and "login-password" (or the USERZERO_LOGIN_EMAIL and USERZERO_LOGIN_PASSWORD environment variables). If you pass them as secrets, check the secret exists in this repository: an unset secret is an empty string.`,
        );
    }
    return { email, password };
}
