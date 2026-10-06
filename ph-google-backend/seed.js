require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Page = require('./models/Page');
const Term = require('./models/Term');
const Website = require('./models/Website');
const SearchLog = require('./models/SearchLog');
const { config } = require('./config/env');

/**
 * Safe setup script — creates or promotes an administrator account and
 * prints the current state of the database.
 *
 * This script is strictly additive: it never deletes documents and never
 * drops a collection. (The previous version cleared the History,
 * SearchResult and Suggestion collections and replaced them with mock rows;
 * history and analytics are real per-user data now, so that behaviour was
 * removed.)
 *
 * Usage:
 *   npm run create-admin -- --email you@example.com --password 'secret123' --name 'Your Name'
 *
 * Credentials may also come from the environment, which avoids putting a
 * password in your shell history:
 *   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME
 */

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[name] = value;
        i += 1;
      } else {
        args[name] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = readArgs(process.argv.slice(2));

  const email = (args.email || process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = args.password || process.env.ADMIN_PASSWORD || '';
  const name = args.name || process.env.ADMIN_NAME || 'Administrator';

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 20000 });
  console.log(`Connected to database "${mongoose.connection.name}"\n`);

  // Report current state first, so it is obvious nothing was wiped.
  const [users, admins, pages, websites, terms, searches] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ role: 'admin' }),
    Page.countDocuments(),
    Website.countDocuments(),
    Term.countDocuments(),
    SearchLog.countDocuments()
  ]);

  console.log('Current database contents');
  console.log(`  users:      ${users} (${admins} admin)`);
  console.log(`  pages:      ${pages}`);
  console.log(`  websites:   ${websites}`);
  console.log(`  terms:      ${terms}`);
  console.log(`  searchlogs: ${searches}\n`);

  // --promote grants the admin role to an account that already exists,
  // without touching (or needing to know) its password.
  if (email && !password && args.promote) {
    const existing = await User.findOne({ email });
    if (!existing) {
      console.error(
        `No account found for ${email}. Create one first, or pass --password to create it here.`
      );
      await mongoose.disconnect();
      process.exitCode = 1;
      return;
    }
    if (existing.role === 'admin') {
      console.log(`${email} is already an admin. No change made.`);
    } else {
      existing.role = 'admin';
      await existing.save();
      console.log(`Promoted ${email} to admin. Password unchanged.`);
    }
    await mongoose.disconnect();
    return;
  }

  if (!email || !password) {
    console.log('No admin credentials supplied — nothing was changed.');
    console.log('To create an admin, run:');
    console.log("  npm run create-admin -- --email you@example.com --password 'yourPassword'");
    console.log('To promote an account that already exists, run:');
    console.log('  npm run create-admin -- --email you@example.com --promote\n');
    await mongoose.disconnect();
    return;
  }

  if (password.length < 6) {
    console.error('Password must be at least 6 characters.');
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  const existing = await User.findOne({ email });

  if (existing) {
    // Promote without touching the existing password.
    if (existing.role === 'admin') {
      console.log(`User ${email} already exists and is already an admin. No change made.`);
    } else {
      existing.role = 'admin';
      await existing.save();
      console.log(`Promoted existing user ${email} to admin. Password unchanged.`);
    }
  } else {
    // The model's pre-save hook hashes the password with bcrypt.
    const created = await User.create({ name, email, password, role: 'admin' });
    console.log(`Created admin account ${created.email} (id ${created._id}).`);
  }

  // Make sure every declared index exists on the live collections.
  console.log('\nSynchronising indexes...');
  await Promise.all([
    User.syncIndexes(),
    Page.syncIndexes(),
    Term.syncIndexes(),
    Website.syncIndexes(),
    SearchLog.syncIndexes()
  ]);
  console.log('Indexes up to date.');

  await mongoose.disconnect();
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(error => {
    console.error('Setup failed:', error.message);
    process.exit(1);
  });
