import { Kafka, Consumer, KafkaMessage } from 'kafkajs';
import { prisma } from '../utils/db.js';
import { io } from '../websocket.js';

interface FaceDetectionAlert {
  cameraId: string;
  cameraName: string;
  faceCount: number;
  confidence: number;
  imageData: string; // base64 encoded
  detectedAt: string;
  metadata?: {
    faces?: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  };
}

export class KafkaConsumerService {
  private kafka: Kafka;
  private consumer: Consumer;
  private isRunning: boolean = false;

  constructor() {
    const brokers = process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092','localhost:9093'];

    this.kafka = new Kafka({
      clientId: 'webrtc-dashboard-backend',
      brokers,
      retry: {
        initialRetryTime: 1000,
        retries: 8,
      },
    });

    this.consumer = this.kafka.consumer({
      groupId: 'face-detection-consumer-group',
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });
  }

  async start(): Promise<void> {
    try {
      console.log('Connecting Kafka consumer...');
      await this.consumer.connect();
      console.log('Kafka consumer connected');

      await this.consumer.subscribe({
        topic: 'camera-events',
        fromBeginning: false, // Only consume new messages
      });

      this.isRunning = true;

      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          await this.handleMessage(message);
        },
      });

      console.log('Kafka consumer started successfully');
    } catch (error) {
      console.error('Failed to start Kafka consumer:', error);
      throw error;
    }
  }

  private async handleMessage(message: KafkaMessage): Promise<void> {
    try {
      if (!message.value) {
        console.warn('Received empty Kafka message');
        return;
      }

      const alertData: FaceDetectionAlert = JSON.parse(message.value.toString());
      console.log(`Received face detection alert for camera ${alertData.cameraId}: ${alertData.faceCount} face(s)`);

      // Save alert to database
      const alert = await prisma.alert.create({
        data: {
          cameraId: alertData.cameraId,
          faceDetected: true,
          faceCount: alertData.faceCount,
          confidence: alertData.confidence,
          detectedAt: new Date(alertData.detectedAt),
          frameUrl: null, // Could be saved to S3/storage and URL stored here
          metadata: alertData.metadata,
        },
      });

      console.log(`Saved alert to database: ${alert.id}`);

      // Broadcast alert to WebSocket clients
      const notification = {
        id: alert.id,
        cameraId: alertData.cameraId,
        cameraName: alertData.cameraName,
        faceCount: alertData.faceCount,
        confidence: alertData.confidence,
        imageData: alertData.imageData,
        detectedAt: alertData.detectedAt,
        metadata: alertData.metadata,
      };

      io.emit('face-detection-alert', notification);
      console.log(`[Kafka] Alert broadcasted: camera ${alertData.cameraId}, ${alertData.faceCount} face(s)`);

    } catch (error) {
      console.error('Error processing Kafka message:', error);
      // Don't throw - we don't want to crash the consumer on processing errors
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      console.log('Stopping Kafka consumer...');
      this.isRunning = false;
      await this.consumer.disconnect();
      console.log('Kafka consumer stopped');
    } catch (error) {
      console.error('Error stopping Kafka consumer:', error);
      throw error;
    }
  }

  isConnected(): boolean {
    return this.isRunning;
  }
}

// Singleton instance
let kafkaConsumerInstance: KafkaConsumerService | null = null;

export function getKafkaConsumer(): KafkaConsumerService {
  if (!kafkaConsumerInstance) {
    kafkaConsumerInstance = new KafkaConsumerService();
  }
  return kafkaConsumerInstance;
}
