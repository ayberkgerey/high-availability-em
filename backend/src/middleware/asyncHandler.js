'use strict';

/** Forwards rejected promises from async route handlers to Express error handling. */
module.exports = function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
};
