require('dotenv').config();
const mongoose = require('mongoose');
const { startCrawler } = require('../../crawler/crawler');

/**
 * Crawls multiple seed URLs to populate the database with diverse, real content.
 * Each seed URL is crawled with a limit of 10 pages to keep it manageable.
 */
async function runBigCrawl() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected!\n');

  const seeds = [
    { url: 'https://en.wikipedia.org/wiki/Artificial_intelligence', max: 8 },
    { url: 'https://en.wikipedia.org/wiki/Web_search_engine', max: 8 },
    { url: 'https://en.wikipedia.org/wiki/Gold', max: 5 },
    { url: 'https://en.wikipedia.org/wiki/India', max: 5 },
    { url: 'https://en.wikipedia.org/wiki/JavaScript', max: 5 },
    { url: 'https://en.wikipedia.org/wiki/React_(software)', max: 5 },
    { url: 'https://en.wikipedia.org/wiki/Node.js', max: 5 },
    { url: 'https://en.wikipedia.org/wiki/MongoDB', max: 5 },
    { url: 'https://en.wikipedia.org/wiki/Machine_learning', max: 5 },
    { url: 'https://en.wikipedia.org/wiki/Cloud_computing', max: 5 },
    { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', max: 5 },
    { url: 'https://nodejs.org/en', max: 5 },
    { url: 'https://react.dev', max: 5 }
  ];

  console.log(`📦 Will crawl ${seeds.length} seed URLs...\n`);

  for (let i = 0; i < seeds.length; i++) {
    const { url, max } = seeds[i];
    console.log(`\n========================================`);
    console.log(`🌐 Seed ${i + 1}/${seeds.length}: ${url}`);
    console.log(`========================================`);

    try {
      await startCrawler(url, max);
    } catch (err) {
      console.error(`❌ Error crawling ${url}:`, err.message);
    }

    // Wait 2 seconds between seeds to be polite
    if (i < seeds.length - 1) {
      console.log('\n⏳ Waiting 2 seconds before next seed...');
      await new Promise(resolve => {
        setTimeout(resolve, 2000);
      });
    }
  }

  // Show final stats
  const Page = require('../../models/Page');
  const Website = require('../../models/Website');
  const Term = require('../../models/Term');

  const totalPages = await Page.countDocuments();
  const totalWebsites = await Website.countDocuments();
  const totalTerms = await Term.countDocuments();

  console.log(`\n\n🏁 ===== BIG CRAWL COMPLETE =====`);
  console.log(`📊 Total Pages indexed: ${totalPages}`);
  console.log(`🌐 Total Websites tracked: ${totalWebsites}`);
  console.log(`📝 Total unique words in index: ${totalTerms}`);

  await mongoose.disconnect();
  console.log('Done.');
}

runBigCrawl().catch(console.error);
