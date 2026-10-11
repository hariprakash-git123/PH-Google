const errorHandler = require('../../middleware/errorHandler');
const { ApiError } = require('../../utils/apiResponse');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');

/** What a failed request tells the visitor in production. */

const handler = typeof errorHandler === 'function' ? errorHandler : errorHandler.errorHandler;

function respond(err) {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  handler(err, { method: 'GET', originalUrl: '/api/search' }, res, () => {});
  return res;
}

describe('error messages in production', () => {
  const wasProduction = config.isProduction;
  beforeAll(() => {
    config.isProduction = true;
    jest.spyOn(logger, 'error').mockImplementation(() => {});
  });
  afterAll(() => {
    config.isProduction = wasProduction;
    jest.restoreAllMocks();
  });

  it('a "try again" this server chose to send is shown as written', () => {
    const res = respond(
      ApiError.serviceUnavailable(
        'More results could not be loaded right now. Try again in a moment.'
      )
    );
    expect(res.statusCode).toBe(503);
    expect(res.body.message).toBe(
      'More results could not be loaded right now. Try again in a moment.'
    );
  });

  it('anything unexpected still shows nothing of the server’s internals', () => {
    const crash = respond(new Error('connect ECONNREFUSED 10.0.0.5:27017'));
    expect(crash.statusCode).toBe(500);
    expect(crash.body.message).toBe('Internal server error.');
    // An unexpected error that happens to say 503 is not shown either.
    const odd = respond(Object.assign(new Error('pool exhausted at db-2'), { statusCode: 503 }));
    expect(odd.body.message).toBe('Internal server error.');
    // Nor is a 500 raised on purpose.
    expect(respond(new ApiError('detail', 500)).body.message).toBe('Internal server error.');
  });
});
