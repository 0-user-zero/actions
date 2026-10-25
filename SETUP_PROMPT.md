# Set up the workflow with your coding assistant

Paste the prompt below into Claude Code, Cursor, Copilot or any coding assistant that can read your repo. Replace the value in `{{ }}` first. It reads how your repo already starts the app in CI, writes `.github/workflows/user-zero.yml`, and tells you what's left for you to do by hand.

**User Zero never sees your code.** The assistant works in your repo on your machine; the workflow it writes runs in your own CI.

---

```text
Add a GitHub Actions workflow to this repo that runs User Zero's QA tester after every merge to main.

How it works, so you can reason about it: the workflow runs on a Linux GitHub runner, starts this app on localhost together with everything it needs (database, cache, queues, workers), and then calls the action `0-user-zero/actions@v1`. That action opens a short-lived outbound tunnel to the app and User Zero's tester signs in and tests it in a browser. The app must therefore run entirely on the runner, on ONE port.

Values:
- site (the host this app is known as in User Zero, just the hostname): {{SITE, for example app.acme.com}}
- the test user's email and password are the repository secrets USERZERO_TEST_EMAIL and USERZERO_TEST_PASSWORD (do not write either in any file)

Do this:

1. Find how this repo already starts the app in CI or locally. Read .github/workflows/*, docker-compose*.yml, Makefile, package.json scripts (or the equivalent for this stack), .env.example, and the README's "run locally" section. If an end-to-end test job (Playwright, Cypress, etc.) already exists, reuse its steps; that is the most reliable source for how to boot the app.

2. Create .github/workflows/user-zero.yml:
   - triggers: push to main, and workflow_dispatch with a boolean input `dry_run` (default true);
   - concurrency group `user-zero` with cancel-in-progress false; permissions `contents: read` and `pull-requests: write`; timeout-minutes 90 (a User Zero session can run up to an hour); runs-on ubuntu-latest;
   - use actions/checkout@v7 and, for Node, actions/setup-node@v7 with the Node version this repo uses;
   - services as GitHub `services:` containers with health checks (Postgres, Redis, etc.), or `docker compose up -d --wait` if the repo is built around compose;
   - install, build, migrate, then SEED, then start the app IN THE BACKGROUND (for example `npm start &`) on a single port;
   - last, the action:
       - uses: 0-user-zero/actions@v1
         with:
           api-key: ${{ secrets.USERZERO_API_KEY }}
           site: {{SITE}}
           port: <the port the app listens on>
           login-email: ${{ secrets.USERZERO_TEST_EMAIL }}
           login-password: ${{ secrets.USERZERO_TEST_PASSWORD }}
           dry-run: ${{ inputs.dry_run }}

3. The seed step must create a test user from those same two secrets (pass them to the seed step as environment variables from `secrets.USERZERO_TEST_EMAIL` and `secrets.USERZERO_TEST_PASSWORD`), with whatever role, organisation, plan or onboarding state is needed for that user to land in the normal signed-in app (no onboarding wall, no email verification, no MFA). Add it to the existing seed script or create a small one. Do not print the password in logs. This is the only app code you may change; keep the change minimal. The action signs in with the same two values, so they must be the same secrets in both places.

4. Third-party services: use test-mode keys or local stubs, never production secrets. List every environment variable the app needs from .env.example, give safe CI values where they are obvious, and for anything that needs a real value write `# TODO: ask the team` and list it for me at the end. Do not invent keys.

   Start the app from its PRODUCTION build (build step, then the production start command; not a dev server), and make sure the build does not emit source maps (for example `GENERATE_SOURCEMAP=false`, `productionBrowserSourceMaps: false`, `build.sourcemap: false`, depending on the stack). The tester then only receives what real users get, and the original source stays on the runner.

5. Check these constraints and tell me about every one that is not met:
   - the browser must reach everything through ONE origin: if the frontend calls a different localhost port for its API, serve the API through the same port (a dev proxy or /api routes) or tell me it needs doing;
   - sign-in must work with an email and a password on the real login form in CI (not only through a test-only endpoint, a pre-made cookie, or a stubbed identity provider);
   - the framework must accept requests whose Host header is a tunnel host like ci-xxxx.user-zero.com (Django ALLOWED_HOSTS, Rails config.hosts, Vite server.allowedHosts): allow it in CI only.

6. Also add, temporarily and clearly marked for removal, a push trigger for the current branch so I can run the dry run before merging.

7. If `actionlint` is installed, run it on the workflow and fix what it finds.

At the end, tell me in a short list: what you changed, what I still have to do by hand (the repository secrets USERZERO_API_KEY, USERZERO_TEST_EMAIL and USERZERO_TEST_PASSWORD, with the last two chosen by me; any TODO values), and how to run the dry run. When a run fails, I will paste you the log and you fix the workflow.
```

---

## What you do after the assistant is done

1. Add three repository secrets: `USERZERO_API_KEY` (from User Zero), and `USERZERO_TEST_EMAIL` and `USERZERO_TEST_PASSWORD` (a test user you choose; the seed creates it and the action signs in with it).
2. Run the workflow as a dry run (Actions tab → *User Zero QA* → *Run workflow*). The last check opens your app and signs in with that user. Fix what it reports; every message says what to change. Paste the log to your assistant if you want it to do the fixing.
3. Remove the temporary branch trigger and merge.
