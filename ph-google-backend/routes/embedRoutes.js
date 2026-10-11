const express = require('express');
const embedController = require('../controllers/embedController');
const { embedLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Whether a page may be framed in an in-app browser tab. Open to guests,
// like search itself; headers only, public addresses only.
router.get('/', embedLimiter, embedController.check);

module.exports = router;
