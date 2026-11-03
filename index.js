import pg from 'pg';
import { createApp } from './src/app.js';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const deploymentHost = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
const publicBaseUrl = process.env.PUBLIC_BASE_URL
  ?? (deploymentHost ? `https://${deploymentHost}` : '');

export default createApp(pool, { publicBaseUrl });
