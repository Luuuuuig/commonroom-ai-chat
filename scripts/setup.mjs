import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/auth.mjs';
import { dataDirectory } from '../src/runtime.mjs';

async function hiddenPrompt(label) {
  if (!process.stdin.isTTY) throw new Error('Run interactively, or supply GROUP_CHAT_PASSWORD securely through the environment.');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') { cleanup(); reject(new Error('Setup cancelled.')); return; }
        if (character === '\r' || character === '\n') { cleanup(); resolve(value); return; }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && value.length < 1024) value += character;
      }
    };
    process.stdin.on('data', onData);
  });
}
try {
  const directory = dataDirectory();
  const file = join(directory, 'config.json');
  if (existsSync(file)) throw new Error('Configuration exists. Setup will not overwrite your password or sessions.');
  let password = process.env.GROUP_CHAT_PASSWORD;
  if (!password) {
    password = await hiddenPrompt('Private app password, at least 16 characters: ');
    if (password !== await hiddenPrompt('Repeat password: ')) throw new Error('Passwords do not match.');
  }
  const passwordHash = hashPassword(password);
  password = undefined;
  delete process.env.GROUP_CHAT_PASSWORD;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ passwordHash, sessionSecret: randomBytes(32).toString('hex') }) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Private login configured. Start with npm start. Provider mode remains MOCK.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
