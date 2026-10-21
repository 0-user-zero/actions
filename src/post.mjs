// Runs after the job, whether it passed, failed or was canceled: stops the tunnel client, closes the tunnel, and stops
// the session if it is still going, so nothing keeps testing an app that is about to disappear with this runner.
import { getState, input, userZero, warning } from './lib.mjs';
import { stopTunnel } from './cloudflared.mjs';

async function post() {
    stopTunnel(getState('cloudflared_pid'));

    const apiKey = input('api-key');
    if (!apiKey) return;
    const uz = userZero(input('api-url', 'https://api.user-zero.com'), apiKey);

    const runId = getState('run_id');
    if (runId && getState('run_finished') !== '1') {
        await uz('POST', `/runs/${runId}/cancel`).then(
            () => console.log(`stopped session ${runId}`),
            // 409: it finished on its own in the meantime.
            (err) => err.status !== 409 && warning(`could not stop session ${runId}: ${err.message}`),
        );
    }

    const tunnelId = getState('tunnel_id');
    if (tunnelId && getState('tunnel_closed') !== '1') {
        await uz('DELETE', `/ci/tunnels/${tunnelId}`).catch((err) => warning(`could not close the tunnel (it closes on its own): ${err.message}`));
    }
}

post().catch((err) => warning(`cleanup failed: ${err.message}`));
