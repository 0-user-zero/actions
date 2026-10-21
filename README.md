# User Zero QA: GitHub Action

Tests what was just merged, in your own CI. Your workflow starts your app on localhost the way it already does for its own tests; this action opens a short-lived tunnel to it, and User Zero's tester uses the app like a real user and reports what's broken.

**User Zero never receives your code.** It receives the merged pull request's title, description, number and commit, plus the HTTP traffic of your running app while it's tested. Your secrets and database stay in your CI.

## Setup

1. In User Zero, make sure your site is approved.
2. Add two repository secrets for the test user: `USERZERO_TEST_EMAIL` and `USERZERO_TEST_PASSWORD`. Your seed step creates this user in CI and the action signs in with it (see "The test login").
3. Add your User Zero API key as the repository secret `USERZERO_API_KEY`. Create the key in the User Zero portal under Settings → API keys (it is shown once, when you create it); if you do not see that tab yet, ask us for a key.
4. Add a workflow. The part before `0-user-zero/actions` is your app's own start-up, the same steps your CI already uses for its end-to-end tests; the action is the last step.

```yaml
name: User Zero QA
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      dry_run:
        description: Check the setup without testing anything
        type: boolean
        default: true
concurrency:
  group: user-zero
  cancel-in-progress: false
permissions:
  contents: read
  pull-requests: write          # to comment the results on the merged pull request
jobs:
  qa:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v7
      - run: npm ci && npm run db:migrate && npm run db:seed   # your own steps
        env:
          TEST_USER_EMAIL: ${{ secrets.USERZERO_TEST_EMAIL }}        # your seed creates this user
          TEST_USER_PASSWORD: ${{ secrets.USERZERO_TEST_PASSWORD }}
      - run: npm run build && (npm start &)                    # your app on :3000, in the background
      - uses: 0-user-zero/actions@v1
        with:
          api-key: ${{ secrets.USERZERO_API_KEY }}
          site: app.acme.com
          port: 3000
          login-email: ${{ secrets.USERZERO_TEST_EMAIL }}        # the same secrets the seed used
          login-password: ${{ secrets.USERZERO_TEST_PASSWORD }}
          dry-run: ${{ inputs.dry_run }}
```

5. **Run it once as a dry run** (Actions tab → *User Zero QA* → *Run workflow*, with "Check the setup" ticked) and get it green before anything else. See "Check your setup first".

Don't want to write the start-up steps by hand? [`SETUP_PROMPT.md`](SETUP_PROMPT.md) is a prompt you paste into your coding assistant (Claude Code, Cursor, Copilot) that reads your repo and writes the workflow.

## Check your setup first (dry run)

`dry-run: true` checks everything that can go wrong in the workflow, then stops. **Nothing is tested.** The check itself is free for now.

1. **Your User Zero account:** the site is approved, there are credits, tunnels are available.
2. **Your app:** the steps before the action start it, and it answers on the port.
3. **The tunnel:** the action opens it, and User Zero reaches your app through it. The result shows the page's title and status, so you can see it's the page you expect.
4. **Sign-in:** a short real session opens your app and signs in with the test login, then stops (about a minute). This is the check that most often finds a problem: the seed doesn't create the user you pass.

A failed check fails the job and says what to change; a passed one shows a table in the job summary. Run it every time you change the start-up steps. Turn off the sign-in check with `login-check: false` for an app with no login.

## The test login

The tester signs in the way a person would, with an email and password on your login page.

- **You pick the test user; User Zero doesn't issue one.** Use a dedicated test user, ideally the one your end-to-end tests already use.
- **Pass it from your own secrets, the same way you pass it to your end-to-end tests.** Your seed step creates the user from `USERZERO_TEST_EMAIL` and `USERZERO_TEST_PASSWORD`, and you give the action the same two values with `login-email` and `login-password`. One source, so the two can't drift apart. If your workflow already has the values in environment variables, set `USERZERO_LOGIN_EMAIL` and `USERZERO_LOGIN_PASSWORD` instead of the inputs.
- **User Zero uses it for that one session and does not keep it.** It is encrypted while it waits for the session to start, wiped the moment it is handed to the tester, wiped if the session never starts (the run is canceled, or two hours pass), and never written to a log. The browser session it creates is not saved either.
- **Nothing signs in by itself in CI.** An app started in CI has an empty database, so it has no users and no sessions. Your end-to-end tests sign in because they create a user and log in as it; this action works the same way. If your tests skip the login form (a test-only login endpoint, a pre-made session cookie, a stubbed identity provider), the tester can't use that shortcut: it needs a user who can sign in with a password on the real form, in CI only.
- **A login saved in User Zero still works.** Leave out `login-email` and `login-password` and the site's saved login is used; `login` picks a saved login by name. Use one way or the other, not both.

Logins that need a code (MFA), a captcha or a single sign-on page can't be completed by the tester. Use a test user without that step in CI.

## What happens on each merge

1. The action asks User Zero whether the account is in order (pre-flight), then finds the pull request that was merged. It skips the run if the PR has the `no-qa` label, or if only files matching `ignore-paths` changed.
2. It waits for your app to answer on `localhost:<port>`.
3. It opens a tunnel to it. The tunnel is outbound only, and only User Zero's tester can use it.
4. A QA session tests the change, guided by the PR's title and description. The job log shows progress.
5. Results go to the job summary and to a comment on the merged PR. The job stays green unless you set `fail-on`, or the tester couldn't start because of a setup problem such as the login, which fails the job so it gets noticed.
6. The tunnel closes. If the job is canceled, the session is stopped and its credit refunded.

## Inputs

| Input | Default | |
|---|---|---|
| `api-key` | required | Your User Zero API key. |
| `site` | required | The approved site this repo is, for example `app.acme.com`. Just the host; a pasted address is cut down to it. |
| `port` | required | The port your app listens on in the job. |
| `login-email` | | The test user's email, from a repository secret. Also read from `USERZERO_LOGIN_EMAIL`. |
| `login-password` | | The test user's password, from a repository secret. Also read from `USERZERO_LOGIN_PASSWORD`. |
| `dry-run` | `false` | Check the setup and stop. No test. |
| `login-check` | `true` | In a dry run, also check that the tester can sign in. |
| `login` | | The name of a login saved in User Zero, instead of `login-email` and `login-password`. |
| `path` | `/` | The page to start from. |
| `scope` | | Extra instructions, added after the PR description. |
| `fail-on` | `none` | `high` fails the job on critical or high bugs; `any` on any bug. |
| `comment` | `true` | Comment the results on the merged PR. |
| `skip-label` | `no-qa` | PRs with this label are not tested. |
| `ignore-paths` | `**/*.md,docs/**,.github/**` | Changes touching only these are not tested. |
| `wait-timeout` | `180` | Seconds to wait for your app to come up. |

Outputs: `dry-run` (`passed` or `passed-with-warnings`), `run-id`, `report-url`, `bug-count`.

## When something fails

Every message in the log says what happened and what to change. The common ones:

| You see | Likely cause | What to do |
|---|---|---|
| *rejected the API key* | The secret is missing, misnamed, revoked, or from another User Zero environment | Check `USERZERO_API_KEY` and that it's passed as `api-key`. |
| *is not approved for your account* | A typo in `site`, or the site isn't added yet | Use just the host; ask your account manager to approve it. |
| *Only the email … of the test login was given* | One of the two secrets is empty or missing | Check both secrets exist in this repository: an unset secret is an empty string. |
| *There is no saved login named …* | `login` doesn't match a saved login | Save it in User Zero, or use `login-email` and `login-password`. |
| *no run credits left* | The account is out of credits | Ask your account manager. |
| *Your app never answered on …* | The app isn't started, runs in the foreground, crashed, or uses another port | Start it in the background (`npm start &`, `docker compose up -d --wait`); check the port; read the step that starts it. |
| *answered HTTP 404 on "/"* | The start page isn't `/` | Set `path`. |
| *answered HTTP 403 or 400 through the tunnel, but not on localhost* | The framework refuses an unknown Host header | Allow `ci-*.user-zero.com`: Django `ALLOWED_HOSTS`, Rails `config.hosts`, Vite `server.allowedHosts`. |
| *answered HTTP 500* | The app is up but erroring | Read its logs in the step that starts it. |
| *nothing answered on localhost:… inside your job* | The tunnel works, but the app stopped or listens elsewhere | Check it's still running and the `port` is right. |
| *cloudflared did not connect* | Outbound connections to Cloudflare are blocked | Re-run; on self-hosted runners allow outbound port 7844. |
| *The tester could not sign in* | The CI database has no such user, or a different password | Make the seed step create the user from the same two secrets you pass as `login-email` and `login-password`. |
| *Signed in was not confirmed* | The tester finished without using the login: the start page needs none, or it couldn't find the sign-in form | Set `path` to your sign-in page; skip the check with `login-check: false` if the app has no login. |

## Known limits

- **Linux runners only.**
- **One origin.** The browser reaches your app through one hostname. If your frontend calls an API on a different localhost port straight from the browser (`http://localhost:4000`), those calls fail. Serve the API through the same port (a dev proxy, or `/api` routes) for now.
- **WebSockets** to your app are not supported through the tunnel yet.
- **Password sign-in only.** Sign-in with Google or another OAuth provider, codes and captchas can't be completed.
- **Host checks:** frameworks that reject unknown `Host` headers in development need to allow `ci-*.user-zero.com`, or run in production mode.
