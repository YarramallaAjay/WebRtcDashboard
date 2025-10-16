import 'dotenv/config';
import { KafkaConsumerService } from './kafkaConsumer.js';
import { WebSocketServer } from './websocketServer.js';

// Configuration
const PORT = parseInt(process.env.PORT || '4000');
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || 'camera-events';
const KAFKA_GROUP_ID = process.env.KAFKA_GROUP_ID || 'websocket-alert-consumer';
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',');

console.log('==========================================');
console.log('WebSocket-Backend Service Starting...');
console.log('==========================================');
console.log('Configuration:');
console.log(`  PORT: ${PORT}`);
console.log(`  KAFKA_BROKERS: ${KAFKA_BROKERS.join(', ')}`);
console.log(`  KAFKA_TOPIC: ${KAFKA_TOPIC}`);
console.log(`  KAFKA_GROUP_ID: ${KAFKA_GROUP_ID}`);
console.log(`  CORS_ORIGINS: ${CORS_ORIGINS.join(', ')}`);
console.log('==========================================\n');

// Initialize WebSocket Server
const wsServer = new WebSocketServer(PORT, CORS_ORIGINS);

// Initialize Kafka Consumer
const kafkaConsumer = new KafkaConsumerService(
  KAFKA_BROKERS,
  KAFKA_GROUP_ID,
  KAFKA_TOPIC
);

// Register Kafka message handler to broadcast via WebSocket
kafkaConsumer.onMessage((alert) => {
  console.log('[Main] 📨 Received alert from Kafka, broadcasting via WebSocket...');
  wsServer.broadcastAlert(alert);
  console.log('[Main] ✓ Alert broadcast complete\n');
});

// Start services
async function start() {
  try {
    // Start WebSocket server
    await wsServer.start(PORT);

    // Connect to Kafka and start consuming
    console.log('[Main] Starting Kafka consumer...\n');
    await kafkaConsumer.connect(KAFKA_TOPIC);

    console.log('\n==========================================');
    console.log('✓✓✓ All services started successfully!');
    console.log('==========================================');
    console.log('Service is ready to:');
    console.log('  1. Receive face detection alerts from Kafka');
    console.log('  2. Broadcast alerts to WebSocket clients');
    console.log('==========================================\n');
  } catch (error) {
    console.error('✗✗✗ Failed to start services:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown() {
  console.log('\n[Main] Shutting down gracefully...');

  try {
    await kafkaConsumer.disconnect();
    await wsServer.stop();
    console.log('[Main] ✓ Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[Main] ✗ Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Main] ✗ Uncaught Exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] ✗ Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});

// Start the application
start();
