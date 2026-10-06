const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoose = require('mongoose');

const { config } = require('./config/env');
const logger = require('./utils/logger');
const { sendSuccess } = require('./utils/apiResponse');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const openSearchClient = require('./services/opensearch/client');
const redisConnection = require('./services/queue/connection');

const authRoutes = require('./routes/authRoutes');
const searchRoutes = require('./routes/searchRoutes');
const suggestionRoutes = require('./routes/suggestionRoutes');
const historyRoutes = require('./routes/historyRoutes');
const adminRoutes = require('./routes/adminRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const aiRoutes = require('./routes/aiRoutes');
const imageRoutes = require('./routes/imageRoutes');

/**
 * Builds the Express application.
 *
 * Exported without calling listen() so the integration tests can drive it
 * with supertest against an in-memory MongoDB; server.js owns the socket.
 */
function createApp() {
  const app = express();

  // Correct client IPs behind a proxy, which the rate limiter depends on.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // --- Security headers -------------------------------------------------
  app.use(
    helmet({
      // This is a JSON API, not a page server: CSP/COEP would only restrict
      // responses nobody renders.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // Allow the frontend on another origin to read API responses.
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );

  // --- CORS -------------------------------------------------------------
  // Development allows the local Vite/CRA ports; production allows only the
  // origins listed in FRONTEND_URL.
  const allowedOrigins = config.isProduction
    ? config.cors.origins
    : [...config.cors.devOrigins, ...config.cors.origins];

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin/server-to-server requests send no Origin header.
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);

        logger.warn('Blocked CORS origin', { origin });
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    })
  );

  // --- Parsing & compression -------------------------------------------
  app.use(compression());
  // A modest body cap: no endpoint here accepts a large payload.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  // Express 5 leaves req.body as undefined when a request carries no body
  // (every GET/DELETE, and a POST sent without one). Normalising it here
  // means controllers can read req.body.field without a TypeError.
  app.use((req, res, next) => {
    if (req.body === undefined || req.body === null) req.body = {};
    next();
  });

  // --- Request logging --------------------------------------------------
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - startedAt;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      logger[level]('request', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        durationMs: duration
      });
    });
    next();
  });

  // --- Health -----------------------------------------------------------
  const health = async (req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    const ready = mongoose.connection.readyState;
    const mongoOk = ready === 1;

    // Report every store. MongoDB holds application data; OpenSearch powers
    // search; Redis carries the crawl queue.
    const [searchHealth, queueHealth] = await Promise.all([
      openSearchClient.checkHealth(),
      redisConnection.checkHealth()
    ]);
    const searchRequired = config.searchEngine === 'opensearch';
    const searchOk = searchHealth.ok || !searchRequired;

    return sendSuccess(res, {
      service: 'ph-google-backend',
      status: mongoOk && searchOk ? 'ok' : 'degraded',
      message: 'PH-Google backend is running.',
      environment: config.nodeEnv,
      database: {
        state: states[ready] || 'unknown',
        name: mongoose.connection.name || null,
        connected: mongoOk
      },
      search: {
        engine: config.searchEngine,
        connected: searchHealth.ok,
        status: searchHealth.status,
        node: searchHealth.node,
        index: searchHealth.index,
        cluster: searchHealth.clusterName || null,
        error: searchHealth.error || null
      },
      // Redis carries the crawl queue only. It being down stops new crawls
      // from being scheduled; it does not affect search or any request a
      // normal user makes, which is why it does not make the service
      // "degraded".
      queue: {
        connected: queueHealth.ok,
        url: queueHealth.url,
        status: queueHealth.status,
        error: queueHealth.error || null
      },
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date()
    });
  };

  app.get('/', health);
  app.get('/health', health);
  app.get('/api/health', health);

  // --- API routes -------------------------------------------------------
  app.use('/api/auth', authRoutes);
  app.use('/api/search', searchRoutes);
  app.use('/api/suggestions', suggestionRoutes);
  app.use('/api/history', historyRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/ai-answer', aiRoutes);
  app.use('/api/images', imageRoutes);

  // --- Errors -----------------------------------------------------------
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
