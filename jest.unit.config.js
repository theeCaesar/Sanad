module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
  collectCoverageFrom: ['src/services/**/*.js', 'src/utils/**/*.js'],
  coverageThreshold: {
    './src/services/conflictResolver.js': {
      branches: 85, functions: 100, lines: 90, statements: 90,
    },
  },
  verbose: true,
};
