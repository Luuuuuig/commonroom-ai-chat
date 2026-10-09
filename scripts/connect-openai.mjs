import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SiwcAuthClient, SiwcAuthError } from '../src/siwc-auth.mjs';

// Run this helper on the computer with your browser, then transfer credentials
// securely to the VM. This helper never calls any model or paid API endpoint.
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let stateDir = path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectDir, 'data'), 'providers', 'openai');
let port = 1455;
let statusOnly = false;
try {
  while (args.length) {
    const argument = args.shift();
    if (argument === '--state-dir' && args[0]) stateDir = path.resolve(args.shift());
    else if (argument === '--port' && /^\d+$/.test(args[0] ?? '')) port = Number(args.shift());
    else if (argument === '--status') statusOnly = true;
    else throw new SiwcAuthError('AUTH_CONFIGURATION_INVALID');
  }
  const client = new SiwcAuthClient({ stateDir });
  if (statusOnly) console.log(JSON.stringify(await client.status(), null, 2));
  else {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    const status = await client.beginAuthorization({
      port, signal: controller.signal,
      onAuthorizationUrl(url) {
        console.log('Continue with ChatGPT. Open this URL in a browser on this computer:');
        console.log(url);
      },
    });
    console.log(status.status === 'ready'
      ? 'ChatGPT credentials saved. No model request was made. Live inference remains unverified.'
      : 'Signed in. ChatGPT plan permission was not granted, so model requests remain disabled.');
  }
} catch (error) {
  console.error(error instanceof SiwcAuthError ? error.code : 'AUTH_HELPER_FAILED');
  if (error?.code === 'AUTH_LOCK_BUSY') {
    console.error('Another process may be using the credentials. Wait for it to finish.');
    console.error('For an abandoned lock, stop every app, proof runner and sign-in helper using this state directory. Then remove only credentials.lock from that directory and retry. Never remove a lock while one of those processes is running.');
  }
  process.exitCode = 1;
}
