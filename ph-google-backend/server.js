const { config, assertValidConfig, configWarnings } = require('./config/env');
const logger = require('./utils/logger');
const { connectDatabase, disconnectDatabase } = require('./config/db');
const { createApp } = require('./app');
const crawlerJobService = require('./services/crawlerJobService');

function listenOnAvailablePort(app, preferredPort, maxAttempts = 10) {
  return new Promise((resolve, reject) => {
    const ports = Array.from({ length: maxAttempts }, (_, index) => preferredPort + index);
    let index = 0;

    function tryNextPort() {
      if (index >= ports.length) {
        reject(
          new Error(
            `No free port found in the range ${preferredPort}-${preferredPort + maxAttempts - 1}`
          )
        );
        return;
      }

      const port = ports[index];
      const server = app.listen(port, () => {
        resolve({ server, port });
      });

      server.on('error', error => {
        if (error.code === 'EADDRINUSE') {
          index += 1;
          server.close(() => {
            tryNextPort();
          });
          return;
        }

        reject(error);
      });
    }

    tryNextPort();
  });
}

/**
 * Entry point: validate configuration, connect to MongoDB, then listen.
 *
 * The server does not accept traffic until the database is reachable, so a
 * request can never hit a half-initialised process.
 */
async function start() {
  try {
    assertValidConfig();
  } catch (error) {
    // A config error is the developer's to fix; print it plainly and stop.
    console.error(`\n[STARTUP FAILED] ${error.message}\n`);
    process.exit(1);
  }

  const preferredPort = config.port;
  const candidatePorts = Array.from({ length: 10 }, (_, index) => preferredPort + index);

  logger.info('Starting PH-Google backend', {
    environment: config.nodeEnv,
    port: preferredPort,
    nodeVersion: process.version
  });

  for (const warning of configWarnings()) {
    logger.warn(warning);
  }

  try {
    await connectDatabase();
  } catch (error) {
    logger.error('Could not connect to MongoDB', { message: error.message });
    console.error(
      '\n[STARTUP FAILED] MongoDB connection failed. Check MONGO_URI and network access.\n'
    );
    process.exit(1);
  }

  // Note what used to happen here: every queued or running crawl job was
  // marked failed, on the assumption that the crawler ran in this process
  // and so a job still marked running had to be a leftover. Crawls now run
  // in the worker, and doing that on API startup would kill crawls a healthy
  // worker is part-way through. Abandoned jobs are detected by a silent
  // heartbeat instead, in crawlMaintenanceService.failOrphanedJobs.

  const app = createApp();
  let server;
  let activePort = preferredPort;

  try {
    const result = await listenOnAvailablePort(app, preferredPort, candidatePorts.length);
    server = result.server;
    activePort = result.port;
  } catch (error) {
    console.error(`\n[STARTUP FAILED] ${error.message}\n`);
    process.exit(1);
  }

  if (activePort !== preferredPort) {
    console.warn(
      `\n[WARN] Port ${preferredPort} is in use, switching to ${activePort}. Update your frontend VITE_API_BASE_URL if needed.\n`
    );
  }

  logger.info('Server listening', { url: `http://localhost:${activePort}` });
  console.log(`PH-Google backend ready on http://localhost:${activePort}`);

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n[STARTUP FAILED] Port ${activePort} is already in use.\n`);
      process.exit(1);
    }
    logger.error('HTTP server error', { message: error.message });
  });

  // --- Graceful shutdown -------------------------------------------------
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });

    // Crawls run in the worker process and are meant to survive an API
    // deploy, so nothing is cancelled here. cancelAllRunners is kept because
    // it is the seam a future in-process task would hook into; today it
    // does nothing and says so.
    crawlerJobService.cancelAllRunners();

    server.close(async () => {
      await disconnectDatabase();
      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Don't hang forever if a connection refuses to close.
    setTimeout(() => {
      logger.warn('Forcing exit after shutdown timeout');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', reason => {
    logger.error('Unhandled promise rejection', {
      message: reason instanceof Error ? reason.message : String(reason)
    });
  });

  process.on('uncaughtException', error => {
    logger.error('Uncaught exception', { error });
    // An unknown-state process must not keep serving traffic.
    shutdown('uncaughtException');
  });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { start };
