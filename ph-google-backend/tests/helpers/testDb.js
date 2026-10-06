const mongoose = require('mongoose');

/**
 * Isolated MongoDB for the test suite.
 *
 * Uses an in-memory MongoDB by default so tests never touch the real Atlas
 * database. Set MONGO_URI_TEST to point at a dedicated test database
 * instead (the suite clears collections between tests, so it must not be a
 * database holding real data).
 */

let memoryServer = null;

async function connect() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  let uri = process.env.MONGO_URI_TEST;

  if (!uri) {
    // Required lazily: loading it is slow and only needed when there is no
    // external test database configured.
    const { MongoMemoryServer } = require('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    uri = memoryServer.getUri();
  } else if (!/test/i.test(uri)) {
    throw new Error(
      'Refusing to run tests against MONGO_URI_TEST because its name does not contain "test". ' +
        'Point it at a dedicated test database.'
    );
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 30000,
    // Test-harness workaround, not needed in production.
    //
    // The MongoDB driver loads its `os` adapter with a dynamic `import('os')`
    // and squashes the error if that fails. Inside Jest's VM sandbox the
    // import does fail, so the driver silently sends an empty handshake and
    // the server rejects the connection with:
    //   "Missing required sub-document 'driver' in the client metadata document"
    // Injecting the adapter explicitly skips the dynamic import.
    runtimeAdapters: { os: require('os') }
  });
  return mongoose.connection;
}

/** Empties every collection without dropping the database. */
async function clear() {
  if (mongoose.connection.readyState !== 1) return;
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map(c => c.deleteMany({})));
}

async function disconnect() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase().catch(() => {
      /* best effort */
    });
    await mongoose.disconnect();
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

/** Creates the indexes declared on every registered model. */
async function syncIndexes() {
  await Promise.all(
    Object.values(mongoose.models).map(model => model.syncIndexes().catch(() => null))
  );
}

module.exports = { connect, clear, disconnect, syncIndexes };
