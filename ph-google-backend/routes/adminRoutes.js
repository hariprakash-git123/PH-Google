const express = require('express');
const adminController = require('../controllers/adminController');
const searchAdminController = require('../controllers/searchAdminController');
const { protect, adminOnly } = require('../middleware/authMiddleware');
const { crawlerLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Everything under /api/admin requires authentication AND the admin role.
router.use(protect, adminOnly);

router.get('/dashboard', adminController.getDashboard);
router.get('/metrics', adminController.getMetrics);
router.get('/pages', adminController.listPages);
router.get('/websites', adminController.listWebsites);
router.get('/users', adminController.listUsers);

// Search engine (OpenSearch): health, index stats and rebuilding.
router.get('/search/status', searchAdminController.getSearchStatus);
router.get('/search/reindex', searchAdminController.getReindexStatus);
router.post('/search/reindex', crawlerLimiter, searchAdminController.startReindex);
router.post('/search/settings/reload', crawlerLimiter, searchAdminController.reloadSearchSettings);
router.get('/search/sample', searchAdminController.sampleSearch);
// Development-only relevance debugging.
router.get('/search/explain', searchAdminController.explainQuery);
router.get('/search/analyze', searchAdminController.analyzeText);

// Crawler controls
router.get('/crawler/status', adminController.getCrawlerStatus);
router.get('/crawler/jobs', adminController.listCrawlerJobs);
router.get('/crawler/jobs/:id', adminController.getCrawlerJob);
router.get('/crawler/seeds', adminController.listSeedTopics);
router.post('/crawler/start', crawlerLimiter, adminController.startCrawl);
router.post('/crawler/stop', crawlerLimiter, adminController.stopCrawl);

module.exports = router;
