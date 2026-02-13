// Jest config — SIEMPRE usa .env.test (nunca .env de producción)
require('dotenv').config({ path: '.env.test' });

module.exports = {
    testEnvironment: 'node',
    testTimeout: 10000,
    verbose: true,
    setupFilesAfterEnv: ['./tests/setup.js']
};
