import { useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

export interface FaceDetectionAlert {
  id: string;
  cameraId: string;
  cameraName: string;
  faceCount: number;
  confidence: number;
  imageData: string; // base64
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

interface UseWebSocketReturn {
  socket: Socket | null;
  connected: boolean;
  alerts: FaceDetectionAlert[];
  subscribeToCamera: (cameraId: string) => void;
  unsubscribeFromCamera: (cameraId: string) => void;
  clearAlerts: () => void;
}

// Use dedicated WebSocket service (default port 4000)
const WEBSOCKET_URL = import.meta.env.VITE_WEBSOCKET_URL || 'http://localhost:4000';

export const useWebSocket = (): UseWebSocketReturn => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState<FaceDetectionAlert[]>([]);

  useEffect(() => {
    console.log('========================================');
    console.log('[WebSocket] Initializing connection...');
    console.log('[WebSocket] URL:', WEBSOCKET_URL);
    console.log('========================================');

    // Create socket connection to dedicated WebSocket service
    const newSocket = io(WEBSOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
      timeout: 10000,
    });

    newSocket.on('connect', () => {
      console.log('[WebSocket] ✓ Connected successfully!');
      console.log('[WebSocket] Socket ID:', newSocket.id);
      console.log('[WebSocket] Transport:', newSocket.io.engine.transport.name);
      setConnected(true);
    });

    newSocket.on('disconnect', (reason) => {
      console.log('[WebSocket] ✗ Disconnected');
      console.log('[WebSocket] Reason:', reason);
      setConnected(false);
    });

    newSocket.on('connected', (data: any) => {
      console.log('[WebSocket] 📩 Server welcome message:', data);
    });

    newSocket.on('face-detection-alert', (alert: FaceDetectionAlert) => {
      console.log('[WebSocket] ========================================');
      console.log('[WebSocket] 🔔 FACE DETECTION ALERT RECEIVED!');
      console.log('[WebSocket] Camera:', alert.cameraName);
      console.log('[WebSocket] Face Count:', alert.faceCount);
      console.log('[WebSocket] Time:', alert.detectedAt);
      console.log('[WebSocket] ========================================');
      setAlerts((prev) => [alert, ...prev].slice(0, 50)); // Keep last 50 alerts
    });

    newSocket.on('connect_error', (error: Error) => {
      console.error('[WebSocket] ✗ Connection error:', error.message);
    });

    newSocket.on('reconnect', (attemptNumber: number) => {
      console.log('[WebSocket] ↻ Reconnected after', attemptNumber, 'attempts');
    });

    newSocket.on('reconnect_attempt', (attemptNumber: number) => {
      console.log('[WebSocket] ↻ Reconnection attempt', attemptNumber);
    });

    newSocket.on('reconnect_error', (error: Error) => {
      console.error('[WebSocket] ✗ Reconnection error:', error.message);
    });

    newSocket.on('reconnect_failed', () => {
      console.error('[WebSocket] ✗✗✗ Reconnection failed after all attempts');
    });

    setSocket(newSocket);

    return () => {
      console.log('[WebSocket] 🔌 Cleaning up connection');
      newSocket.close();
    };
  }, []);

  const subscribeToCamera = useCallback(
    (cameraId: string) => {
      if (socket && connected) {
        console.log('[WebSocket] 📝 Subscribing to camera:', cameraId);
        socket.emit('subscribe:camera', cameraId);
      } else {
        console.warn('[WebSocket] ⚠️ Cannot subscribe - not connected');
      }
    },
    [socket, connected]
  );

  const unsubscribeFromCamera = useCallback(
    (cameraId: string) => {
      if (socket && connected) {
        console.log('[WebSocket] 📝 Unsubscribing from camera:', cameraId);
        socket.emit('unsubscribe:camera', cameraId);
      }
    },
    [socket, connected]
  );

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  return {
    socket,
    connected,
    alerts,
    subscribeToCamera,
    unsubscribeFromCamera,
    clearAlerts,
  };
};
