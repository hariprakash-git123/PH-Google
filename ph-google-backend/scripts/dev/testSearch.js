require('dotenv').config();
const mongoose = require('mongoose');
const Term = require('../../models/Term');
const Page = require('../../models/Page');
const Website = require('../../models/Website');
const { tokenizeText } = require('../../utils/textProcessor');
const { calculateScore } = require('../../services/rankingService');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB!\n');

  // Show database stats
  const totalPages = await Page.countDocuments();
  const totalWebsites = await Website.countDocuments();
  const totalTerms = await Term.countDocuments();
  console.log(`📊 Database Stats:`);
  console.log(`   Pages indexed: ${totalPages}`);
  console.log(`   Websites tracked: ${totalWebsites}`);
  console.log(`   Unique words in index: ${totalTerms}`);

  // Test a search query
  const searchQuery = 'domain';
  console.log(`\n🔍 Searching for: "${searchQuery}"\n`);

  const searchTerms = tokenizeText(searchQuery);
  console.log(`   Cleaned tokens: [${searchTerms.join(', ')}]`);

  // Query inverted index
  const terms = await Term.find({ word: { $in: searchTerms } });
  console.log(`   Found ${terms.length} matching term(s) in index.`);

  // Collect page IDs and frequencies
  const pageScoresMap = new Map();
  for (const termDoc of terms) {
    for (const doc of termDoc.documents) {
      const pageIdStr = doc.pageId.toString();
      if (!pageScoresMap.has(pageIdStr)) {
        pageScoresMap.set(pageIdStr, { pageId: doc.pageId, frequencySum: doc.frequency });
      } else {
        pageScoresMap.get(pageIdStr).frequencySum += doc.frequency;
      }
    }
  }

  // Fetch pages
  const pageIds = Array.from(pageScoresMap.values()).map(p => p.pageId);
  const pages = await Page.find({ _id: { $in: pageIds } }).lean();

  // Calculate scores
  const results = pages.map(page => {
    const freq = pageScoresMap.get(page._id.toString()).frequencySum;
    const score = calculateScore(page, searchTerms, freq);
    return { title: page.title || page.url, url: page.url, score, frequency: freq };
  });

  results.sort((a, b) => b.score - a.score);

  console.log(`\n🏆 Ranked Results:\n`);
  results.forEach((r, i) => {
    console.log(`   #${i + 1} [Score: ${r.score}] ${r.title}`);
    console.log(`       URL: ${r.url}`);
    console.log(`       Keyword frequency: ${r.frequency}`);
    console.log('');
  });

  console.log('✅ Search test completed successfully!');
  await mongoose.disconnect();
}

run().catch(console.error);
