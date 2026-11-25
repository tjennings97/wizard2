// Runs before each integration test file, before config.ts reads the environment.
import { testDatabaseUrl } from './dbUrl';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ??= 'test-session-secret';
process.env.PROMETHEUS_TOKEN ??= 'test-prometheus-token';
