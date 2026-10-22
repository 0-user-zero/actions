// What the action does, in order:
//   0. Asks User Zero whether the site, test login, credits and tunnels are in order (pre-flight), before anything is booted.
//   1. Works out what was merged (the pull request behind this commit) and whether it should be tested.
//   2. Waits for your app to answer on localhost.
//   3. Opens a tunnel to it (outbound only) that only User Zero's tester can use, and checks User Zero can reach the app.
//   4. Starts a QA session about the merged change and waits for it to finish.
//   5. Writes the results to this job's summary and comments them on the merged pull request.
// With "dry-run: true" it checks the setup instead of testing: after step 3 a short session only signs in with the test
// login and stops. Nothing is tested. It is how you check the workflow.
// The test login, if passed, goes to User Zero with the one run that needs it; it is used for that session and not kept.
// Your source code is never sent anywhere. User Zero receives the pull request's title, description, number and
// commit, and the HTTP traffic of your running app.
import {
    ApiError,
    UserError,
    addSummary,
    errorAnnotation,
    github,
    globToRegExp,
    input,
    log,
    mask,
    notice,
    readEvent,
    requiredInput,
    saveState,
    setOutput,
    sleep,
    userZero,
    warning,
    group,
    withRetries,
} from './lib.mjs';
import { ensureCloudflared, startTunnel, stopTunnel } from './cloudflared.mjs';
import { NO_LOGIN_TO_CHECK, appNeverAnswered, explainApiError, explainLoginCheck, explainOutcome, explainStartPage, normalizeSite, tunnelNeverReachable } from './explain.mjs';
import { resolveLogin } from './login.mjs';
import { buildScope } from './scope.mjs';

const FINISHED_STATES = ['rendering', 'in_review', 'delivered', 'failed', 'needs_input', 'rejected', 'canceled'];
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const LEVEL_ICON = { ok: '✓', warn: '⚠', fail: '✗' };
const LEVEL_EMOJI = { ok: '✅', warn: '⚠️', fail: '❌' };
const CHECK_LABEL = { site: 'Site', login: 'Test login', credits: 'Credits', tunnels: 'Tunnels' };

async function main() {
    const apiKey = requiredInput('api-key');
    mask(apiKey);
    const rawSite = requiredInput('site');
    const site = normalizeSite(rawSite);
    if (site !== rawSite.toLowerCase()) notice(`Read the "site" input "${rawSite}" as ${site}: it should be just the host.`);
    const port = Number(requiredInput('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError(`The "port" input must be a port number like 3000, got "${input('port')}".`);
    const path = input('path', '/').startsWith('/') ? input('path', '/') : `/${input('path', '/')}`;
    const failOn = input('fail-on', 'none').toLowerCase();
    if (!['none', 'high', 'any'].includes(failOn)) throw new UserError(`The "fail-on" input must be none, high or any, got "${failOn}".`);
    const dryRun = input('dry-run', 'false').toLowerCase() === 'true';
    const login = input('login');
    const loginCheck = input('login-check', 'true').toLowerCase() !== 'false';
    // The test login: passed here from the repository's own secrets, or saved in User Zero. Never both.
    const passedLogin = resolveLogin(input);
    if (passedLogin) {
        mask(passedLogin.password);
        mask(passedLogin.email);
    }
    if (passedLogin && login) throw new UserError('Use either "login-email" and "login-password", or "login" (the name of a login saved in User Zero), not both.');
    const loginFields = passedLogin ? { login: passedLogin } : login ? { credentialName: login } : {};

    const uz = userZero(input('api-url', 'https://api.user-zero.com'), apiKey);
    const gh = github(input('github-token'));
    const repo = process.env.GITHUB_REPOSITORY;
    const sha = process.env.GITHUB_SHA;

    if (dryRun) log('Dry run: checking your setup. Nothing will be tested and no credit is used.');

    // 0. Everything that can be checked without booting anything.
    const checks = await runPreflight(uz, site, login, Boolean(passedLogin));

    // 1. What was merged, and should it be tested? (A dry run has no change to test.)
    let change = null;
    let scope = '';
    if (!dryRun) {
        change = await describeChange(gh, repo, sha);
        const skip = await skipReason(gh, repo, change);
        if (skip) {
            notice(`Not testing this change: ${skip}`);
            addSummary(`### User Zero\nNot tested: ${skip}`);
            return;
        }
        scope = buildScope(change, input('scope'));
        if (!scope) {
            notice('Not testing this change: there is no pull request behind it and the commit message is too short to know what to test. Set the "scope" input to say what to test.');
            return;
        }
        log(change.pr ? `Testing PR #${change.pr.number} "${change.pr.title}"` : `Testing commit ${sha.slice(0, 7)}`);
        group('What was sent to User Zero', [
            change.pr ? `Pull request: #${change.pr.number} ${change.pr.title}` : 'Pull request: none (testing the commit message)',
            `Commit: ${sha}`,
            `Site: ${site}`,
            `Start page: ${path}`,
            'Test login: from your own secrets (never printed)',
            'No code and no diff. The tester is asked to test:',
            '',
            scope,
        ]);
    }

    // 2. Your app must be up before anything is opened or charged.
    const app = await waitForApp(port, path, Number(input('wait-timeout', '180')) * 1000);
    log(`✓ app is up on localhost:${port} (HTTP ${app.status} after ${app.seconds}s)`);
    const appHint = explainStartPage(app.status, path, 'localhost');
    if (appHint) warning(appHint);

    // 3. The tunnel. Its id is saved first, so the cleanup step closes it whatever happens next.
    const tunnel = await withRetries(() => uz('POST', '/ci/tunnels', { port }), {
        onRetry: (err, attempt, wait) => warning(`User Zero could not open the tunnel (${err.detail}). Trying again in ${wait / 1000} seconds (attempt ${attempt + 1} of 3).`),
    });
    mask(tunnel.connectorToken);
    saveState('tunnel_id', tunnel.tunnelId);
    const binary = await ensureCloudflared();
    const { pid } = await startTunnel(binary, tunnel.connectorToken);
    saveState('cloudflared_pid', pid);
    const reach = await waitForTunnel(uz, tunnel.tunnelId, path);
    log(`✓ tunnel open: User Zero reached your app through it (${reach.detail})`);
    const tunnelHint = explainStartPage(reach.status, path, 'the tunnel');
    if (tunnelHint) warning(tunnelHint);

    if (dryRun) {
        // The tunnel stays open for the sign-in check, which is a short real session that only signs in.
        const signIn = await runSignInCheck(uz, { tunnel, path, site, passedLogin, loginFields, checks, enabled: loginCheck, repo, sha });
        await closeTunnel(uz, pid, tunnel.tunnelId);
        const hints = [appHint, tunnelHint].filter(Boolean);
        addSummary(dryRunMarkdown({ checks, app, reach, port, path, hints, signIn }));
        if (signIn.level === 'fail') throw new UserError(`${signIn.title}. ${signIn.detail}`);
        const warned = hints.length > 0 || signIn.level === 'warn' || checks.some((c) => c.level === 'warn');
        log(
            warned
                ? '✓ Dry run passed, with the warnings above.'
                : `✓ Dry run passed. Your workflow starts your app, User Zero reaches it${signIn.level === 'ok' ? ', and the tester can sign in' : ''}. Nothing was tested.`,
        );
        setOutput('dry-run', warned ? 'passed-with-warnings' : 'passed');
        return;
    }

    // 4. The session.
    const workflowRunUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    const run = await uz('POST', '/runs', {
        targetUrl: `https://${tunnel.hostname}${path}`,
        siteHost: site,
        tunnelId: tunnel.tunnelId,
        scope,
        summarizeScope: scope.length > 1500,
        ...loginFields,
        source: {
            provider: 'github',
            repo,
            sha,
            ...(change.pr ? { prNumber: change.pr.number, prUrl: change.pr.html_url, prTitle: change.pr.title.slice(0, 300) } : {}),
            ...(branchOf(change) ? { branch: branchOf(change) } : {}),
            ...(process.env.GITHUB_ACTOR ? { actor: process.env.GITHUB_ACTOR.slice(0, 100) } : {}),
            workflowRunUrl,
        },
    });
    saveState('run_id', run.runId);
    setOutput('run-id', run.runId);
    log(`✓ session ${run.runId} started — testing ${change.pr ? `PR #${change.pr.number}` : sha.slice(0, 7)}`);

    const finished = await waitForRun(uz, run.runId, 'testing');
    saveState('run_finished', '1');

    // The tunnel is no longer needed once the session is over; post.mjs closes it too if this fails.
    await closeTunnel(uz, pid, tunnel.tunnelId);

    // 5. Results.
    await report(gh, repo, change, finished, workflowRunUrl, { site, login, inline: Boolean(passedLogin) });
    const bugs = finished.findings ?? [];
    setOutput('bug-count', bugs.length);
    if (finished.reportUrl) setOutput('report-url', finished.reportUrl);

    // A session that could not start testing because of something in your setup (the login, mostly) fails the job, so it is noticed.
    if (finished.state === 'needs_input') process.exitCode = 1;
    const failing = failOn === 'any' ? bugs : failOn === 'high' ? bugs.filter((b) => b.severity === 'critical' || b.severity === 'high') : [];
    if (failing.length > 0) {
        process.exitCode = 1;
        errorAnnotation(`${failing.length} ${failOn === 'high' ? 'critical or high ' : ''}bug(s) found (fail-on: ${failOn}).`);
    }
}

/** The branch the change came from: the pull request's own branch, else the one that was pushed. */
const branchOf = (change) => (change.pr?.head?.ref || process.env.GITHUB_REF_NAME || '').slice(0, 250);

/** The checks User Zero can make before anything is booted; a failed one stops the job with what to change. */
async function runPreflight(uz, site, login, inline) {
    let result;
    try {
        result = await uz('GET', `/ci/preflight?site=${encodeURIComponent(site)}${login ? `&login=${encodeURIComponent(login)}` : ''}${inline ? '&inline=1' : ''}`);
    } catch (err) {
        // A User Zero server without the pre-flight route: carry on, the later steps report their own problems.
        if (err instanceof ApiError && err.status === 404) {
            notice('This User Zero server has no pre-flight check yet; continuing without it.');
            return [];
        }
        throw err;
    }
    for (const c of result.checks) log(`${LEVEL_ICON[c.level]} ${c.message}`);
    for (const c of result.checks.filter((x) => x.level === 'warn')) warning(c.message);
    const failed = result.checks.filter((c) => c.level === 'fail');
    // Each message already says what to change.
    if (failed.length > 0) throw new UserError(failed.map((c) => c.message).join('\n'));
    return result.checks;
}

/**
 * Stage 2 of a dry run: a short real session that only signs in with the test login and stops. It is what shows the
 * login works against the app in CI, which is the most likely first failure. No test is run.
 */
async function runSignInCheck(uz, { tunnel, path, site, passedLogin, loginFields, checks, enabled, repo, sha }) {
    if (!enabled) return { level: 'skipped', title: 'Sign-in check skipped', detail: 'The "login-check" input is false.' };
    const savedLoginKnown = checks.some((c) => c.name === 'login' && c.level === 'ok');
    if (!passedLogin && !savedLoginKnown && checks.length > 0) {
        // The pre-flight already warned about the missing login; this only records that sign-in was not checked.
        log('… sign-in not checked: there is no test login');
        return { level: 'warn', title: 'Sign-in not checked', detail: NO_LOGIN_TO_CHECK };
    }
    const workflowRunUrl = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
    const run = await uz('POST', '/runs', {
        targetUrl: `https://${tunnel.hostname}${path}`,
        siteHost: site,
        tunnelId: tunnel.tunnelId,
        scope: 'sign-in check',
        setupCheck: true,
        ...loginFields,
        source: { provider: 'github', repo, sha, workflowRunUrl },
    });
    saveState('run_id', run.runId);
    log('✓ sign-in check started: the tester opens your app and signs in with the test login (about a minute)');
    const finished = await waitForRun(uz, run.runId, 'signing in');
    saveState('run_finished', '1');
    const result = explainLoginCheck(finished, { site, inline: Boolean(passedLogin), path });
    const line = `${result.title}. ${result.detail}`;
    if (result.level === 'ok') log(`✓ ${line}`);
    else if (result.level === 'warn') warning(line);
    return result;
}

async function closeTunnel(uz, pid, tunnelId) {
    stopTunnel(pid);
    await uz('DELETE', `/ci/tunnels/${tunnelId}`).catch((err) => warning(`could not close the tunnel now (it closes on its own): ${err.message}`));
    saveState('tunnel_closed', '1');
}

/** The pull request merged as this commit, if any, and the commit message. */
async function describeChange(gh, repo, sha) {
    const event = readEvent();
    if (event.pull_request) return { pr: event.pull_request, message: event.pull_request.title, event };
    let pr = null;
    try {
        const pulls = await gh('GET', `/repos/${repo}/commits/${sha}/pulls`);
        pr = pulls.find((p) => p.merge_commit_sha === sha) ?? pulls.find((p) => p.merged_at) ?? null;
    } catch (err) {
        warning(`could not look up the pull request for ${sha.slice(0, 7)}: ${err.message}`);
    }
    return { pr, message: event.head_commit?.message ?? '', event };
}

/** Why this change is not worth testing, or null to test it. */
async function skipReason(gh, repo, change) {
    const skipLabel = input('skip-label', 'no-qa');
    if (change.pr && skipLabel && (change.pr.labels ?? []).some((l) => l.name === skipLabel)) return `the pull request has the "${skipLabel}" label`;

    const globs = input('ignore-paths', '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
        .map(globToRegExp);
    if (globs.length === 0) return null;
    const files = await changedFiles(gh, repo, change);
    if (!files || files.length === 0) return null;
    return files.every((f) => globs.some((re) => re.test(f))) ? 'only files matched by "ignore-paths" changed' : null;
}

/** Names of the files the change touched, read with the workflow's token; null when they can't be read. */
async function changedFiles(gh, repo, change) {
    try {
        if (change.pr) {
            const files = [];
            for (let page = 1; page <= 10; page++) {
                const batch = await gh('GET', `/repos/${repo}/pulls/${change.pr.number}/files?per_page=100&page=${page}`);
                files.push(...batch.map((f) => f.filename));
                if (batch.length < 100) break;
            }
            return files;
        }
        const before = change.event.before;
        if (!before || /^0+$/.test(before)) return null;
        const compare = await gh('GET', `/repos/${repo}/compare/${before}...${process.env.GITHUB_SHA}`);
        return (compare.files ?? []).map((f) => f.filename);
    } catch (err) {
        warning(`could not list the changed files, testing anyway: ${err.message}`);
        return null;
    }
}

async function waitForApp(port, path, timeoutMs) {
    const url = `http://localhost:${port}${path}`;
    const started = Date.now();
    const deadline = started + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
        try {
            // Any answer means the server is up, even an error page: the tester decides what is wrong with it.
            const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
            await res.body?.cancel().catch(() => undefined);
            return { status: res.status, seconds: Math.round((Date.now() - started) / 1000) };
        } catch (err) {
            lastError = err.cause?.code ?? err.message;
        }
        await sleep(2000);
    }
    throw new UserError(appNeverAnswered({ url, seconds: Math.round(timeoutMs / 1000), lastError, port }));
}

async function waitForTunnel(uz, tunnelId, path) {
    const tries = 20;
    let last = null;
    let lastDetail = '';
    for (let attempt = 1; attempt <= tries; attempt++) {
        last = await uz('GET', `/ci/tunnels/${tunnelId}/check?path=${encodeURIComponent(path)}`).catch((err) => ({ reachable: false, detail: err instanceof ApiError ? explainApiError(err) : err.message }));
        if (last.reachable) return last;
        if (last.detail !== lastDetail) {
            log(`… waiting for the tunnel: ${last.detail}`);
            lastDetail = last.detail;
        }
        await sleep(3000);
    }
    throw new UserError(tunnelNeverReachable(tries, last?.detail ?? 'no answer'));
}

/** What the job log says about each stage, in words a customer can use: no internal counters or state names. */
const STAGES = { queued: 'waiting for a free slot', dispatching: 'starting the tester', rendering: 'preparing the report' };

async function waitForRun(uz, runId, label) {
    let lastLine = '';
    let testingSince = 0;
    for (;;) {
        const run = await uz('GET', `/runs/${runId}`).catch((err) => {
            // A blip in the API must not end a session that is going fine.
            warning(`could not read the session's state, retrying: ${err.message}`);
            return null;
        });
        if (run) {
            let line;
            if (run.state === 'running') {
                testingSince ||= Date.now();
                // A line every two minutes: enough to see it is alive, not a stream.
                const minutes = Math.floor((Date.now() - testingSince) / 120_000) * 2;
                line = minutes > 0 ? `… ${label} (${minutes} min so far)` : `… ${label}`;
            } else {
                line = `… ${STAGES[run.state] ?? run.state}`;
            }
            if (line !== lastLine) log(line);
            lastLine = line;
            if (FINISHED_STATES.includes(run.state)) return run;
        }
        await sleep(15_000);
    }
}

async function report(gh, repo, change, run, workflowRunUrl, ctx) {
    const bugs = [...(run.findings ?? [])].sort((a, b) => rank(a.severity) - rank(b.severity));
    const ended = ['failed', 'needs_input', 'canceled', 'rejected'].includes(run.state);
    const outcome = ended ? explainOutcome(run, ctx) : null;
    const markdown = resultMarkdown(change, run, bugs, workflowRunUrl, outcome);
    addSummary(markdown);

    if (outcome) {
        const text = `${outcome.title}. ${outcome.detail}`;
        if (run.state === 'needs_input') errorAnnotation(text);
        else warning(text);
    } else {
        log(`✓ done — ${bugs.length} bug(s)${run.reportUrl ? ` · ${run.reportUrl}` : ''}`);
    }

    if (change.pr && input('comment', 'true') === 'true' && run.state !== 'canceled') {
        try {
            const comment = await gh('POST', `/repos/${repo}/issues/${change.pr.number}/comments`, { body: markdown });
            log(`✓ commented on #${change.pr.number}: ${comment.html_url}`);
        } catch (err) {
            warning(`could not comment on #${change.pr.number}: ${err.status === 403 || err.status === 404 ? 'the workflow needs "pull-requests: write" permission' : err.message}`);
        }
    }
}

const rank = (severity) => {
    const i = SEVERITY_ORDER.indexOf(severity);
    return i === -1 ? SEVERITY_ORDER.length : i;
};

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function resultMarkdown(change, run, bugs, workflowRunUrl, outcome) {
    const what = change.pr ? `PR #${change.pr.number} · ${cell(change.pr.title)}` : `commit ${process.env.GITHUB_SHA.slice(0, 7)}`;
    const lines = [`### 🧪 User Zero tested ${change.pr ? 'this merge' : 'this push'}`, '', `**${what}**`, ''];
    if (outcome) {
        lines.push(`⚠️ **${outcome.title}.** ${outcome.detail}`);
    } else if (bugs.length === 0) {
        lines.push('✅ No bugs found.');
    } else {
        const counts = SEVERITY_ORDER.map((s) => [s, bugs.filter((b) => b.severity === s).length]).filter(([, n]) => n > 0);
        lines.push(`Found **${bugs.length} bug${bugs.length === 1 ? '' : 's'}** (${counts.map(([s, n]) => `${n} ${s}`).join(', ')})`, '');
        lines.push('| Severity | Bug |', '|---|---|');
        for (const bug of bugs.slice(0, 15)) lines.push(`| ${cell(bug.severity)} | **${cell(bug.title)}** — ${cell(bug.summary).slice(0, 300)} |`);
        if (bugs.length > 15) lines.push('', `…and ${bugs.length - 15} more in the report.`);
    }
    lines.push('');
    if (run.reportUrl) lines.push(`**[Open the full report →](${run.reportUrl})**`, '');
    lines.push(`<sub>Tested on localhost in [this workflow run](${workflowRunUrl}); User Zero never received your code.</sub>`);
    return lines.join('\n');
}

function dryRunMarkdown({ checks, app, reach, port, path, hints, signIn }) {
    const rows = checks.map((c) => `| ${CHECK_LABEL[c.name] ?? c.name} | ${LEVEL_EMOJI[c.level]} ${cell(c.message)} |`);
    rows.push(`| Your app | ✅ Answered HTTP ${app.status} on localhost:${port}${path} after ${app.seconds}s. |`);
    rows.push(`| Tunnel | ✅ User Zero reached your app through it: ${cell(reach.detail)}. |`);
    const signInEmoji = { ok: '✅', warn: '⚠️', fail: '❌', skipped: '➖' }[signIn.level];
    rows.push(`| Sign-in | ${signInEmoji} ${cell(`${signIn.title}. ${signIn.detail}`)} |`);
    const lines = ['### User Zero dry run', '', '| Check | Result |', '|---|---|', ...rows, ''];
    if (hints.length > 0) lines.push(...hints.map((h) => `⚠️ ${cell(h)}`), '');
    lines.push(
        signIn.level === 'fail'
            ? '**The dry run did not pass.** Fix what is marked above and run it again. Nothing was tested.'
            : '**Your setup works:** the workflow starts your app, User Zero reaches it' + (signIn.level === 'ok' ? ', and the tester can sign in.' : '.') + ' Nothing was tested.',
    );
    return lines.join('\n');
}

main().catch((err) => {
    if (err instanceof UserError) errorAnnotation(err.message);
    else if (err instanceof ApiError) errorAnnotation(explainApiError(err, { apiUrl: input('api-url', 'https://api.user-zero.com') }));
    else {
        errorAnnotation(`Unexpected failure: ${err.message}. This is a bug in the action; contact User Zero support with this job's log.`);
        console.error(err);
    }
    process.exitCode = 1;
});
