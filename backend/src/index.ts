import 'dotenv/config';
import { Hono } from 'hono';
import { serve, createAdaptorServer } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
// import { auth } from './routes/auth.js';
import { cameras } from './routes/cameras.js';
// import { cameraControl } from './routes/cameraControl.js';
import { alerts } from './routes/alerts.js';
import { initializeWebSocket } from './websocket.js';
import { getKafkaConsumer } from './services/kafkaConsumer.js';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8080'],
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

// Create HTTP server using createAdaptorServer
const server = createAdaptorServer(app);

// Start the server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log('WebSocket server ready');
});

// Initialize WebSocket server
console.log('Initializing WebSocket server...');
initializeWebSocket(server as any);

// Start Kafka consumer
console.log('Starting Kafka consumer...');
const kafkaConsumer = getKafkaConsumer();
kafkaConsumer.start().catch((error) => {
  console.error('Failed to start Kafka consumer:', error);
  console.warn('Application will continue without face detection alerts');
});


// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await kafkaConsumer.stop();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await kafkaConsumer.stop();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});