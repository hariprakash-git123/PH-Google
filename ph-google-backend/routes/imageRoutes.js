const express = require('express');
const imageController = require('../controllers/imageController');
const { imageLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// The Download button in image search. Open to guests, like search itself;
// the address must carry this server's signature (see imageController).
router.get('/download', imageLimiter, imageController.download);

module.exports = router;
