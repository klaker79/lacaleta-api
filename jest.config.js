// Jest config para cargar .env antes de tests
require('dotenv').config();

module.exports = {
    testEnvironment: 'node',
    testTimeout: 10000,
    verbose: true,
    setupFilesAfterEnv: ['./tests/setup.js']
};
