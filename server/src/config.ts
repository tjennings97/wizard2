import path from 'path';
import dotenv from 'dotenv';

// Load repo-root .env in local dev. In production (Railway) vars come from the environment.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const REQUIRED_VARS = ['DATABASE_URL', 'SESSION_SECRET', 'PROMETHEUS_TOKEN', 'NODE_ENV'] as const;
const NODE_ENVS = ['development', 'production', 'test'] as const;

type NodeEnv = (typeof NODE_ENVS)[number];

export interface Config {
  databaseUrl: string;
  sessionSecret: string;
  prometheusToken: string;
  nodeEnv: NodeEnv;
  port: number;
  isProduction: boolean;
  /** Origin allowed by CORS. Production: APP_ORIGIN. Otherwise: the Vite dev server. */
  corsOrigin: string;
  /** Number of reverse-proxy hops to trust for the client IP (Express `trust proxy`). */
  trustProxyHops: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED_VARS.filter((key) => !env[key] || env[key]!.trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill in every key.`,
    );
  }

  const nodeEnv = env.NODE_ENV as NodeEnv;
  if (!NODE_ENVS.includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV "${env.NODE_ENV}". Expected one of: ${NODE_ENVS.join(', ')}.`);
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT "${env.PORT}". Expected a positive integer.`);
  }

  // In production the CORS origin must be stated explicitly; never fall back to a default.
  const appOrigin = env.APP_ORIGIN?.trim();
  if (nodeEnv === 'production' && !appOrigin) {
    throw new Error('Missing required environment variable APP_ORIGIN (required when NODE_ENV=production).');
  }
  if (appOrigin && !/^https?:\/\/[^/]+$/.test(appOrigin)) {
    throw new Error(`Invalid APP_ORIGIN "${appOrigin}". Expected an origin like https://example.com (no path).`);
  }

  // Railway puts one proxy in front of the app, so production trusts one hop by default.
  // Locally there is no proxy, so X-Forwarded-For is ignored unless explicitly enabled.
  // An empty or blank value counts as unset, so it cannot silently become 0 behind Railway.
  const trustProxyHopsRaw = env.TRUST_PROXY_HOPS?.trim() || (nodeEnv === 'production' ? '1' : '0');
  const trustProxyHops = Number(trustProxyHopsRaw);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0) {
    throw new Error(`Invalid TRUST_PROXY_HOPS "${env.TRUST_PROXY_HOPS}". Expected a non-negative integer.`);
  }

  return {
    databaseUrl: env.DATABASE_URL!,
    sessionSecret: env.SESSION_SECRET!,
    prometheusToken: env.PROMETHEUS_TOKEN!,
    nodeEnv,
    port,
    isProduction: nodeEnv === 'production',
    corsOrigin: nodeEnv === 'production' ? appOrigin! : 'http://localhost:5173',
    trustProxyHops,
  };
}

export const config = loadConfig();
