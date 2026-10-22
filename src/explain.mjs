// What a person reads when something goes wrong. Each message says what happened, the likely cause, and what to
// change, because the reader is editing a workflow file, not using User Zero. Pure functions, so they are tested
// without a network or a runner (test/explain.test.mjs).

export const SUPPORT = 'contact User Zero support';

/** What the "site" input should have been when someone pastes an address: "https://App.Acme.com:443/login" becomes "app.acme.com". */
export function normalizeSite(raw) {
    const withoutScheme = String(raw).trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    return (withoutScheme.split(/[/?#]/)[0] ?? '').replace(/:\d+$/, '');
}

/** A failed call to the User Zero API (an ApiError from lib.mjs). */
export function explainApiError(err, ctx = {}) {
    const detail = String(err.detail ?? '').trim();
    if (err.network) {
        return `Could not reach the User Zero API at ${ctx.apiUrl ?? 'the "api-url" input'} (${detail}). Check the "api-url" input, and that the runner has internet access.`;
    }
    switch (err.status) {
        case 400:
            return `User Zero did not accept the request${detail ? ` (${detail})` : ''}. An input probably has the wrong shape: "site" is just a host like app.acme.com, "port" a number, "login" the name of a saved login.`;
        case 401:
            return 'User Zero rejected the API key. Check that the USERZERO_API_KEY repository secret exists, is passed to this action as "api-key", and was not revoked in User Zero. Keys made in a different User Zero environment do not work against this "api-url".';
        case 402:
            return 'Your User Zero account has no run credits left, so nothing was tested. Ask your account manager for more.';
        case 403:
            return /suspended/i.test(detail) ? 'Your User Zero account is suspended, so nothing can be tested. Contact support.' : `User Zero refused the request: ${detail || 'forbidden'}.`;
        case 404:
            return `User Zero does not know "${err.method} ${err.path}". If this action is pinned to an old version, update it.`;
        case 422:
            if (/not enabled for this account/i.test(detail)) return `${detail}. Check the spelling of the "site" input, or ask your account manager to approve the site.`;
            if (/not an open tunnel/i.test(detail)) return 'The tunnel closed before the session could start. Re-run the job; if it repeats, the start-up is taking too long.';
            return `User Zero could not start the session: ${detail}.`;
        case 429:
            return `${detail || 'Too many tunnels are open'}.`;
        case 503:
            if (/not set up/i.test(detail)) return `CI tunnels are not enabled on this User Zero server yet (${detail}). Contact support.`;
        // falls through
        case 500:
        case 502:
        case 504:
            return `User Zero had a problem on its side (${detail || `HTTP ${err.status}`}). Nothing was charged. Run the job again, and ${SUPPORT} if it keeps failing.`;
        default:
            return `User Zero answered HTTP ${err.status} to ${err.method} ${err.path}${detail ? `: ${detail}` : ''}.`;
    }
}

/** The app never answered on its port. */
export function appNeverAnswered({ url, seconds, lastError, port }) {
    return [
        `Your app never answered on ${url} within ${seconds}s (last error: ${lastError}).`,
        'Common causes:',
        ' • The step that starts your app runs it in the foreground, so the job never gets here. Start it in the background: "npm start &", or "docker compose up -d --wait".',
        ` • It listens on a different port than the "port" input (${port}).`,
        ' • It crashed while starting: read the log of the step that starts it.',
        ` • It needs longer than ${seconds}s to build or start: raise the "wait-timeout" input.`,
    ].join('\n');
}

/** What a start page's status means for testing, or null when there is nothing to say. `via` is "localhost" or "the tunnel". */
export function explainStartPage(status, path, via) {
    if (status === 404) return `Your app answered HTTP 404 on "${path}". Set the "path" input to a page that exists, like / or /login.`;
    if ((status === 400 || status === 403) && via === 'the tunnel') {
        return `Your app answered HTTP ${status} on "${path}" through the tunnel, but not on localhost. Frameworks that check the Host header refuse an address they do not know: allow tunnel hosts (ci-*.user-zero.com) in Django ALLOWED_HOSTS, Rails config.hosts, or Vite server.allowedHosts, or all hosts in CI.`;
    }
    if (status === 401) return `Your app answered HTTP 401 on "${path}". That is fine if people sign in on another page; if not, set the "path" input to a page that needs no login.`;
    if (status >= 500) return `Your app answered HTTP ${status} on "${path}" ${via === 'the tunnel' ? 'through the tunnel' : 'on localhost'}: it is up but erroring. Check its logs in the step that starts it; the tester would see the same errors.`;
    return null;
}

export function cloudflaredDownloadFailed(url, reason) {
    return `Could not download cloudflared, the tunnel client, from ${url} (${reason}). The runner needs to reach github.com. If your network blocks it, allow it for this job, or re-run later.`;
}

export function cloudflaredChecksum(got) {
    return `The cloudflared download did not match its expected checksum (got ${got}), so it was not run. Re-run the job; if it repeats, update this action to a newer version or ${SUPPORT}.`;
}

export function tunnelNotConnected(seconds, logTail, exitCode) {
    const headline = exitCode === undefined || exitCode === null ? `cloudflared did not connect to Cloudflare within ${seconds}s.` : `cloudflared stopped with exit code ${exitCode} before it connected.`;
    // When cloudflared says plainly what is wrong, say that instead of the generic network advice.
    const hints = /token is not valid/i.test(logTail)
        ? [' • User Zero gave cloudflared a tunnel token it rejected. That is a problem on User Zero\u2019s side, not in your workflow: contact support with this log.']
        : [
              ' • On GitHub-hosted runners this is rare: re-run the job.',
              ' • On self-hosted runners or behind a firewall, allow outbound connections to Cloudflare on port 7844 (TCP and UDP).',
          ];
    return [headline, ...hints, 'The last lines of its log:', logTail].join('\n');
}

export function tunnelNeverReachable(tries, detail) {
    return [`User Zero could not reach your app through the tunnel (tried ${tries} times). The last answer: ${detail}`, 'Your app answers on localhost, so this is about the path between the tunnel and the app; the answer above says which part.'].join('\n');
}

/**
 * Why a session ended without a report, in the same words the client portal uses (client-portal/src/outcomes.ts),
 * plus what to change in CI. `run` is GET /runs/:id; `ctx` is { site, login }.
 */
export function explainOutcome(run, ctx = {}) {
    const site = ctx.site ?? 'your site';
    const login = ctx.login ? `"${ctx.login}"` : 'the saved login';
    // The run's own error text is shown only where it was written for a customer (what the app said at sign-in, why a scope was
    // rejected). For a failure on our side it is an internal note ("no heartbeat…"), so it stays out of their log.
    const forCustomers = run.outcomeCode === 'login_failed' || run.outcomeCode === 'scope_rejected';
    const evidence = forCustomers && run.error ? ` (${String(run.error).replace(/[.\s]+$/, '')})` : '';
    if (run.state === 'canceled') return { title: 'The session was canceled', detail: 'It was stopped before it finished, for example because the job was canceled.' };
    switch (run.outcomeCode) {
        case 'login_failed':
            return {
                title: 'The tester could not sign in',
                detail: `It tried ${ctx.inline ? 'the login you passed' : login} on ${site} and the app refused it${evidence}. In CI your app starts from an empty database: make sure the seed step creates this user with the same email and password ${ctx.inline ? 'you pass to this action (use the same repository secrets in both places)' : 'saved in User Zero'}. Run this action with "dry-run" to check it without testing anything. No credit was used.`,
            };
        case 'login_second_step':
            return {
                title: 'The login asks for an extra step',
                detail: `${site} asked for a verification step, such as a code or a captcha, that the tester cannot complete. Save a login for a test user without it in User Zero, or turn that step off in CI. No credit was used.`,
            };
        case 'login_missing':
            return {
                title: ctx.inline ? 'The login expired before the session started' : 'The saved login was removed',
                detail: ctx.inline
                    ? 'The login passed to this action waited too long for its session to start and was discarded. Re-run the job. No credit was used.'
                    : `The saved login ${login} was removed from User Zero before the session started. Add it again, then re-run the job. No credit was used.`,
            };
        case 'scope_rejected':
            return {
                title: "The change couldn't be turned into something to test",
                detail: `What the pull request says was not enough to test${evidence}. Describe what a user can now do in the pull request, or pass the "scope" input. No credit was used.`,
            };
        default:
            return { title: 'The session did not finish', detail: `Something went wrong${evidence || ' on User Zero’s side'}. No credit was used. Re-run the job, and ${SUPPORT} if it repeats.` };
    }
}

/** What a dry run's sign-in check found. `run` is GET /runs/:id for the check; `ctx` is { site, inline, path }. */
export function explainLoginCheck(run, ctx = {}) {
    if (run.state === 'needs_input') {
        const outcome = explainOutcome(run, ctx);
        return { level: 'fail', title: outcome.title, detail: outcome.detail };
    }
    if (run.state === 'failed' || run.state === 'rejected') {
        const outcome = explainOutcome(run, ctx);
        return { level: 'fail', title: `The sign-in check could not run: ${outcome.title.toLowerCase()}`, detail: outcome.detail };
    }
    if (run.state === 'canceled') {
        return { level: 'warn', title: 'The sign-in check was canceled', detail: 'It was stopped before it finished, so sign-in was not checked. Run the dry run again.' };
    }
    if (run.loginUsed === true) {
        return { level: 'ok', title: 'Signed in', detail: `The tester typed the test login into your app and reached a signed-in page${ctx.inline ? '' : ' (using the login saved in User Zero)'}.` };
    }
    return {
        level: 'warn',
        title: 'Signed in was not confirmed',
        detail: `The tester finished without using the login. Your start page "${ctx.path ?? '/'}" may not need one, or the tester could not find the sign-in form. Set the "path" input to your sign-in page and run the dry run again; skip this check with "login-check: false" if your app has no login.`,
    };
}

export const NO_LOGIN_TO_CHECK = 'There is no test login to check: pass "login-email" and "login-password" (from repository secrets), or save a login for the site in User Zero. The tester would start signed out and could only test pages that need no login.';
