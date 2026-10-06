const mongoose = require('mongoose');
const { config } = require('./env');
const logger = require('../utils/logger');

/**
 * Connects to MongoDB. Resolves once the connection is usable so the server
 * never starts accepting traffic against a dead database.
 */
async function connectDatabase(uri = config.mongoUri) {
  if (!uri) throw new Error('MONGO_URI is not configured.');

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', err =>
    logger.error('MongoDB connection error', { message: err.message })
  );

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 20000,
    maxPoolSize: 10
  });

  logger.info('MongoDB connected', { database: mongoose.connection.name });
  return mongoose.connection;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected cleanly');
  }
}

/** True when queries can actually be served. */
function isDatabaseReady() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connectDatabase, disconnectDatabase, isDatabaseReady };
