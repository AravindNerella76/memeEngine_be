/**
 * Owner account from the command line (there is no public sign-up page):
 *   npm run auth:create-owner      first-time setup
 *   npm run auth:reset-password    forgot it? sets a new password and signs out everywhere
 *   npm run auth:status            is an owner set up?
 * Uses the same MONGO_URI as the server (memeEngine_be/.env). The password is typed hidden, never on the command line.
 */
import '../config/load-env';
import * as readline from 'readline';
import mongoose from 'mongoose';
import { getConfig } from '../config/app-config';
import { AuthSession, AuthSessionSchema, AuthUser, AuthUserSchema } from './auth.schemas';
import { hashPassword, passwordProblems } from './password';
import { normalizeUsername } from './auth.service';

function ask(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    if (hidden && process.stdin.isTTY) {
      const w = (rl as any)._writeToOutput;
      (rl as any)._writeToOutput = (s: string) => {
        if (s.startsWith(question)) w.call(rl, s);
        else if (s.includes('\n') || s.includes('\r')) w.call(rl, '\n');
      };
    }
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function readNewPassword(username: string): Promise<string> {
  for (;;) {
    const a = await ask('New password (at least 12 characters, a few random words works well): ', true);
    const problems = passwordProblems(a, username);
    if (problems.length) {
      console.log('  ✗ ' + problems.join(' '));
      continue;
    }
    const b = await ask('Repeat the password: ', true);
    if (a !== b) {
      console.log("  ✗ The two passwords don't match. Try again.");
      continue;
    }
    return a;
  }
}

async function main() {
  const command = process.argv[2];
  if (!['create-owner', 'reset-password', 'status'].includes(command)) {
    console.log('Usage: node dist/auth/cli.js <create-owner | reset-password | status>');
    process.exit(2);
  }
  const uri = getConfig().mongoUri;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log(`Database: ${uri.replace(/\/\/[^@/]*@/, '//***@')}`);
  const Users: mongoose.Model<any> = (mongoose.models[AuthUser.name] as mongoose.Model<any>) || mongoose.model<any>(AuthUser.name, AuthUserSchema);
  const Sessions: mongoose.Model<any> = (mongoose.models[AuthSession.name] as mongoose.Model<any>) || mongoose.model<any>(AuthSession.name, AuthSessionSchema);

  const existing = await Users.find().lean();

  if (command === 'status') {
    console.log(existing.length ? `Owner account: ${existing.map(u => u.username).join(', ')}` : 'No owner account yet. Run: npm run auth:create-owner');
    return;
  }

  if (command === 'create-owner') {
    if (existing.length) {
      console.log(`An owner account already exists (${existing[0].username}). To change the password run: npm run auth:reset-password`);
      process.exitCode = 1;
      return;
    }
    let username: string | null = null;
    while (!username) {
      username = normalizeUsername(await ask('Username or e-mail for the owner: '));
      if (!username) console.log('  ✗ Use 3-100 characters: letters, digits and . _ @ + -');
    }
    const password = await readNewPassword(username);
    await Users.create({ username, passwordHash: await hashPassword(password), passwordChangedAt: new Date() });
    console.log(`\n✓ Owner "${username}" created. Start the server and sign in.`);
    return;
  }

  // reset-password
  if (!existing.length) {
    console.log('There is no owner account yet. Run: npm run auth:create-owner');
    process.exitCode = 1;
    return;
  }
  const user = existing[0];
  console.log(`Resetting the password for "${user.username}".`);
  const password = await readNewPassword(user.username);
  await Users.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date() } });
  const r = await Sessions.deleteMany({ userId: String(user._id) });
  console.log(`\n✓ Password changed. ${r.deletedCount || 0} signed-in session(s) were ended.`);
}

main()
  .catch(err => {
    console.error('Failed:', err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
