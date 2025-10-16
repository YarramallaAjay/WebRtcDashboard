# WebRTC Dashboard - System Architecture

## Overview

This system provides real-time face detection alerts for camera streams using WebRTC, Kafka, and WebSocket technologies.

## Architecture Diagram

```
┌─────────────┐
│   Camera    │ (RTSP Stream)
└──────┬──────┘
       │
       ↓
┌─────────────────────────────────────────────────────────────┐
│                      Worker Service (Go)                     │
│  - Receives RTSP streams                                     │
│  - Converts to WebRTC                                        │
│  - Performs face detection (OpenCV)                          │
│  - Publishes alerts to Kafka                                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ↓
                  ┌────────────────┐
                  │     Kafka      │
                  │ (camera-events)│
                  └────────┬───────┘
                           │
                           ↓
┌──────────────────────────────────────────────────────────────┐
│            WebSocket-Backend Service (Node.js)               │
│  - Consumes Kafka messages                                   │
│  - Broadcasts via WebSocket (Socket.IO)                      │
│  - Port: 4000                                                │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ↓
                  ┌────────────────┐
                  │    Frontend    │
                  │   (React)      │
                  │  - Displays    │
                  │    alerts      │
                  └────────────────┘

┌──────────────────────────────────────────────────────────────┐
│              Backend API Service (Node.js)                   │
│  - REST API for cameras & alerts                            │
│  - Database operations (Prisma + PostgreSQL)                 │
│  - Port: 3000                                                │
└──────────────────────────────────────────────────────────────┘
```

## Services

### 1. Backend API Service (Port 3000)
- **Technology**: Node.js + Hono + Prisma
- **Purpose**: REST API for camera management and alert history
- **Responsibilities**:
  - Camera CRUD operations
  - Alert history queries
  - Database management
- **Does NOT handle**: WebSocket connections or Kafka

### 2. WebSocket-Backend Service (Port 4000)
- **Technology**: Node.js + Socket.IO + KafkaJS
- **Purpose**: Real-time alert broadcasting
- **Responsibilities**:
  - Consume messages from Kafka `camera-events` topic
  - Broadcast face detection alerts to connected WebSocket clients
  - Manage WebSocket connections
- **Key Files**:
  - `src/kafkaConsumer.ts` - Kafka message consumption
  - `src/websocketServer.ts` - Socket.IO server
  - `src/index.ts` - Service orchestration

### 3. Worker Service (Port 8080)
- **Technology**: Go + Gin + OpenCV (gocv)
- **Purpose**: Video processing and face detection
- **Responsibilities**:
  - Receive RTSP streams from cameras
  - Convert to WebRTC for frontend playback
  - Perform face detection using Haar Cascade
  - Publish alerts to Kafka with Gzip compression
- **Key Files**:
  - `facedetector.go` - Face detection logic
  - `kafka_producer.go` - Kafka message publishing
  - `main.go` - HTTP API and stream management

### 4. Frontend (Port 5173)
- **Technology**: React + TypeScript + Vite + TailwindCSS
- **Purpose**: User interface
- **Responsibilities**:
  - Display camera streams
  - Connect to WebSocket service for alerts
  - Manage camera settings via REST API
- **Key Files**:
  - `src/hooks/useWebSocket.ts` - WebSocket connection management

## Data Flow

### Face Detection Alert Flow

1. **Detection**
   - Worker detects face in video frame
   - Creates `FaceDetectionAlert` object with metadata

2. **Publishing**
   - Worker publishes alert to Kafka topic `camera-events`
   - Message compressed with Gzip

3. **Consumption**
   - WebSocket-Backend consumes message from Kafka
   - Parses alert data

4. **Broadcasting**
   - WebSocket-Backend broadcasts alert via Socket.IO
   - Event: `face-detection-alert`
   - Sent to all connected clients

5. **Display**
   - Frontend receives alert via WebSocket
   - Displays notification to user

## Configuration

### Environment Variables

**Backend API (.env)**
```env
PORT=3000
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret
WORKER_URL=http://localhost:8080
```

**WebSocket-Backend (.env)**
```env
PORT=4000
KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=camera-events
KAFKA_GROUP_ID=websocket-alert-consumer
CORS_ORIGIN=http://localhost:5173,http://localhost:3000
```

**Worker (.env)**
```env
PORT=8080
KAFKA_BROKERS=localhost:9092
FACE_DETECTION_ENABLED=true
FACE_DETECTION_INTERVAL=1000
FACE_DETECTION_MODEL_PATH=./models
```

**Frontend (.env)**
```env
VITE_BACKEND_URL=http://localhost:3000
VITE_WEBSOCKET_URL=http://localhost:4000
VITE_WORKER_URL=http://localhost:8080
VITE_MEDIAMTX_URL=http://localhost:8891
```

## Running the System

### Prerequisites
- Node.js 22+
- Go 1.25+
- Docker (for Kafka)
- OpenCV (for Worker)

### Start Order

1. **Kafka**
   ```bash
   docker-compose up -d kafka
   ```

2. **Backend API**
   ```bash
   cd backend
   npm run dev
   ```

3. **WebSocket-Backend**
   ```bash
   cd websocket-backend
   npm run dev
   ```

4. **Worker**
   ```bash
   cd worker
   go run .
   ```

5. **Frontend**
   ```bash
   cd frontend
   npm run dev
   ```

## Technology Stack

| Component | Technology |
|-----------|------------|
| Backend API | Node.js, Hono, Prisma, PostgreSQL |
| WebSocket Service | Node.js, Socket.IO, KafkaJS |
| Worker | Go, Gin, OpenCV (gocv), Kafka |
| Frontend | React, TypeScript, Vite, TailwindCSS |
| Message Queue | Apache Kafka |
| Media Server | MediaMTX |
| Database | PostgreSQL (Neon) |

## Key Design Decisions

### Why Separate WebSocket Service?
- **Separation of Concerns**: API logic separate from real-time messaging
- **Scalability**: Can scale WebSocket connections independently
- **Reliability**: Kafka ensures no message loss if WebSocket service restarts
- **Simplicity**: Each service has a single, clear responsibility

### Why Kafka?
- **Reliability**: Guaranteed message delivery
- **Decoupling**: Services can be restarted independently
- **Scalability**: Can add multiple consumers if needed
- **Durability**: Messages persisted to disk

### Face Detection Parameters
```go
scaleFactor: 1.1       // Balance between speed and accuracy
minNeighbors: 6        // Reduce false positives
minSize: 40x40 pixels  // Minimum face size
aspectRatio: 0.6-1.4   // Filter unusual shapes
```

## Troubleshooting

### No alerts appearing in frontend
1. Check Worker is detecting faces (Worker logs)
2. Verify Kafka is receiving messages: `docker exec skylark-kafka kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic camera-events`
3. Check WebSocket-Backend is consuming (WebSocket logs)
4. Verify Frontend WebSocket connection (Browser console)

### False face detections
- Increase `minNeighbors` in `facedetector.go`
- Increase `minSize` to detect only larger faces
- Adjust `aspectRatio` filter range

### Kafka connection errors
- Ensure Kafka is running: `docker ps | grep kafka`
- Check broker address matches in all services
- Verify no Snappy compression (use Gzip instead)

## Future Improvements

- [ ] Add authentication/authorization
- [ ] Implement alert persistence in database (via WebSocket-Backend)
- [ ] Add multiple Kafka consumer groups for different use cases
- [ ] Implement alert filtering/routing based on camera
- [ ] Add metrics and monitoring
- [ ] Implement replay capability for alerts
- [ ] Add support for multiple face detection models
