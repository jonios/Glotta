// Creates (or resets) a Super Admin. Usage:
//   npm run admin:create -- --email admin@example.com --name "Admin" [--password <pw>]
// Without --password a random one is generated and printed once.
import { openDb, arg } from './common.js';
import { hashPassword, PASSWORD_RULE, randomToken } from '../auth/crypto.js';
import { CAPABILITIES } from '../../shared/domain.js';

const email = arg('email')?.toLowerCase();
const name = arg('name') ?? 'Administrator';
let password = arg('password') ?? process.env.ADMIN_PASSWORD;
if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
  console.error('Usage: npm run admin:create -- --email admin@example.com [--name "Admin"] [--password ...]');
  process.exit(1);
}
const generated = !password;
password ??= randomToken(12);
if (password.length < PASSWORD_RULE.min) {
  console.error(PASSWORD_RULE.message);
  process.exit(1);
}
const { db } = await openDb();
await db.tx(async (q) => {
  const row = await q.one<{ id: number }>(
    `INSERT INTO users (email, name, role, password_hash, all_languages, all_platforms) VALUES ($1,$2,'super_admin',$3,true,true)
     ON CONFLICT (email) DO UPDATE SET role='super_admin', password_hash=EXCLUDED.password_hash, is_active=true, all_languages=true, all_platforms=true
     RETURNING id`,
    [email, name, await hashPassword(password!)],
  );
  await q.query('DELETE FROM user_capabilities WHERE user_id=$1', [row!.id]);
  await q.query('INSERT INTO user_capabilities (user_id, capability) SELECT $1, unnest($2::text[])', [row!.id, [...CAPABILITIES]]);
  await q.query(`INSERT INTO audit_logs (actor_id, action, resource_type, resource_id) VALUES ($1,'user.admin_bootstrap','user',$2)`, [row!.id, String(row!.id)]);
});
console.log(`Super Admin ready: ${email}`);
if (generated) console.log(`Generated password (shown once): ${password}`);
await db.close();
