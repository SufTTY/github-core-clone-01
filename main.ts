// One entry in a makefun trial: boot the forge app on a kernel-chosen port, hand that port to the
// environment, then sit tight until the environment says the trial is over, and shut down cleanly.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. createApp() builds the forge server; listen(0) asks the kernel for a free port. Never bind
//      8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came
//      from plus N as this entry's base URL. 200 is the normal answer; 409 means another entry
//      already registered first, which is equally fine. 400/405 break the contract and stop the
//      process; a network error or another status is retried, since the env may still be starting.
//      Waits use 250 ms-2 s full-jitter backoff, and no single request runs past 30 s.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once while
//      the suite runs, so this is a poll; a failed or slow poll is retried quietly.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the
//      scorer reads.
//
// main.ts imports its own app and nothing else: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const BACKOFF_FLOOR_MS = 250;
const BACKOFF_CEIL_MS = 2_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `failures` failed requests: full jitter over exponential backoff, capped. */
function backoffMs(failures: number): number {
  const cap = Math.min(BACKOFF_CEIL_MS, BACKOFF_FLOOR_MS * 2 ** Math.min(failures, 8));
  // Full jitter spreads retries uniformly over [floor, cap] so a burst of entries that all failed
  // together do not re-synchronize and hammer the env on the next attempt.
  return Math.floor(BACKOFF_FLOOR_MS + Math.random() * (cap - BACKOFF_FLOOR_MS));
}

/** Bind the port, announce it, then wait for the env: the whole life of the process. */
async function boot(): Promise<void> {
  const server = createApp();
  // A malformed request must not take the entry down: answer 400 and move on.
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

/** POST the bound port until the env accepts it. 200 is the normal answer; 409 is fine too. */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await wait(backoffMs(failures));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function awaitCompletion(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await wait(backoffMs(failures));
  }
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
