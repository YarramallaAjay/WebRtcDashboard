# WebRTC Dashboard - Comprehensive Refactoring Plan

**Priority**: Critical for Production Readiness
**Estimated Time**: 6-8 weeks with dedicated team
**Status**: Planning Phase

---

## Overview

This document outlines the complete refactoring plan to address critical architectural issues, improve reliability, and enhance user experience.

### Goals

1. ✅ **Loose Coupling**: Decouple services using async messaging
2. ✅ **Health Monitoring**: Implement comprehensive health checking with visual indicators
3. ✅ **Stream Isolation**: Prevent cascading failures between streams
4. ✅ **Error Sanitization**: User-friendly errors in UI, detailed logs in backend
5. ✅ **Async Processing**: Independent stream processing
6. ✅ **Notification System**: Sidebar notification panel with grouping
7. ✅ **Dashboard Revamp**: Tile-based camera view with quick add
8. ✅ **Seamless Video Toggle**: Show/hide video without stream interruption

---

## Phase 1: Service Health & Monitoring (Week 1-2)

### 1.1 Health Checker System

**Status**: ✅ Implemented (`backend/src/services/healthChecker.ts`)

**Features**:
- Monitors 5 services: Database, Worker, WebSocket-Backend, Kafka, MediaMTX
- 10-second polling interval
- Service statuses: UNKNOWN, STARTING, HEALTHY, DEGRADED, UNHEALTHY
- Event emitter for real-time updates
- Overall system health calculation

**API Endpoints** (`backend/src/routes/system.ts`):
```typescript
GET /api/system/health          // Overall system health
GET /api/system/health/:service // Specific service health
GET /api/system/ready           // Readiness check (503 if not ready)
```

**Response Format**:
```json
{
  "overall": "HEALTHY",
  "services": {
    "database": {
      "name": "database",
      "status": "HEALTHY",
      "lastCheck": "2025-10-08T10:30:00Z",
      "responseTime": 45,
      "details": { "connected": true }
    },
    "worker": {
      "name": "worker",
      "status": "HEALTHY",
      "responseTime": 123
    }
    // ... other services
  },
  "timestamp": "2025-10-08T10:30:00Z"
}
```

### 1.2 Frontend Health Indicator

**Implementation**:

```typescript
// frontend/src/components/ServiceHealthIndicator.tsx
interface ServiceHealthIndicatorProps {
  serviceName?: string; // If undefined, shows overall health
}

const ServiceHealthIndicator: React.FC<ServiceHealthIndicatorProps> = ({ serviceName }) => {
  const [health, setHealth] = useState<SystemHealth | null>(null);

  useEffect(() => {
    // Poll health endpoint every 10 seconds
    const fetchHealth = async () => {
      const response = await fetch('http://localhost:3000/api/system/health');
      const data = await response.json();
      setHealth(data);
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  const status = serviceName
    ? health?.services[serviceName]?.status
    : health?.overall;

  const dotColor = {
    HEALTHY: 'bg-green-500',
    DEGRADED: 'bg-orange-500',
    UNHEALTHY: 'bg-red-500',
    STARTING: 'bg-yellow-500',
    UNKNOWN: 'bg-gray-500',
  }[status || 'UNKNOWN'];

  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded-full ${dotColor} animate-pulse`} />
      <span className="text-sm text-gray-600">{serviceName || 'System'}: {status}</span>
    </div>
  );
};
```

**UI Placement**:
```
┌─────────────────────────────────────────────────┐
│  Camera Dashboard          [🟢 All Services Up] │
│  ────────────────────────────────────────────── │
│  🟢 Database  🟢 Worker  🟢 MediaMTX           │
│  🟢 WebSocket  🟢 Kafka                         │
└─────────────────────────────────────────────────┘
```

### 1.3 Startup Sequence with Health Checks

**Backend Initialization** (`backend/src/index.ts`):

```typescript
import { getHealthChecker } from './services/healthChecker.js';

// Start health checker
const healthChecker = getHealthChecker();
await healthChecker.start();

// Wait for critical services to be ready
console.log('[Startup] Waiting for services to be ready...');
let attempts = 0;
const maxAttempts = 30; // 5 minutes

while (!healthChecker.isSystemReady() && attempts < maxAttempts) {
  await new Promise(resolve => setTimeout(resolve, 10000));
  attempts++;

  const health = healthChecker.getSystemHealth();
  console.log(`[Startup] System status: ${health.overall} (attempt ${attempts}/${maxAttempts})`);
}

if (!healthChecker.isSystemReady()) {
  console.error('[Startup] WARNING: System not fully ready after 5 minutes');
  console.error('[Startup] Some services may be unavailable');
} else {
  console.log('[Startup] ✅ All services are ready!');
}

// Emit health updates via WebSocket
healthChecker.on('health-update', (health) => {
  // TODO: Broadcast to WebSocket clients
});
```

**Frontend Loading Screen**:

```tsx
// frontend/src/components/StartupCheck.tsx
const StartupCheck: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [systemReady, setSystemReady] = useState(false);
  const [health, setHealth] = useState<SystemHealth | null>(null);

  useEffect(() => {
    const checkReadiness = async () => {
      try {
        const response = await fetch('http://localhost:3000/api/system/ready');
        if (response.ok) {
          setSystemReady(true);
        } else {
          const data = await response.json();
          setHealth(data);
        }
      } catch (error) {
        console.error('System check failed:', error);
      }
    };

    checkReadiness();
    const interval = setInterval(checkReadiness, 5000);
    return () => clearInterval(interval);
  }, []);

  if (!systemReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full">
          <h2 className="text-2xl font-bold mb-4">System Initializing...</h2>
          <p className="text-gray-600 mb-6">
            Please wait while we connect to all services.
          </p>

          {health && (
            <div className="space-y-2">
              {Object.entries(health.services).map(([name, service]) => (
                <div key={name} className="flex items-center justify-between">
                  <span className="text-sm">{name}</span>
                  <StatusDot status={service.status} />
                </div>
              ))}
            </div>
          )}

          <div className="mt-6">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto" />
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
```

---

## Phase 2: Async Command Pattern & Loose Coupling (Week 3-4)

### 2.1 Kafka Command Topics

**New Kafka Topics**:
```
camera-commands      // Backend → Worker
camera-events        // Worker → All (existing)
stream-status        // Worker → Backend
```

### 2.2 Command Schema

```typescript
// shared/types/commands.ts
export enum CommandType {
  START_STREAM = 'START_STREAM',
  STOP_STREAM = 'STOP_STREAM',
  TOGGLE_FACE_DETECTION = 'TOGGLE_FACE_DETECTION',
  RESTART_STREAM = 'RESTART_STREAM',
}

export interface CameraCommand {
  id: string;
  commandType: CommandType;
  cameraId: string;
  payload?: Record<string, any>;
  timestamp: string;
  correlationId: string; // For tracking
}

export interface StreamStatusEvent {
  cameraId: string;
  status: 'STARTING' | 'PROCESSING' | 'ERROR' | 'STOPPED';
  details?: string;
  timestamp: string;
  correlationId: string;
}
```

### 2.3 Backend Producer Implementation

```typescript
// backend/src/services/cameraCommandProducer.ts
import { Kafka, Producer } from 'kafkajs';

export class CameraCommandProducer {
  private producer: Producer;

  constructor() {
    const kafka = new Kafka({
      clientId: 'backend-api',
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    });

    this.producer = kafka.producer();
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    console.log('[CommandProducer] Connected to Kafka');
  }

  async sendCommand(command: CameraCommand): Promise<void> {
    await this.producer.send({
      topic: 'camera-commands',
      messages: [
        {
          key: command.cameraId,
          value: JSON.stringify(command),
          headers: {
            'correlation-id': command.correlationId,
            'command-type': command.commandType,
          },
        },
      ],
    });

    console.log(`[CommandProducer] Sent command: ${command.commandType} for camera ${command.cameraId}`);
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }
}
```

### 2.4 Worker Command Consumer

```go
// worker/command_consumer.go
package main

import (
	"context"
	"encoding/json"
	"log"

	"github.com/segmentio/kafka-go"
)

type CommandConsumer struct {
	reader *kafka.Reader
}

func NewCommandConsumer() *CommandConsumer {
	return &CommandConsumer{
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers: []string{os.Getenv("KAFKA_BROKERS")},
			Topic:   "camera-commands",
			GroupID: "worker-command-consumer",
		}),
	}
}

func (cc *CommandConsumer) Start(ctx context.Context) {
	log.Println("[CommandConsumer] Starting to consume commands...")

	for {
		select {
		case <-ctx.Done():
			return
		default:
			msg, err := cc.reader.ReadMessage(ctx)
			if err != nil {
				log.Printf("[CommandConsumer] Error reading message: %v", err)
				continue
			}

			cc.handleCommand(msg)
		}
	}
}

func (cc *CommandConsumer) handleCommand(msg kafka.Message) {
	var command CameraCommand
	if err := json.Unmarshal(msg.Value, &command); err != nil {
		log.Printf("[CommandConsumer] Error unmarshaling command: %v", err)
		return
	}

	log.Printf("[CommandConsumer] Received command: %s for camera %s", command.CommandType, command.CameraID)

	// Publish status update immediately
	publishStreamStatus(command.CameraID, "STARTING", command.CorrelationID)

	switch command.CommandType {
	case "START_STREAM":
		go handleStartStream(command)
	case "STOP_STREAM":
		go handleStopStream(command)
	case "TOGGLE_FACE_DETECTION":
		go handleToggleFaceDetection(command)
	case "RESTART_STREAM":
		go handleRestartStream(command)
	}
}
```

### 2.5 Backend API Changes

**Before (Synchronous)**:
```typescript
// backend/src/routes/cameras.ts
router.post('/:id/start', async (c) => {
  // ❌ Synchronous HTTP call with 60s timeout
  const response = await fetch(`${WORKER_URL}/process`, {
    signal: AbortSignal.timeout(60000),
  });

  return c.json(await response.json());
});
```

**After (Asynchronous)**:
```typescript
// backend/src/routes/cameras.ts
router.post('/:id/start', async (c) => {
  const cameraId = c.req.param('id');
  const correlationId = crypto.randomUUID();

  // Send command to Kafka
  await commandProducer.sendCommand({
    id: crypto.randomUUID(),
    commandType: 'START_STREAM',
    cameraId,
    timestamp: new Date().toISOString(),
    correlationId,
  });

  // Update database immediately
  await prisma.camera.update({
    where: { id: cameraId },
    data: { status: 'STARTING' },
  });

  // Return immediately (don't wait for Worker)
  return c.json({
    message: 'Stream start command sent',
    cameraId,
    status: 'STARTING',
    correlationId,
  }, 202); // 202 Accepted
});
```

**Status Updates via WebSocket**:
```typescript
// Backend subscribes to stream-status topic
streamStatusConsumer.on('status-update', async (event) => {
  // Update database
  await prisma.camera.update({
    where: { id: event.cameraId },
    data: { status: event.status },
  });

  // Broadcast to WebSocket clients
  io.emit('camera-status-update', event);
});
```

---

## Phase 3: Stream Isolation & Error Recovery (Week 4-5)

### 3.1 Stream Isolation Architecture

**Problem**: One stream failure causes others to fail
**Solution**: Completely isolate each stream's lifecycle

```go
// worker/stream_manager.go
package main

import (
	"context"
	"sync"
)

type StreamManager struct {
	streams map[string]*StreamContext
	mu      sync.RWMutex
}

type StreamContext struct {
	CameraID        string
	Context         context.Context
	Cancel          context.CancelFunc
	ErrorCount      int
	LastError       error
	Capture         *gocv.VideoCapture
	FaceDetectionCtx context.Context
	FaceDetectionCancel context.CancelFunc
}

func NewStreamManager() *StreamManager {
	return &StreamManager{
		streams: make(map[string]*StreamContext),
	}
}

func (sm *StreamManager) StartStream(cameraID, rtspURL string) error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	// Stop existing stream if any
	if existing, ok := sm.streams[cameraID]; ok {
		existing.Cancel()
		delete(sm.streams, cameraID)
	}

	// Create new isolated context
	ctx, cancel := context.WithCancel(context.Background())

	streamCtx := &StreamContext{
		CameraID: cameraID,
		Context:  ctx,
		Cancel:   cancel,
	}

	sm.streams[cameraID] = streamCtx

	// Start stream in isolated goroutine with panic recovery
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[StreamManager] PANIC in stream %s: %v", cameraID, r)
				sm.handleStreamError(cameraID, fmt.Errorf("panic: %v", r))
			}
		}()

		sm.runStream(streamCtx, rtspURL)
	}()

	return nil
}

func (sm *StreamManager) runStream(streamCtx *StreamContext, rtspURL string) {
	log.Printf("[StreamManager] Starting isolated stream for camera %s", streamCtx.CameraID)

	// Open video capture with retries
	capture, err := sm.openCaptureWithRetry(rtspURL, streamCtx.Context)
	if err != nil {
		sm.handleStreamError(streamCtx.CameraID, err)
		return
	}
	streamCtx.Capture = capture
	defer capture.Close()

	// Main processing loop
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	consecutiveErrors := 0
	maxConsecutiveErrors := 10

	for {
		select {
		case <-streamCtx.Context.Done():
			log.Printf("[StreamManager] Stream %s stopped gracefully", streamCtx.CameraID)
			return

		case <-ticker.C:
			img := gocv.NewMat()
			ok := capture.Read(&img)

			if !ok || img.Empty() {
				img.Close()
				consecutiveErrors++

				if consecutiveErrors >= maxConsecutiveErrors {
					log.Printf("[StreamManager] Too many errors in stream %s, attempting reconnect", streamCtx.CameraID)

					// Try to reconnect
					capture.Close()
					newCapture, err := sm.openCaptureWithRetry(rtspURL, streamCtx.Context)
					if err != nil {
						sm.handleStreamError(streamCtx.CameraID, err)
						return
					}

					streamCtx.Capture = newCapture
					capture = newCapture
					consecutiveErrors = 0
				}

				continue
			}

			// Reset error counter on success
			consecutiveErrors = 0

			// Process frame (face detection, etc.)
			sm.processFrame(streamCtx, img)

			img.Close()
		}
	}
}

func (sm *StreamManager) handleStreamError(cameraID string, err error) {
	log.Printf("[StreamManager] Stream %s encountered error: %v", cameraID, err)

	// Publish error status
	publishStreamStatus(cameraID, "ERROR", "")

	// Clean up stream
	sm.mu.Lock()
	if streamCtx, ok := sm.streams[cameraID]; ok {
		if streamCtx.Capture != nil {
			streamCtx.Capture.Close()
		}
		if streamCtx.FaceDetectionCancel != nil {
			streamCtx.FaceDetectionCancel()
		}
		delete(sm.streams, cameraID)
	}
	sm.mu.Unlock()
}

func (sm *StreamManager) openCaptureWithRetry(rtspURL string, ctx context.Context) (*gocv.VideoCapture, error) {
	maxRetries := 3
	var lastErr error

	for i := 0; i < maxRetries; i++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		capture, err := gocv.OpenVideoCapture(rtspURL)
		if err == nil && capture.IsOpened() {
			// Configure capture
			capture.Set(gocv.VideoCaptureFPS, 15)
			capture.Set(gocv.VideoCaptureBufferSize, 3)

			// Discard initial frames
			temp := gocv.NewMat()
			for j := 0; j < 10; j++ {
				capture.Read(&temp)
			}
			temp.Close()

			return capture, nil
		}

		lastErr = err
		time.Sleep(time.Duration(i+1) * 2 * time.Second)
	}

	return nil, fmt.Errorf("failed to open capture after %d retries: %w", maxRetries, lastErr)
}
```

### 3.2 Error Boundary Pattern

**Benefits**:
- Each stream has its own context and lifecycle
- Panics are recovered and don't crash the service
- Network errors in one stream don't affect others
- Automatic reconnection with exponential backoff
- Clean resource cleanup on errors

---

## Phase 4: Error Sanitization (Week 5)

### 4.1 Error Classification

```typescript
// shared/types/errors.ts
export enum ErrorSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

export enum ErrorCode {
  // User-facing codes
  STREAM_UNAVAILABLE = 'STREAM_UNAVAILABLE',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  INVALID_INPUT = 'INVALID_INPUT',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',

  // Internal codes (logged only)
  FFMPEG_CRASH = 'FFMPEG_CRASH',
  DATABASE_ERROR = 'DATABASE_ERROR',
  KAFKA_ERROR = 'KAFKA_ERROR',
}

export interface ApplicationError {
  code: ErrorCode;
  severity: ErrorSeverity;
  userMessage: string;      // Safe for frontend
  technicalMessage: string; // Logged on backend
  timestamp: string;
  correlationId?: string;
  metadata?: Record<string, any>;
}
```

### 4.2 Error Middleware

```typescript
// backend/src/middleware/errorHandler.ts
import { Context } from 'hono';
import { ApplicationError, ErrorCode, ErrorSeverity } from '../types/errors.js';

const errorCodeToUserMessage: Record<ErrorCode, string> = {
  STREAM_UNAVAILABLE: 'The camera stream is temporarily unavailable. Please try again later.',
  NETWORK_ERROR: 'Network connection issue. Please check your internet connection.',
  PERMISSION_DENIED: 'You don\'t have permission to perform this action.',
  INVALID_INPUT: 'The information provided is invalid. Please check and try again.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable. We\'re working to fix this.',

  // These should never reach the user
  FFMPEG_CRASH: 'An unexpected error occurred. Please try again.',
  DATABASE_ERROR: 'An unexpected error occurred. Please try again.',
  KAFKA_ERROR: 'An unexpected error occurred. Please try again.',
};

export function sanitizeError(error: Error, correlationId?: string): ApplicationError {
  // Log full error with stack trace
  console.error('[Error]', {
    correlationId,
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  });

  // Determine error code and severity
  let code = ErrorCode.SERVICE_UNAVAILABLE;
  let severity = ErrorSeverity.ERROR;

  if (error.message.includes('ECONNREFUSED')) {
    code = ErrorCode.NETWORK_ERROR;
  } else if (error.message.includes('timeout')) {
    code = ErrorCode.STREAM_UNAVAILABLE;
  } else if (error.message.includes('permission')) {
    code = ErrorCode.PERMISSION_DENIED;
  }

  return {
    code,
    severity,
    userMessage: errorCodeToUserMessage[code],
    technicalMessage: error.message,
    timestamp: new Date().toISOString(),
    correlationId,
  };
}

export function errorHandler() {
  return async (c: Context, next: () => Promise<void>) => {
    try {
      await next();
    } catch (error) {
      const correlationId = c.req.header('x-correlation-id') || crypto.randomUUID();
      const appError = sanitizeError(error as Error, correlationId);

      return c.json({
        error: {
          message: appError.userMessage, // Only user-friendly message
          code: appError.code,
          severity: appError.severity,
          correlationId,
        },
      }, 500);
    }
  };
}
```

### 4.3 Frontend Error Display

```tsx
// frontend/src/components/ErrorBoundary.tsx
interface ErrorDisplayProps {
  error: ApplicationError;
  onRetry?: () => void;
}

const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ error, onRetry }) => {
  const severityColors = {
    INFO: 'bg-blue-50 border-blue-500',
    WARNING: 'bg-yellow-50 border-yellow-500',
    ERROR: 'bg-red-50 border-red-500',
    CRITICAL: 'bg-red-100 border-red-700',
  };

  const severityIcons = {
    INFO: 'ℹ️',
    WARNING: '⚠️',
    ERROR: '❌',
    CRITICAL: '🚨',
  };

  return (
    <div className={`border-l-4 p-4 rounded ${severityColors[error.severity]}`}>
      <div className="flex items-start">
        <span className="text-2xl mr-3">{severityIcons[error.severity]}</span>
        <div className="flex-1">
          <p className="font-medium">{error.userMessage}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-2 text-sm text-blue-600 hover:text-blue-800"
            >
              Try Again
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
```

---

## Phase 5: Notification System (Week 6)

### 5.1 Notification Component

```tsx
// frontend/src/components/NotificationPanel.tsx
interface Notification {
  id: string;
  type: 'face-detection' | 'system-alert' | 'stream-error';
  cameraName: string;
  message: string;
  timestamp: string;
  imageData?: string;
  read: boolean;
}

const NotificationPanel: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const unreadCount = notifications.filter(n => !n.read).length;

  // Group notifications by camera
  const groupedNotifications = useMemo(() => {
    const groups: Record<string, Notification[]> = {};

    notifications.forEach(notification => {
      if (!groups[notification.cameraName]) {
        groups[notification.cameraName] = [];
      }
      groups[notification.cameraName].push(notification);
    });

    return groups;
  }, [notifications]);

  const markAllAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  return (
    <>
      {/* Notification Icon */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 rounded-lg hover:bg-gray-100"
      >
        <BellIcon className="w-6 h-6" />
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
            {unreadCount}
          </span>
        )}
      </button>

      {/* Sliding Panel */}
      <div
        className={`fixed right-0 top-0 h-full w-96 bg-white shadow-2xl transform transition-transform duration-300 z-50 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-4 border-b flex items-center justify-between">
            <h2 className="text-lg font-semibold">Notifications</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={markAllAsRead}
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Mark all read
              </button>
              <button
                onClick={clearAll}
                className="text-sm text-red-600 hover:text-red-800"
              >
                Clear all
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Grouped Notifications */}
          <div className="flex-1 overflow-y-auto">
            {Object.entries(groupedNotifications).map(([cameraName, notifications]) => (
              <div key={cameraName} className="border-b">
                <div className="p-3 bg-gray-50 font-medium flex items-center justify-between">
                  <span>{cameraName}</span>
                  <span className="text-sm text-gray-500">
                    {notifications.length} alert{notifications.length > 1 ? 's' : ''}
                  </span>
                </div>

                <div className="divide-y">
                  {notifications.map(notification => (
                    <div
                      key={notification.id}
                      className={`p-3 hover:bg-gray-50 ${!notification.read ? 'bg-blue-50' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        {notification.imageData && (
                          <img
                            src={`data:image/jpeg;base64,${notification.imageData}`}
                            alt="Detection"
                            className="w-16 h-16 rounded object-cover"
                          />
                        )}
                        <div className="flex-1">
                          <p className="text-sm">{notification.message}</p>
                          <span className="text-xs text-gray-500">
                            {formatDistanceToNow(new Date(notification.timestamp), { addSuffix: true })}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-30 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
};
```

---

## Phase 6: Dashboard Revamp (Week 7-8)

### 6.1 New Dashboard Layout

```tsx
// frontend/src/components/Dashboard.tsx
const Dashboard: React.FC = () => {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [quickAddUrl, setQuickAddUrl] = useState('');
  const [isAddingCamera, setIsAddingCamera] = useState(false);

  const handleQuickAdd = async () => {
    if (!quickAddUrl) return;

    setIsAddingCamera(true);
    try {
      const response = await fetch('http://localhost:3000/api/cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `Camera ${Date.now()}`,
          rtspUrl: quickAddUrl,
          enabled: true,
        }),
      });

      if (response.ok) {
        const camera = await response.json();
        setCameras(prev => [...prev, camera]);
        setQuickAddUrl('');

        // Auto-start the camera
        await fetch(`http://localhost:3000/api/cameras/${camera.id}/start`, {
          method: 'POST',
        });
      }
    } catch (error) {
      console.error('Failed to add camera:', error);
    } finally {
      setIsAddingCamera(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">Camera Dashboard</h1>

            {/* Quick Add */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 bg-gray-100 rounded-lg px-3 py-2">
                <input
                  type="text"
                  placeholder="Enter RTSP URL to add camera..."
                  value={quickAddUrl}
                  onChange={(e) => setQuickAddUrl(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleQuickAdd()}
                  className="bg-transparent border-none outline-none w-96"
                />
                <button
                  onClick={handleQuickAdd}
                  disabled={!quickAddUrl || isAddingCamera}
                  className="px-4 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {isAddingCamera ? 'Adding...' : 'Add'}
                </button>
              </div>

              <ServiceHealthIndicator />
              <NotificationPanel />
            </div>
          </div>
        </div>
      </header>

      {/* Camera Grid */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {cameras.map(camera => (
            <CameraTile key={camera.id} camera={camera} />
          ))}
        </div>
      </main>
    </div>
  );
};
```

### 6.2 Camera Tile Component

```tsx
// frontend/src/components/CameraTile.tsx
const CameraTile: React.FC<{ camera: Camera }> = ({ camera }) => {
  const [videoVisible, setVideoVisible] = useState(true);
  const [faceDetectionEnabled, setFaceDetectionEnabled] = useState(camera.faceDetectionEnabled);

  const toggleVideo = () => {
    // Just hide/show the video element, don't stop the stream
    setVideoVisible(!videoVisible);
  };

  const toggleFaceDetection = async () => {
    try {
      await fetch(`http://localhost:3000/api/cameras/${camera.id}/face-detection/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !faceDetectionEnabled }),
      });

      setFaceDetectionEnabled(!faceDetectionEnabled);
    } catch (error) {
      console.error('Failed to toggle face detection:', error);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden">
      {/* Video Container */}
      <div className="relative bg-black aspect-video">
        {videoVisible ? (
          <WebRTCPlayer
            streamUrl={camera.webrtcUrl}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white">
            <VideoCameraSlashIcon className="w-12 h-12" />
          </div>
        )}

        {/* Status Indicator */}
        <div className="absolute top-2 right-2">
          <CameraStatusDot status={camera.status} />
        </div>

        {/* Overlay Controls */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-medium">{camera.name}</h3>

            <div className="flex items-center gap-2">
              {/* Toggle Video Visibility */}
              <button
                onClick={toggleVideo}
                className="p-2 bg-white/20 hover:bg-white/30 rounded-lg text-white transition"
                title={videoVisible ? 'Hide Video' : 'Show Video'}
              >
                {videoVisible ? (
                  <EyeIcon className="w-5 h-5" />
                ) : (
                  <EyeSlashIcon className="w-5 h-5" />
                )}
              </button>

              {/* Toggle Face Detection */}
              <button
                onClick={toggleFaceDetection}
                className={`p-2 rounded-lg transition ${
                  faceDetectionEnabled
                    ? 'bg-green-500 hover:bg-green-600'
                    : 'bg-white/20 hover:bg-white/30'
                } text-white`}
                title={faceDetectionEnabled ? 'Disable Face Detection' : 'Enable Face Detection'}
              >
                <FaceSmileIcon className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Camera Info */}
      <div className="p-3 border-t">
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>Status: {camera.status}</span>
          <span>{camera.location || 'No location'}</span>
        </div>
      </div>
    </div>
  );
};
```

---

## Phase 7: Additional Issues & Fixes

### 7.1 Database Connection Pooling

```typescript
// backend/src/utils/db.ts
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: ['error', 'warn'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Connection pool configuration
prisma.$connect().then(() => {
  console.log('[Database] Connected with connection pooling');
});

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
```

### 7.2 Rate Limiting

```typescript
// backend/src/middleware/rateLimiter.ts
import { Context } from 'hono';

const requests = new Map<string, number[]>();

export function rateLimiter(maxRequests: number, windowMs: number) {
  return async (c: Context, next: () => Promise<void>) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
    const now = Date.now();

    if (!requests.has(ip)) {
      requests.set(ip, []);
    }

    const userRequests = requests.get(ip)!;

    // Remove old requests outside the time window
    const validRequests = userRequests.filter(time => now - time < windowMs);

    if (validRequests.length >= maxRequests) {
      return c.json({
        error: {
          message: 'Too many requests. Please try again later.',
          code: 'RATE_LIMIT_EXCEEDED',
        },
      }, 429);
    }

    validRequests.push(now);
    requests.set(ip, validRequests);

    await next();
  };
}

// Usage
app.use('/api/*', rateLimiter(100, 60000)); // 100 requests per minute
```

### 7.3 CORS Configuration

```typescript
// backend/src/middleware/cors.ts
import { cors } from 'hono/cors';

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

export const corsMiddleware = cors({
  origin: (origin) => {
    if (!origin) return null; // Allow requests with no origin (like mobile apps)
    return allowedOrigins.includes(origin) ? origin : null;
  },
  allowHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
  maxAge: 86400, // 24 hours
});
```

---

## Implementation Timeline

| Phase | Duration | Priority | Dependencies |
|-------|----------|----------|--------------|
| Phase 1: Health Monitoring | 1-2 weeks | High | None |
| Phase 2: Async Commands | 2 weeks | Critical | Phase 1 |
| Phase 3: Stream Isolation | 1-2 weeks | Critical | Phase 2 |
| Phase 4: Error Sanitization | 1 week | High | Phase 2 |
| Phase 5: Notification System | 1 week | Medium | Phase 1, 4 |
| Phase 6: Dashboard Revamp | 2 weeks | Medium | Phase 1, 5 |
| Phase 7: Additional Fixes | 1 week | High | All phases |

**Total Estimated Time: 6-8 weeks**

---

## Success Criteria

- [ ] All services show green status indicators when healthy
- [ ] System waits for all services to be ready before allowing operations
- [ ] Camera operations are async (return 202 Accepted immediately)
- [ ] One stream failure doesn't affect other streams
- [ ] Errors shown to users are friendly and actionable
- [ ] Technical errors are logged with full details and correlation IDs
- [ ] Notification panel shows grouped, timestamped alerts
- [ ] Quick-add camera from header works seamlessly
- [ ] Video can be hidden/shown without interrupting stream
- [ ] Face detection can be toggled per camera
- [ ] Rate limiting prevents API abuse
- [ ] CORS only allows whitelisted origins

---

## Next Steps

1. Review and approve this refactoring plan
2. Set up development environment with all services running
3. Begin Phase 1 implementation (Health Monitoring)
4. Test each phase thoroughly before moving to next
5. Update documentation as implementation progresses

---

**Document Version**: 1.0
**Last Updated**: October 2025
**Author**: Architecture Team
