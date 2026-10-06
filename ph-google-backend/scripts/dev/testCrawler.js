require('dotenv').config();
const mongoose = require('mongoose');
const { startCrawler } = require('../../crawler/crawler');

async function run() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected!');

  // A very simple seed URL to test on.
  // It's a classic example domain that is very fast and safe to crawl.
  const seedUrl = 'https://example.com';

  // We limit it to 5 pages max for testing so it doesn't run forever.
  await startCrawler(seedUrl, 5);

  console.log('\nClosing MongoDB connection...');
  await mongoose.disconnect();
  console.log('Done.');
}

run().catch(console.error);
