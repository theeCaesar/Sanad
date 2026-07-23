const http = require('http');
const metrics = require('./metrics');
const logger = require('./logger');

function startMetricsServer(port, name) {
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404);
      return res.end('not found');
    }
    res.setHeader('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  });

  server.listen(port, () => logger.info({ port, name }, 'metrics: listening'));
  return server;
}

module.exports = { startMetricsServer };
