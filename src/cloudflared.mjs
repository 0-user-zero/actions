// Runs Cloudflare's tunnel client, which connects out from this job so User Zero can reach your app on localhost.
// Nothing listens for inbound connections on the runner; the tunnel closes when this job ends.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserError, sleep } from './lib.mjs';
import { cloudflaredChecksum, cloudflaredDownloadFailed, tunnelNotConnected } from './explain.mjs';

/** The cloudflared release this action downloads, and the SHA-256 of each binary it accepts. */
export const CLOUDFLARED_VERSION = '2026.10.2';
// The digests GitHub publishes for this release's assets. A download that doesn't match is refused.
const CHECKSUMS = {
    'cloudflared-linux-amd64': '35fbdd2beb378436c7da377d7358cea8e33f9c94a6705d1d8036bf9b0d6d8005',
    'cloudflared-linux-arm64': 'b7e55b4d9702c2ab5f8348f780bb1db044527fc555367714c78e0595750a4665',
};

function assetName() {
    if (process.platform !== 'linux') throw new UserError(`This action runs on Linux runners only (this one is ${process.platform}).`);
    if (process.arch === 'x64') return 'cloudflared-linux-amd64';
    if (process.arch === 'arm64') return 'cloudflared-linux-arm64';
    throw new UserError(`Unsupported runner architecture: ${process.arch}.`);
}

/** The path of a cloudflared binary of the pinned version, downloading it once per runner. */
export async function ensureCloudflared() {
    const asset = assetName();
    const dir = join(process.env.RUNNER_TOOL_CACHE || process.env.RUNNER_TEMP || '/tmp', 'user-zero-cloudflared', CLOUDFLARED_VERSION);
    const binary = join(dir, 'cloudflared');
    if (existsSync(binary)) return binary;

    const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
    let bytes;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
        throw new UserError(cloudflaredDownloadFailed(url, err.cause?.code ?? err.message));
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== CHECKSUMS[asset]) throw new UserError(cloudflaredChecksum(digest));

    mkdirSync(dir, { recursive: true });
    writeFileSync(binary, bytes);
    chmodSync(binary, 0o755);
    const version = spawnSync(binary, ['--version'], { encoding: 'utf-8' });
    if (version.status !== 0) throw new Error(`cloudflared does not start: ${version.stderr || version.stdout}`);
    return binary;
}

/**
 * Starts cloudflared in the background and waits until it has a connection to Cloudflare's edge.
 * The token goes in through the environment, not the command line, so it never shows in a process list.
 */
export async function startTunnel(binary, connectorToken, timeoutMs = 90_000) {
    const logPath = join(process.env.RUNNER_TEMP || '/tmp', `user-zero-cloudflared-${Date.now()}.log`);
    const out = openSync(logPath, 'a');
    const child = spawn(binary, ['tunnel', '--no-autoupdate', '--loglevel', 'info', 'run'], {
        env: { ...process.env, TUNNEL_TOKEN: connectorToken },
        detached: true,
        stdio: ['ignore', out, out],
    });
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const text = readLog(logPath);
        if (/Registered tunnel connection/i.test(text)) return { pid: child.pid, logPath };
        if (child.exitCode !== null) throw new UserError(tunnelNotConnected(Math.round(timeoutMs / 1000), tail(text), child.exitCode));
        await sleep(1000);
    }
    throw new UserError(tunnelNotConnected(Math.round(timeoutMs / 1000), tail(readLog(logPath))));
}

export function stopTunnel(pid) {
    if (!pid) return;
    try {
        // Negative pid: the whole process group, since cloudflared was started detached.
        process.kill(-Number(pid), 'SIGTERM');
    } catch {
        try {
            process.kill(Number(pid), 'SIGTERM');
        } catch {
            // already gone
        }
    }
}

function readLog(path) {
    try {
        return readFileSync(path, 'utf-8');
    } catch {
        return '';
    }
}

const tail = (text) => text.split('\n').slice(-15).join('\n');
