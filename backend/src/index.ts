import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
// import { auth } from './routes/auth.js';
import { cameras } from './routes/cameras.js';
// import { cameraControl } from './routes/cameraControl.js';
import { alerts } from './routes/alerts.js';
import { system } from './routes/system.js';
import { getHealthChecker } from './services/healthChecker.js';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
}));

// Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Routes (auth and cameraControl temporarily disabled for Phase 1)
// app.route('/api/auth', auth);
app.route('/api/cameras', cameras);
// app.route('/api/cameras', cameraControl);
app.route('/api/alerts', alerts);
app.route('/api/system', system);

// Default route
app.get('/', (c) => {
  return c.json({
    message: 'Skylark Labs Camera Dashboard API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      cameras: '/api/cameras',
      alerts: '/api/alerts'
    }
  });
});

const port = parseInt(process.env.PORT || '3000');

console.log('==========================================');
console.log('Backend API Server Starting...');
console.log('==========================================');
console.log('Environment Configuration:');
console.log(`  PORT: ${process.env.PORT || '3000'}`);
console.log(`  DATABASE_URL: ${process.env.DATABASE_URL ? '***configured***' : 'NOT SET'}`);
console.log(`  JWT_SECRET: ${process.env.JWT_SECRET ? '***configured***' : 'NOT SET'}`);
console.log(`  WORKER_URL: ${process.env.WORKER_URL || 'NOT SET'}`);
console.log('==========================================');
console.log('NOTE: WebSocket and Kafka services are handled by websocket-backend service');
console.log('==========================================');

// Initialize health checker
const healthChecker = getHealthChecker();
healthChecker.start().catch((error) => {
  console.error('[HealthChecker] Failed to start:', error);
});

// Start the server
serve({
  fetch: app.fetch,
  port,
});

console.log('==========================================');
console.log(`✓ Backend API Server running at http://localhost:${port}`);
console.log('==========================================');
console.log('Available Routes:');
console.log('  GET  /health');
console.log('  GET  /api/cameras');
console.log('  POST /api/cameras');
console.log('  GET  /api/alerts');
console.log('  GET  /api/system/health');
console.log('  GET  /api/system/health/:service');
console.log('  GET  /api/system/ready');
console.log('==========================================');

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  healthChecker.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  healthChecker.stop();
  process.exit(0);
});