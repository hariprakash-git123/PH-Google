const request = require('supertest');
const User = require('../../models/User');
const Website = require('../../models/Website');
const Page = require('../../models/Page');
const Term = require('../../models/Term');
const CrawlMaintenanceState = require('../../models/CrawlMaintenanceState');
const { calculateFrequencies, tokenizeText } = require('../../utils/textProcessor');

/**
 * Builders for test data.
 *
 * Pages created here go through the same tokenisation the crawler uses, so
 * the inverted index in a test is built exactly the way production builds it.
 */

/** Creates a user and returns { user, token } by registering + logging in. */
async function createUserWithToken(
  app,
  { name = 'Test User', email = 'user@example.com', password = 'password123', role } = {}
) {
  const res = await request(app).post('/api/auth/register').send({ name, email, password });
  if (res.status !== 201) {
    throw new Error(`Failed to register test user: ${res.status} ${JSON.stringify(res.body)}`);
  }

  let token = res.body.data.token;
  const user = await User.findOne({ email });

  // Registration always creates a normal user; force the role when the test
  // asks for something specific (as `npm run create-admin` would).
  if (role && user.role !== role) {
    user.role = role;
    await user.save();
    // Re-login so the caller's token reflects the stored role.
    const login = await request(app).post('/api/auth/login').send({ email, password });
    token = login.body.data.token;
  }

  return { user, token, password };
}

/**
 * Seeds one page plus its inverted-index postings.
 *
 * @returns {Promise<Page>}
 */
async function seedPage({
  url,
  title = '',
  description = '',
  text = '',
  language = 'en',
  status = 'indexed',
  lastCrawledAt = new Date()
}) {
  const domain = new URL(url).hostname.toLowerCase();

  let website = await Website.findOne({ domain });
  if (!website) {
    website = await Website.create({ domain, status: 'completed', lastCrawledAt });
  }

  const page = await Page.create({
    websiteId: website._id,
    url,
    domain,
    title,
    description,
    content: text,
    language,
    status,
    lastCrawledAt
  });

  // Index the title and body together, mirroring how the crawler indexes.
  const tokens = tokenizeText(`${title} ${description} ${text}`);
  const frequencies = calculateFrequencies(tokens);

  const ops = Object.entries(frequencies).map(([word, frequency]) => ({
    updateOne: {
      filter: { word },
      update: { $setOnInsert: { word }, $push: { documents: { pageId: page._id, frequency } } },
      upsert: true
    }
  }));
  if (ops.length > 0) await Term.bulkWrite(ops, { ordered: false });

  return page;
}

/**
 * Seeds `count` pages that all match the given keyword, for pagination tests.
 */
async function seedManyPages(count, { keyword = 'pagination', domain = 'example.com' } = {}) {
  const pages = [];
  for (let i = 1; i <= count; i += 1) {
    pages.push(
      await seedPage({
        url: `https://${domain}/page-${i}`,
        title: `${keyword} result number ${i}`,
        description: `Description for ${keyword} document ${i}.`,
        text: `${keyword} `.repeat(Math.max(1, count - i + 1)) + `body text for document ${i}.`,
        // Stagger crawl dates so date sorting is deterministic.
        lastCrawledAt: new Date(Date.now() - i * 60 * 60 * 1000)
      })
    );
  }
  return pages;
}

const auth = token => ({ Authorization: `Bearer ${token}` });

/**
 * Records that the maintenance sweep has been running without a break for
 * `sinceMs`, with its last pass a minute ago — what a long-lived, healthy
 * worker leaves behind. The orphan check only judges jobs once it has been
 * watching that long, so tests of it start here.
 */
async function crawlerRunningFor(sinceMs, { now = new Date() } = {}) {
  await CrawlMaintenanceState.findOneAndUpdate(
    { _id: 'orphan-detection' },
    {
      $set: {
        observingSince: new Date(now.getTime() - sinceMs),
        lastSweepAt: new Date(now.getTime() - 60 * 1000)
      }
    },
    { upsert: true }
  );
}

module.exports = { createUserWithToken, seedPage, seedManyPages, auth, crawlerRunningFor };
