const express = require('express');
const historyController = require('../controllers/historyController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// History is private: every route requires a signed-in user and is scoped
// to that user's own rows.
router.use(protect);

router.get('/', historyController.getHistory);
router.post('/', historyController.addHistory);
router.delete('/:id', historyController.deleteHistoryItem);
router.delete('/', historyController.clearHistory);

module.exports = router;
