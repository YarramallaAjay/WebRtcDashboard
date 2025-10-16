import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';

interface FaceDetectionAlert {
  cameraId: string;
  cameraName: string;
  faceCount: number;
  confidence: number;
  imageData: string;
  detectedAt: string;
  metadata?: any;
}

export class WebSocketServer {
  private io: SocketIOServer;
  private httpServer: any;

  constructor(port: number, corsOrigin: string[]) {
    console.log('[WebSocket] Initializing WebSocket server...');
    console.log('[WebSocket] Port:', port);
    console.log('[WebSocket] CORS Origins:', corsOrigin.join(', '));

    this.httpServer = createServer();

    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin: corsOrigin,
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket) => {
      console.log('[WebSocket] ========================================');
      console.log('[WebSocket] ✓ New client connected!');
      console.log('[WebSocket] Socket ID:', socket.id);
      console.log('[WebSocket] Transport:', socket.conn.transport.name);
      console.log('[WebSocket] Total connected clients:', this.io.engine.clientsCount);
      console.log('[WebSocket] ========================================');

      // Send welcome message
      socket.emit('connected', {
        message: 'Connected to face detection alerts service',
        timestamp: new Date().toISOString(),
        socketId: socket.id,
      });

      // Handle camera subscription
      socket.on('subscribe:camera', (cameraId: string) => {
        socket.join(`camera:${cameraId}`);
        console.log(`[WebSocket] Client ${socket.id} subscribed to camera: ${cameraId}`);
        console.log(`[WebSocket] Client rooms:`, Array.from(socket.rooms));
      });

      // Handle camera unsubscription
      socket.on('unsubscribe:camera', (cameraId: string) => {
        socket.leave(`camera:${cameraId}`);
        console.log(`[WebSocket] Client ${socket.id} unsubscribed from camera: ${cameraId}`);
      });

      // Handle ping/pong for connection testing
      socket.on('ping', () => {
        socket.emit('pong', { timestamp: new Date().toISOString() });
      });

      // Handle disconnect
      socket.on('disconnect', (reason) => {
        console.log('[WebSocket] ========================================');
        console.log('[WebSocket] ✗ Client disconnected');
        console.log('[WebSocket] Socket ID:', socket.id);
        console.log('[WebSocket] Reason:', reason);
        console.log('[WebSocket] Remaining clients:', this.io.engine.clientsCount);
        console.log('[WebSocket] ========================================');
      });

      // Handle errors
      socket.on('error', (error) => {
        console.error('[WebSocket] ✗ Socket error:', error);
      });
    });

    this.io.engine.on('connection_error', (err) => {
      console.error('[WebSocket] ✗ Connection error:', err);
    });
  }

  broadcastAlert(alert: FaceDetectionAlert): void {
    console.log('[WebSocket] ========================================');
    console.log('[WebSocket] 📢 Broadcasting face detection alert!');
    console.log('[WebSocket] Camera ID:', alert.cameraId);
    console.log('[WebSocket] Camera Name:', alert.cameraName);
    console.log('[WebSocket] Face Count:', alert.faceCount);
    console.log('[WebSocket] Connected clients:', this.io.engine.clientsCount);

    const notification = {
      id: `alert_${Date.now()}_${alert.cameraId}`,
      cameraId: alert.cameraId,
      cameraName: alert.cameraName,
      faceCount: alert.faceCount,
      confidence: alert.confidence,
      imageData: alert.imageData,
      detectedAt: alert.detectedAt,
      metadata: alert.metadata,
    };

    // Broadcast to all connected clients
    this.io.emit('face-detection-alert', notification);
    console.log('[WebSocket] ✓ Alert broadcasted to all clients');

    // Also broadcast to camera-specific room
    const cameraRoom = `camera:${alert.cameraId}`;
    const roomSize = this.io.sockets.adapter.rooms.get(cameraRoom)?.size || 0;
    console.log(`[WebSocket] Camera-specific room "${cameraRoom}" has ${roomSize} subscribers`);

    if (roomSize > 0) {
      this.io.to(cameraRoom).emit('camera-alert', notification);
      console.log(`[WebSocket] ✓ Alert also sent to camera room: ${cameraRoom}`);
    }

    console.log('[WebSocket] ========================================');
  }

  start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(port, () => {
        console.log('==========================================');
        console.log(`✓ WebSocket server running on port ${port}`);
        console.log(`✓ Listening for connections at ws://localhost:${port}`);
        console.log('==========================================');
        resolve();
      });
    });
  }

  getConnectedClientsCount(): number {
    return this.io.engine.clientsCount;
  }

  async stop(): Promise<void> {
    console.log('[WebSocket] Stopping server...');

    // Disconnect all clients
    this.io.disconnectSockets();

    // Close server
    return new Promise((resolve, reject) => {
      this.httpServer.close((err: any) => {
        if (err) {
          console.error('[WebSocket] ✗ Error stopping server:', err);
          reject(err);
        } else {
          console.log('[WebSocket] ✓ Server stopped');
          resolve();
        }
      });
    });
  }
}
