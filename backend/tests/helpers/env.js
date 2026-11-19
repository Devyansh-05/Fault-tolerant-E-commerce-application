// Must be the FIRST import of every test file: switches config to the test database
// (MONGODB_TEST_DB_NAME) and the "ecomtest" Redis key prefix before config/env.js loads.
process.env.NODE_ENV = 'test';
