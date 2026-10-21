const MAX_SCOPE_CHARS = 8000;
/** A commit message shorter than this says too little to test from. */
const MIN_MESSAGE_CHARS = 15;

/**
 * What the tester is asked to look at. The workflow's own instructions come first, because they say what to test;
 * the pull request or commit is added as context, with a note that it may not describe anything visible in the app
 * (a lint fix, a dependency bump), so the tester does not go hunting for it.
 */
export function buildScope(change, extra) {
    const parts = [];
    const instructions = (extra ?? '').trim();
    if (instructions) parts.push(instructions);

    if (change.pr) {
        const lead = instructions
            ? `For context, the change that was just merged is pull request #${change.pr.number}: "${change.pr.title}". It may not change anything you can see in the app; if it does not, ignore it and test the instructions above.`
            : `Test the change that was just merged in pull request #${change.pr.number}: "${change.pr.title}".`;
        parts.push(lead);
        const body = (change.pr.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
        if (body) parts.push(`What the pull request says:\n${body}`);
    } else if (change.message.trim().length >= MIN_MESSAGE_CHARS) {
        const message = change.message.trim();
        parts.push(
            instructions
                ? `For context, the change that was just pushed is described as: "${message}". It may not change anything you can see in the app; if it does not, ignore it and test the instructions above.`
                : `Test the change that was just pushed: "${message}".`,
        );
    }
    return parts.join('\n\n').slice(0, MAX_SCOPE_CHARS);
}
