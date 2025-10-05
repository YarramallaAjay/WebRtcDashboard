import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { JWTPayload } from './types.js';

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-key';

let io: SocketIOServer;

export const initializeWebSocket = (server: HTTPServer) => {
  io = new SocketIOServer(server, {
    cors: {
      origin: ['*'],
      credentials: true,
    },
  });

  // Authentication middleware for WebSocket connections (DISABLED FOR TESTING)
  // TODO: Re-enable authentication when auth system is active
  // io.use((socket, next) => {
  //   const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(' ')[1];

  //   if (!token) {
  //     return next(new Error('Authentication token required'));
  //   }

  //   try {
  //     const payload = jwt.verify(token, JWT_SECRET) as JWTPayload;
  //     socket.data.user = payload;
  //     next();
  //   } catch (error) {
  //     next(new Error('Invalid authentication token'));
  //   }
  // });

  io.on('connection', (socket) => {
    // const user = socket.data.user as JWTPayload;
    console.log(`[WebSocket] Client connected: ${socket.id}`);

    // Join user to their personal room for targeted alerts
    // socket.join(`user:${user.userId}`);

    // Handle client requesting to join specific camera alerts
    socket.on('subscribe:camera', (cameraId: string) => {
      socket.join(`camera:${cameraId}`);
      // Only log on first subscription per socket to reduce noise
      if (socket.rooms.size === 2) { // socket.id room + first camera room
        console.log(`[WebSocket] Client ${socket.id} subscribing to cameras...`);
      }
    });

    // Handle client unsubscribing from camera alerts
    socket.on('unsubscribe:camera', (cameraId: string) => {
      socket.leave(`camera:${cameraId}`);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`[WebSocket] Client ${socket.id} disconnected`);
    });

    // Send welcome message
    socket.emit('connected', {
      message: 'Connected to real-time alerts',
      timestamp: new Date().toISOString()
    });
  });

  console.log('WebSocket server initialized');
  return io;
};

// Broadcast alert to specific camera subscribers
export const broadcastAlert = (alert: any) => {
  if (!io) {
    console.warn('WebSocket server not initialized');
    return;
  }

  // Broadcast to camera-specific room
  io.to(`camera:${alert.cameraId}`).emit('alert', {
    type: 'face_detected',
    alert,
    timestamp: new Date().toISOString()
  });

  // Also broadcast to user's personal room if camera belongs to them
  if (alert.camera?.userId) {
    io.to(`user:${alert.camera.userId}`).emit('alert', {
      type: 'face_detected',
      alert,
      timestamp: new Date().toISOString()
    });
  }

  console.log(`Alert broadcasted for camera ${alert.cameraId}`);
};

// Broadcast camera status changes
export const broadcastCameraStatus = (cameraId: string, status: 'started' | 'stopped', userId: string) => {
  if (!io) {
    console.warn('WebSocket server not initialized');
    return;
  }

  const message = {
    type: 'camera_status',
    cameraId,
    status,
    timestamp: new Date().toISOString()
  };

  // Broadcast to camera-specific room
  io.to(`camera:${cameraId}`).emit('camera_status', message);

  // Broadcast to user's personal room
  io.to(`user:${userId}`).emit('camera_status', message);

  console.log(`Camera ${cameraId} status broadcasted: ${status}`);
};

export const getIO = () => io;

// Export io for use in Kafka consumer
export { io };