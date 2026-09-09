// CLI: `pnpm --filter @marsad/engine hash-password`. Reads the password from stdin (never argv,
// so it stays out of shell history) and prints an argon2id PHC string for OPERATOR_PASSWORD_HASH.
import { argon2id, hash } from 'argon2';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
const password = (await rl.question('Operator password: ')).trim();
rl.close();

if (password.length < 12) {
  console.error('Refusing: use at least 12 characters.');
  process.exit(1);
}

const phc = await hash(password, {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
});
console.log('\nOPERATOR_PASSWORD_HASH=' + phc);
