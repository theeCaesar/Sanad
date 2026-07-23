
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');

const { typeDefs } = require('./schema');
const { resolvers, createLoaders } = require('./resolvers');
const logger = require('../utils/logger');

async function mountGraphQL(app, deps) {
  const { db, repos, authService } = deps;

  const server = new ApolloServer({
    typeDefs,
    resolvers,

    introspection: process.env.NODE_ENV !== 'production',

    formatError: (err) => {
      logger.error({ err: err.message }, 'graphql: error');
      return { message: err.message, code: err.extensions?.code };
    },
  });

  await server.start();

  app.use(
    '/graphql',
    deps.authMiddleware.protect,
    deps.authMiddleware.requireRole('admin', 'dispatcher'),
    expressMiddleware(server, {
      context: async ({ req }) => ({
        orgId: req.ctx.orgId,
        userId: req.ctx.userId,
        role: req.ctx.role,
        db,
        repos,
        loaders: createLoaders(db, req.ctx.orgId),
      }),
    })
  );

  logger.info('graphql: mounted at /graphql');
  return server;
}

module.exports = { mountGraphQL };
