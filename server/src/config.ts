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
}

function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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

  return {
    databaseUrl: env.DATABASE_URL!,
    sessionSecret: env.SESSION_SECRET!,
    prometheusToken: env.PROMETHEUS_TOKEN!,
    nodeEnv,
    port,
    isProduction: nodeEnv === 'production',
  };
}

export const config = loadConfig();
