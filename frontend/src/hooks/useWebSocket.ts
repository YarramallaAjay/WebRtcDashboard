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

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

export const useWebSocket = (): UseWebSocketReturn => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState<FaceDetectionAlert[]>([]);

  useEffect(() => {
    console.log('Initializing WebSocket connection to', BACKEND_URL);

    // Create socket connection without authentication for now
    const newSocket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });

    newSocket.on('connect', () => {
      console.log('WebSocket connected:', newSocket.id);
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('WebSocket disconnected');
      setConnected(false);
    });

    newSocket.on('connected', (data: any) => {
      console.log('WebSocket server message:', data);
    });

    newSocket.on('face-detection-alert', (alert: FaceDetectionAlert) => {
      console.log('Received face detection alert:', alert);
      setAlerts((prev) => [alert, ...prev].slice(0, 50)); // Keep last 50 alerts
    });

    newSocket.on('connect_error', (error: Error) => {
      console.error('WebSocket connection error:', error);
    });

    setSocket(newSocket);

    return () => {
      console.log('Cleaning up WebSocket connection');
      newSocket.close();
    };
  }, []);

  const subscribeToCamera = useCallback(
    (cameraId: string) => {
      if (socket && connected) {
        console.log('Subscribing to camera:', cameraId);
        socket.emit('subscribe:camera', cameraId);
      }
    },
    [socket, connected]
  );

  const unsubscribeFromCamera = useCallback(
    (cameraId: string) => {
      if (socket && connected) {
        console.log('Unsubscribing from camera:', cameraId);
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
