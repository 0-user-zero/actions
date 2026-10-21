// Run with: node --test integrations/github-action/test/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, UserError, globToRegExp, group, withRetries } from '../src/lib.mjs';
import { resolveLogin } from '../src/login.mjs';
import {
    appNeverAnswered,
    cloudflaredChecksum,
    cloudflaredDownloadFailed,
    explainApiError,
    explainLoginCheck,
    explainOutcome,
    explainStartPage,
    normalizeSite,
    tunnelNeverReachable,
    tunnelNotConnected,
} from '../src/explain.mjs';

const api = (status, detail, over = {}) => new ApiError(over.method ?? 'POST', over.path ?? '/runs', status, detail, over.network ?? false);

test('normalizeSite reads a pasted address as the host', () => {
    assert.equal(normalizeSite('app.acme.com'), 'app.acme.com');
    assert.equal(normalizeSite('  HTTPS://App.Acme.com:8443/login?x=1#y '), 'app.acme.com');
    assert.equal(normalizeSite('http://localhost:3000'), 'localhost');
});

test('API errors say what to change', () => {
    assert.match(explainApiError(api(401, 'invalid or revoked API token')), /USERZERO_API_KEY.*"api-key".*revoked/s);
    assert.match(explainApiError(api(402, 'org has no remaining run credits')), /no run credits left.*account manager/s);
    assert.match(explainApiError(api(403, 'org is suspended')), /suspended.*Contact support/s);
    assert.match(explainApiError(api(422, 'evil.test is not enabled for this account — contact support to add it')), /Check the spelling of the "site" input/);
    assert.match(explainApiError(api(422, 'tunnelId is not an open tunnel of this account')), /tunnel closed before the session could start/);
    assert.match(explainApiError(api(429, 'this account already has 5 CI tunnels open (the limit is 5)')), /5 CI tunnels open.*limit is 5/s);
    assert.match(explainApiError(api(503, 'CI tunnels are not set up on this server', { path: '/ci/tunnels' })), /not enabled on this User Zero server/);
    assert.match(explainApiError(api(502, 'could not open a tunnel, try again')), /problem on its side.*Nothing was charged.*Run the job again/s);
    assert.match(explainApiError(api(500, '')), /HTTP 500/);
    assert.match(explainApiError(api(400, 'invalid request body {"siteHost":["a hostname"]}')), /"site" is just a host like app\.acme\.com/);
    assert.match(explainApiError(api(404, 'HTTP 404', { method: 'GET', path: '/ci/preflight' })), /GET \/ci\/preflight.*update it/s);
    assert.match(explainApiError(api(418, 'teapot')), /HTTP 418.*teapot/);
});

test('an unreachable API names the address and what to check', () => {
    const err = api(0, 'ENOTFOUND', { network: true });
    assert.match(explainApiError(err, { apiUrl: 'https://api.example.test' }), /Could not reach the User Zero API at https:\/\/api\.example\.test \(ENOTFOUND\).*"api-url".*internet access/s);
});

test('an app that never answers gets the common causes, with the real port and timeout', () => {
    const text = appNeverAnswered({ url: 'http://localhost:3000/', seconds: 180, lastError: 'ECONNREFUSED', port: 3000 });
    assert.match(text, /never answered on http:\/\/localhost:3000\/ within 180s \(last error: ECONNREFUSED\)/);
    assert.match(text, /foreground.*npm start &.*docker compose up -d --wait/s);
    assert.match(text, /different port than the "port" input \(3000\)/);
    assert.match(text, /"wait-timeout"/);
});

test('start page statuses are explained, and only when they matter', () => {
    assert.match(explainStartPage(404, '/', 'localhost'), /"path" input/);
    assert.match(explainStartPage(403, '/', 'the tunnel'), /Host header.*ALLOWED_HOSTS.*config\.hosts.*allowedHosts/s);
    assert.equal(explainStartPage(403, '/', 'localhost'), null, 'a 403 on localhost is the app, not the tunnel');
    assert.match(explainStartPage(500, '/', 'the tunnel'), /erroring.*logs/s);
    assert.match(explainStartPage(401, '/', 'localhost'), /fine if people sign in on another page/);
    assert.equal(explainStartPage(200, '/', 'the tunnel'), null);
    assert.equal(explainStartPage(302, '/', 'the tunnel'), null, 'a redirect to a login page is normal');
});

test('tunnel and download problems say what to try', () => {
    assert.match(tunnelNotConnected(90, 'line1\nline2'), /did not connect to Cloudflare within 90s.*7844.*line1\nline2/s);
    assert.match(tunnelNotConnected(90, 'x', 1), /stopped with exit code 1 before it connected/);
    const badToken = tunnelNotConnected(90, 'Provided Tunnel token is not valid.', 255);
    assert.match(badToken, /exit code 255.*problem on User Zero.s side.*Provided Tunnel token is not valid/s);
    assert.doesNotMatch(badToken, /port 7844/, 'a rejected token is not a firewall problem');
    assert.match(tunnelNeverReachable(20, 'nothing answered on localhost:3000'), /tried 20 times.*nothing answered on localhost:3000/s);
    assert.match(cloudflaredDownloadFailed('https://example.test/c', 'ENOTFOUND'), /reach github\.com/);
    assert.match(cloudflaredChecksum('abc'), /did not match.*abc.*not run/s);
});

test('session outcomes use the portal wording plus what to change in CI', () => {
    const ctx = { site: 'app.acme.com', login: 'Admin' };
    const loginFailed = explainOutcome({ state: 'needs_input', outcomeCode: 'login_failed', error: 'the form said the password was wrong.' }, ctx);
    assert.equal(loginFailed.title, 'The tester could not sign in');
    assert.match(loginFailed.detail, /"Admin" on app\.acme\.com.*seed step creates this user.*dry-run.*No credit was used/s);
    assert.match(explainOutcome({ state: 'needs_input', outcomeCode: 'login_second_step' }, ctx).detail, /code or a captcha.*test user without it/s);
    assert.match(explainOutcome({ state: 'failed', outcomeCode: 'login_missing' }, ctx).detail, /"Admin" was removed/);
    assert.match(explainOutcome({ state: 'needs_input', outcomeCode: 'scope_rejected', error: 'Too vague.' }, ctx).detail, /not enough to test \(Too vague\).*"scope" input/s);
    const ourSide = explainOutcome({ state: 'failed', outcomeCode: 'our_error' }, ctx);
    assert.match(ourSide.detail, /No credit was used.*Re-run the job/s);
    assert.equal(explainOutcome({ state: 'canceled' }, ctx).title, 'The session was canceled');
    assert.match(explainOutcome({ state: 'needs_input', outcomeCode: 'login_failed' }, { site: 'x.test' }).detail, /the saved login on x\.test/);
});

test('ignore-paths globs', () => {
    const cases = [
        ['**/*.md', 'README.md', true],
        ['**/*.md', 'docs/a/b.md', true],
        ['docs/**', 'docs/x/y.ts', true],
        ['docs/**', 'src/docs.ts', false],
        ['.github/**', '.github/workflows/a.yml', true],
        ['*.md', 'a/b.md', false],
    ];
    for (const [glob, file, want] of cases) assert.equal(globToRegExp(glob).test(file), want, `${glob} vs ${file}`);
});

test('the test login comes from inputs, then the environment, and must be complete', () => {
    const from = (inputs) => (name) => inputs[name] ?? '';
    assert.equal(resolveLogin(from({}), {}), null, 'no login at all is allowed: a saved one is used');
    assert.deepEqual(resolveLogin(from({ 'login-email': 'a@b.test', 'login-password': 'pw' }), {}), { email: 'a@b.test', password: 'pw' });
    assert.deepEqual(resolveLogin(from({}), { USERZERO_LOGIN_EMAIL: 'e@x.test', USERZERO_LOGIN_PASSWORD: 'p2' }), { email: 'e@x.test', password: 'p2' }, 'environment variables work');
    assert.deepEqual(resolveLogin(from({ 'login-email': 'in@x.test' }), { USERZERO_LOGIN_EMAIL: 'env@x.test', USERZERO_LOGIN_PASSWORD: 'p3' }), { email: 'in@x.test', password: 'p3' }, 'an input wins over the environment, per field');
    assert.throws(() => resolveLogin(from({ 'login-email': 'a@b.test' }), {}), (err) => err instanceof UserError && /Only the email .* set both.*unset secret is an empty string/s.test(err.message));
    assert.throws(() => resolveLogin(from({ 'login-password': 'pw' }), {}), /Only the password/);
});

test('the sign-in check says whether the tester signed in, and what to do if not', () => {
    const ctx = { site: 'app.acme.com', inline: true, path: '/' };
    const ok = explainLoginCheck({ state: 'delivered', loginUsed: true }, ctx);
    assert.equal(ok.level, 'ok');
    assert.match(ok.detail, /typed the test login into your app and reached a signed-in page/);
    assert.doesNotMatch(ok.detail, /saved in User Zero/, 'a login passed in is not described as saved');
    assert.match(explainLoginCheck({ state: 'delivered', loginUsed: true }, { ...ctx, inline: false }).detail, /login saved in User Zero/);

    const unsure = explainLoginCheck({ state: 'delivered', loginUsed: false }, { ...ctx, path: '/home' });
    assert.equal(unsure.level, 'warn');
    assert.match(unsure.detail, /without using the login.*"\/home".*"path" input.*login-check: false/s);
    assert.equal(explainLoginCheck({ state: 'delivered', loginUsed: null }, ctx).level, 'warn', 'not knowing is a warning, not a pass');

    const rejected = explainLoginCheck({ state: 'needs_input', outcomeCode: 'login_failed', error: 'the form said the password was wrong' }, ctx);
    assert.equal(rejected.level, 'fail');
    assert.match(rejected.detail, /the login you passed.*seed step creates this user.*you pass to this action.*same repository secrets/s);
    assert.match(explainLoginCheck({ state: 'needs_input', outcomeCode: 'login_failed' }, { ...ctx, inline: false }).detail, /saved in User Zero/);
    assert.match(explainLoginCheck({ state: 'needs_input', outcomeCode: 'login_second_step' }, ctx).detail, /code or a captcha/);

    const broke = explainLoginCheck({ state: 'failed', outcomeCode: 'our_error', error: 'x' }, ctx);
    assert.equal(broke.level, 'fail');
    assert.match(broke.title, /could not run/);
    assert.equal(explainLoginCheck({ state: 'canceled' }, ctx).level, 'warn');
    assert.match(explainOutcome({ state: 'failed', outcomeCode: 'login_missing' }, { ...ctx, inline: true }).detail, /waited too long.*discarded/s, 'an expired passed-in login is explained as expired, not removed');
});

import { buildScope } from '../src/scope.mjs';

test('the workflow instructions come first and the commit message is only context', () => {
    const scope = buildScope({ message: 'reduce time to 5 min', pr: null }, 'Test signing in and the Sessions list.');
    assert.ok(scope.startsWith('Test signing in and the Sessions list.'));
    assert.match(scope, /For context, the change that was just pushed/);
    assert.match(scope, /ignore it and test the instructions above/);
});

test('without workflow instructions the change itself is what gets tested', () => {
    const scope = buildScope({ message: 'Add the refund button to orders', pr: null }, '');
    assert.equal(scope, 'Test the change that was just pushed: "Add the refund button to orders".');
});

test('a very short commit message and no instructions gives an empty scope', () => {
    assert.equal(buildScope({ message: 'wip', pr: null }, ''), '');
});

test('a merged pull request is context when instructions exist and the task otherwise', () => {
    const change = { message: '', pr: { number: 12, title: 'Bump deps', body: 'Routine.' } };
    assert.match(buildScope(change, 'Check checkout.'), /^Check checkout\.\n\nFor context, the change that was just merged is pull request #12/);
    assert.match(buildScope(change, ''), /^Test the change that was just merged in pull request #12: "Bump deps"/);
});

test('a server error is tried again, then passed on after the last attempt', async () => {
    let calls = 0;
    const waits = [];
    const ok = await withRetries(
        async () => {
            calls++;
            if (calls < 3) throw new ApiError('POST', '/ci/tunnels', 502, 'could not open a tunnel');
            return 'opened';
        },
        { delaysMs: [0, 0], onRetry: (err, attempt, wait) => waits.push([attempt, wait]) },
    );
    assert.equal(ok, 'opened');
    assert.equal(calls, 3);
    assert.deepEqual(waits, [[1, 0], [2, 0]]);

    let always = 0;
    await assert.rejects(
        withRetries(async () => { always++; throw new ApiError('POST', '/ci/tunnels', 503, 'busy'); }, { delaysMs: [0, 0] }),
        (err) => err.status === 503,
    );
    assert.equal(always, 3);
});

test('a network failure is tried again, a refused request is not', async () => {
    let network = 0;
    assert.equal(
        await withRetries(async () => { if (++network < 2) throw new ApiError('POST', '/ci/tunnels', 0, 'ECONNRESET', true); return 'ok'; }, { delaysMs: [0] }),
        'ok',
    );
    let refused = 0;
    await assert.rejects(withRetries(async () => { refused++; throw new ApiError('POST', '/ci/tunnels', 401, 'rejected the API key'); }, { delaysMs: [0] }), (err) => err.status === 401);
    assert.equal(refused, 1);
    let other = 0;
    await assert.rejects(withRetries(async () => { other++; throw new Error('not an API error'); }, { delaysMs: [0] }), /not an API error/);
    assert.equal(other, 1);
});

test('text from a pull request cannot act as a workflow command in the log', () => {
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(line);
    try {
        group('What was sent', ['plain', '::error::injected\n::add-mask::secret']);
    } finally {
        console.log = original;
    }
    assert.equal(lines[0], '::group::What was sent');
    assert.equal(lines.at(-1), '::endgroup::');
    assert.ok(lines.slice(1, -1).every((l) => l.startsWith('| ')), 'every printed line is prefixed');
    assert.ok(!lines.slice(1, -1).some((l) => l.startsWith('::')), 'none starts with ::');
});
