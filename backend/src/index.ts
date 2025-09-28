import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
// import { auth } from './routes/auth.js';
import { cameras } from './routes/cameras.js';
// import { cameraControl } from './routes/cameraControl.js';
import { alerts } from './routes/alerts.js';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
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

console.log(`Server starting on port ${port}`);

// Start simple server without WebSocket temporarily
serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`Server running at http://localhost:${info.port}`);
});