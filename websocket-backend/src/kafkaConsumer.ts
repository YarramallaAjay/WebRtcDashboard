import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';

interface FaceDetectionAlert {
  cameraId: string;
  cameraName: string;
  faceCount: number;
  confidence: number;
  imageData: string;
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
  private messageHandler?: (alert: FaceDetectionAlert) => void;

  constructor(brokers: string[], groupId: string, topic: string) {
    console.log('[Kafka] Initializing Kafka consumer...');
    console.log('[Kafka] Brokers:', brokers.join(', '));
    console.log('[Kafka] Group ID:', groupId);
    console.log('[Kafka] Topic:', topic);

    this.kafka = new Kafka({
      clientId: 'websocket-backend',
      brokers,
      retry: {
        initialRetryTime: 1000,
        retries: 8,
      },
      logLevel: 2, // ERROR level
    });

    this.consumer = this.kafka.consumer({
      groupId,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });
  }

  async connect(topic: string): Promise<void> {
    try {
      console.log('[Kafka] Connecting to Kafka...');
      await this.consumer.connect();
      console.log('[Kafka] ✓ Connected to Kafka');

      console.log(`[Kafka] Subscribing to topic: ${topic}`);
      await this.consumer.subscribe({
        topic,
        fromBeginning: false,
      });
      console.log('[Kafka] ✓ Subscribed to topic');

      this.isRunning = true;

      await this.consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          await this.handleMessage(payload);
        },
      });

      console.log('[Kafka] ✓✓✓ Kafka consumer is now listening for messages...');
    } catch (error) {
      console.error('[Kafka] ✗ Failed to connect/subscribe:', error);
      throw error;
    }
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    try {
      const { topic, partition, message } = payload;

      console.log('[Kafka] ========================================');
      console.log('[Kafka] 🔔 New message received!');
      console.log('[Kafka] Topic:', topic);
      console.log('[Kafka] Partition:', partition);
      console.log('[Kafka] Offset:', message.offset);

      if (!message.value) {
        console.warn('[Kafka] ⚠️ Empty message received');
        return;
      }

      const messageString = message.value.toString();
      console.log('[Kafka] Message size:', messageString.length, 'bytes');
      console.log('[Kafka] Raw message preview:', messageString.substring(0, 150) + '...');

      const alertData: FaceDetectionAlert = JSON.parse(messageString);

      console.log('[Kafka] ✓ Parsed alert data:');
      console.log('[Kafka]   Camera ID:', alertData.cameraId);
      console.log('[Kafka]   Camera Name:', alertData.cameraName);
      console.log('[Kafka]   Face Count:', alertData.faceCount);
      console.log('[Kafka]   Confidence:', alertData.confidence);
      console.log('[Kafka]   Detected At:', alertData.detectedAt);
      console.log('[Kafka]   Has Image Data:', !!alertData.imageData);
      console.log('[Kafka]   Has Metadata:', !!alertData.metadata);

      // Call the registered message handler (WebSocket broadcast)
      if (this.messageHandler) {
        console.log('[Kafka] 📤 Passing alert to WebSocket handler...');
        this.messageHandler(alertData);
      } else {
        console.warn('[Kafka] ⚠️ No message handler registered!');
      }

      console.log('[Kafka] ========================================');
    } catch (error) {
      console.error('[Kafka] ✗✗✗ Error processing message:', error);
      console.error('[Kafka] Error details:', error instanceof Error ? error.message : String(error));
    }
  }

  onMessage(handler: (alert: FaceDetectionAlert) => void): void {
    console.log('[Kafka] Message handler registered');
    this.messageHandler = handler;
  }

  async disconnect(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      console.log('[Kafka] Disconnecting...');
      this.isRunning = false;
      await this.consumer.disconnect();
      console.log('[Kafka] ✓ Disconnected');
    } catch (error) {
      console.error('[Kafka] ✗ Error disconnecting:', error);
      throw error;
    }
  }

  isConnected(): boolean {
    return this.isRunning;
  }
}
