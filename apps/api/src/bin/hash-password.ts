import { hashPassword } from '../auth';

/**
 * `mise run admin:hash -- --password 'secret'` → the value for ADMIN_PASSWORD_HASH.
 *
 * Reads the password from an argument rather than prompting: this is run once, by a human,
 * when a deployment is set up.
 */
const index = process.argv.indexOf('--password');
const password = index === -1 ? undefined : process.argv[index + 1];

if (!password) {
  console.error("usage: mise run admin:hash -- --password '<password>'");
  process.exit(2);
}

console.log(await hashPassword(password));
