// Small helpers shared by main.mjs and post.mjs. No dependencies, so what runs in your CI is exactly what you read here.
import { appendFileSync, readFileSync } from 'node:fs';

/** An input from action.yml; GitHub passes `my-input` as the env var INPUT_MY-INPUT. */
export function input(name, fallback = '') {
    const value = process.env[`INPUT_${name.toUpperCase()}`];
    return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function requiredInput(name) {
    const value = input(name);
    if (!value) throw new UserError(`The "${name}" input is required.`);
    return value;
}

/** An error worth showing to the person who set the workflow up, without a stack trace. */
export class UserError extends Error {}

export const log = (message) => console.log(message);
export const notice = (message) => console.log(`::notice title=User Zero::${escapeData(message)}`);
export const warning = (message) => console.log(`::warning title=User Zero::${escapeData(message)}`);
export const errorAnnotation = (message) => console.log(`::error title=User Zero::${escapeData(message)}`);
export const mask = (secret) => console.log(`::add-mask::${secret}`);

function escapeData(s) {
    return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function appendKeyValue(file, name, value) {
    if (!file) return;
    const delimiter = `uz_${Math.random().toString(36).slice(2)}`;
    appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Kept for post.mjs, which GitHub runs after the job even when it fails or is canceled. */
export const saveState = (name, value) => appendKeyValue(process.env.GITHUB_STATE, name, String(value));
export const getState = (name) => process.env[`STATE_${name}`] ?? '';
export const setOutput = (name, value) => appendKeyValue(process.env.GITHUB_OUTPUT, name, String(value));
export const addSummary = (markdown) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

export function readEvent() {
    try {
        return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Prints lines in a collapsible group of the job log. Every line gets a prefix, so text taken from a pull request can
 * never start with `::` and act as a workflow command.
 */
export function group(title, lines) {
    console.log(`::group::${escapeData(title)}`);
    for (const line of lines) for (const part of String(line).split('\n')) console.log(`| ${part}`);
    console.log('::endgroup::');
}

/** A failed call to the User Zero API. `status` is 0 when the request never got an answer (`network`). */
export class ApiError extends Error {
    constructor(method, path, status, detail, network = false) {
        super(`User Zero ${method} ${path}: ${detail}`);
        this.name = 'ApiError';
        Object.assign(this, { method, path, status, detail, network });
    }
}

/**
 * Runs `fn`, and runs it again when User Zero answered with a server error or could not be reached: a moment's trouble on
 * our side should not fail someone's merge. Anything else (a refused key, a bad request) fails at once. `onRetry` is told
 * which attempt failed and how long it waits.
 */
export async function withRetries(fn, { attempts = 3, delaysMs = [3000, 8000], onRetry } = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const transient = err instanceof ApiError && (err.network || err.status >= 500);
            if (!transient || attempt >= attempts) throw err;
            const wait = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
            onRetry?.(err, attempt, wait);
            await sleep(wait);
        }
    }
}

/** A client for the User Zero API, authenticated with the org's API key. */
export function userZero(apiUrl, apiKey) {
    const base = apiUrl.replace(/\/+$/, '');
    return async function call(method, path, body) {
        let res;
        try {
            res = await fetch(`${base}${path}`, {
                method,
                headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'user-agent': 'user-zero-qa-action' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
        } catch (err) {
            throw new ApiError(method, path, 0, err.cause?.code ?? err.cause?.message ?? err.message, true);
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            // A 400 carries which fields were wrong; showing them is what makes the message actionable.
            const fields = json.details?.fieldErrors ? ` ${JSON.stringify(json.details.fieldErrors)}` : '';
            throw new ApiError(method, path, res.status, `${json.error ?? `HTTP ${res.status}`}${fields}`);
        }
        return json;
    };
}

/** A client for the GitHub REST API with the workflow's token. */
export function github(token) {
    const base = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    return async function call(method, path, body) {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                'content-type': 'application/json',
                'user-agent': 'user-zero-qa-action',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return res.status === 204 ? null : res.json();
    };
}

/** Glob to RegExp for ignore-paths: `**` crosses folders, `*` stays inside one, `?` is one character. */
export function globToRegExp(glob) {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            // "**/" also matches no folder at all, so "**/*.md" matches "README.md".
            if (glob[i + 2] === '/') {
                out += '(?:.*/)?';
                i += 2;
            } else {
                out += '.*';
                i += 1;
            }
        } else if (c === '*') out += '[^/]*';
        else if (c === '?') out += '[^/]';
        else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
}
