const { randomUUID } = require('crypto');

module.exports = (req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || randomUUID();
  res.setHeader('x-trace-id', req.traceId);
  next();
};
