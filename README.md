# WebRTC Dashboard

A production-grade real-time video surveillance system with face detection capabilities. Built on a microservices architecture featuring a React frontend, Node.js API services, and a Go worker service for video processing and face detection using OpenCV.

## Overview

The WebRTC Dashboard enables real-time monitoring of RTSP camera streams with WebRTC playback, automatic face detection, and instant alerts delivered via WebSocket. The system can handle multiple simultaneous camera streams with robust error handling and health monitoring.

### Key Features

- **Multi-Camera Management**: Create, manage, and monitor multiple RTSP camera streams
- **Real-Time Streaming**: RTSP to WebRTC conversion for browser-based video playback
- **Face Detection**: OpenCV-powered face detection with multi-stage validation
- **Instant Alerts**: WebSocket-based real-time alerts for face detection events
- **Health Monitoring**: Comprehensive system health checks across all services
- **Resilient Architecture**: Circuit breakers, retries, and graceful degradation
- **Responsive UI**: Modern React interface with mobile-first design

## Architecture

### System Components

```
┌─────────────┐       ┌──────────────┐       ┌─────────────┐
│   Frontend  │──────▶│  Backend API │──────▶│   Worker    │
│  (React 19) │       │  (Hono/Node) │       │     (Go)    │
└──────┬──────┘       └──────┬───────┘       └──────┬──────┘
       │                     │                       │
       │              ┌──────▼───────┐              │
       │              │  PostgreSQL  │              │
       │              │   (Prisma)   │              │
       │              └──────────────┘              │
       │                                            │
       │              ┌──────────────┐              │
       └─────────────▶│  WebSocket   │◀─────────────┘
                      │   Backend    │
                      └──────┬───────┘
                             │
                      ┌──────▼───────┐
                      │    Kafka     │
                      │ (Event Bus)  │
                      └──────┬───────┘
                             │
                      ┌──────▼───────┐
                      │   MediaMTX   │
                      │  (Streaming) │
                      └──────────────┘
```

### Services

| Service | Technology | Port | Purpose |
|---------|-----------|------|---------|
| **Frontend** | React 19 + Vite + TypeScript | 5173 | User interface and WebRTC player |
| **Backend API** | Node.js + Hono + Prisma | 3000 | REST API and camera management |
| **WebSocket Backend** | Node.js + Socket.IO | 4000 | Real-time alert broadcasting |
| **Worker** | Go + OpenCV + gocv | 8080 | Video processing and face detection |
| **MediaMTX** | RTSP/WebRTC Server | 8554, 8891 | Stream conversion and routing |
| **Kafka** | Apache Kafka | 9092 | Message queue for alerts |
| **PostgreSQL** | Database (Neon) | - | Data persistence |

## Technology Stack

### Frontend
- React 19 with TypeScript
- Vite 7 for build tooling
- TailwindCSS 4 for styling
- Socket.IO Client for WebSocket
- Axios for HTTP requests
- WebRTC API for video playback

### Backend API
- Hono (modern web framework)
- Prisma ORM with PostgreSQL
- Zod for validation
- JWT & bcrypt for auth (currently disabled)

### WebSocket Backend
- Socket.IO 4.8 for WebSocket
- KafkaJS 2.2 for message consumption
- TypeScript

### Worker Service
- Go 1.24
- Gin web framework
- gocv (OpenCV bindings)
- gortsplib for RTSP handling
- pion/webrtc for WebRTC
- kafka-go for message publishing

## Getting Started

### Prerequisites

- Node.js 18+
- Go 1.24+
- Docker & Docker Compose
- OpenCV (for gocv)
- PostgreSQL database (or use Neon)

### Quick Start with Docker

1. Clone the repository:
```bash
git clone <repository-url>
cd WebRtcDashboard
```

2. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. Start all services:
```bash
docker-compose up -d
```

4. Access the application:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3000
- Worker API: http://localhost:8080
- WebSocket: http://localhost:4000

### Local Development

#### Frontend Development

```bash
cd frontend
npm install
npm run dev          # Start development server
npm run build        # Build for production
npm run lint         # Run ESLint
```

#### Backend Development

```bash
cd backend
npm install
npm run db:generate  # Generate Prisma client
npm run db:push      # Push schema to database
npm run dev          # Start with hot reload
```

#### WebSocket Backend

```bash
cd websocket-backend
npm install
npm run dev          # Start WebSocket server
```

#### Worker Development

```bash
cd worker
go mod download
go build -o WebRtcDashBoard
./WebRtcDashBoard    # Start worker service
```

## Environment Variables

### Core Configuration

```env
# Database
DATABASE_URL=postgresql://user:password@host/database

# Service URLs
BACKEND_URL=http://localhost:3000
WORKER_URL=http://localhost:8080
WEBSOCKET_URL=http://localhost:4000
MEDIAMTX_URL=rtsp://localhost:8554
MEDIAMTX_API_URL=http://localhost:9997
MEDIAMTX_WEBRTC_URL=http://localhost:8891

# Kafka
KAFKA_BROKERS=localhost:9092
WS_KAFKA_TOPIC=camera-events
WS_KAFKA_GROUP_ID=websocket-alert-consumer

# Face Detection
FACE_DETECTION_ENABLED=true
FACE_DETECTION_INTERVAL=1000
FACE_DETECTION_MODEL_PATH=/app/models
FACE_DETECTION_CONFIDENCE_THRESHOLD=0.5

# Frontend (Vite)
VITE_BACKEND_URL=http://localhost:3000
VITE_WEBSOCKET_URL=http://localhost:4000
VITE_WORKER_URL=http://localhost:8080
VITE_MEDIAMTX_URL=http://localhost:8891
```

## API Documentation

### Backend API Endpoints

#### Cameras

```
GET    /api/cameras                     # List all cameras
POST   /api/cameras                     # Create new camera
PUT    /api/cameras/:id                 # Update camera
DELETE /api/cameras/:id                 # Delete camera
POST   /api/cameras/:id/start           # Start streaming
POST   /api/cameras/:id/stop            # Stop streaming
GET    /api/cameras/:id/status          # Get camera status
GET    /api/cameras/streams/active      # Get active WebRTC streams
POST   /api/cameras/:id/face-detection/toggle  # Toggle face detection
POST   /api/cameras/start-batch         # Start multiple cameras
```

#### Alerts

```
GET    /api/alerts                      # List alerts (with filters)
POST   /api/alerts                      # Create alert
DELETE /api/alerts/:id                  # Delete alert
```

#### System

```
GET    /api/system/health               # Overall system health
GET    /api/system/health/:service      # Specific service health
GET    /api/system/ready                # Readiness check
```

### WebSocket Events

#### Client → Server

```javascript
socket.emit('subscribe:camera', cameraId)    // Subscribe to camera alerts
socket.emit('unsubscribe:camera', cameraId)  // Unsubscribe from camera
socket.emit('ping')                          // Health check
```

#### Server → Client

```javascript
socket.on('connected', (data) => {})          // Connection confirmation
socket.on('face-detection-alert', (alert) => {})  // Face detection alert
socket.on('camera-alert', (alert) => {})      // Camera-specific alert
socket.on('pong', () => {})                   // Health check response
```

## Database Schema

### Camera Model

```prisma
model Camera {
  id                   String   @id @default(cuid())
  name                 String
  rtspUrl              String
  location             String?
  enabled              Boolean  @default(false)
  status               String   @default("OFFLINE")
  createdAt            DateTime @default(now())
  mediamtxPath         String?
  mediamtxConfigured   Boolean  @default(false)
  lastProcessedAt      DateTime?
  faceDetectionEnabled Boolean  @default(false)
  alerts               Alert[]
}
```

### Alert Model

```prisma
model Alert {
  id            String   @id @default(cuid())
  cameraId      String
  camera        Camera   @relation(fields: [cameraId], references: [id])
  frameUrl      String?
  detectedAt    DateTime @default(now())
  metadata      Json?
  faceDetected  Boolean  @default(false)
  faceCount     Int      @default(0)
  confidence    Float?

  @@index([cameraId, detectedAt])
  @@index([faceDetected])
}
```

## Features in Detail

### Face Detection

The system uses OpenCV's Haar Cascade classifier with strict detection parameters:

- **Preprocessing**: Grayscale conversion, Gaussian blur, histogram equalization
- **Detection Parameters**: Scale factor 1.15, Min neighbors 8, Min size 60x60px
- **Multi-stage Validation**:
  - Aspect ratio check (0.75-1.25)
  - Size check (3600-160000 pixels)
  - Position check (not at extreme edges)
- **Alert Generation**: Base64 encoded JPEG with bounding box metadata

### Stream Processing Flow

1. User creates camera with RTSP URL
2. Backend registers camera with Worker service
3. Worker configures MediaMTX path for the camera
4. User starts streaming
5. Worker initiates re-encoding process (RTSP → MediaMTX)
6. Frontend fetches WebRTC URL from backend
7. WebRTCPlayer establishes peer connection
8. Video streams to browser
9. Face detection runs on frames (if enabled)
10. Alerts published to Kafka
11. WebSocket backend consumes and broadcasts alerts
12. Frontend displays real-time notifications

### Health Monitoring

The system performs 10-second health checks on:

- **Database**: Prisma connection ping
- **Worker Service**: HTTP health endpoint
- **WebSocket Service**: HTTP health endpoint
- **Kafka**: Broker configuration check
- **MediaMTX**: API availability check

Health Status Levels:
- `UNKNOWN`: Initial state
- `STARTING`: Service initializing
- `HEALTHY`: All checks pass
- `DEGRADED`: Some checks fail (non-critical)
- `UNHEALTHY`: Critical service failures

### Resilience Features

- **Circuit Breaker**: Prevents cascading failures (10 failures → 1 minute cooldown)
- **Exponential Backoff**: Retry logic for transient failures
- **Timeout Handling**: 5-second timeouts for all service checks
- **Graceful Degradation**: System continues with reduced functionality
- **Database Persistence**: State recovery after restarts

## Project Structure

```
WebRtcDashboard/
├── frontend/                   # React frontend
│   ├── src/
│   │   ├── components/        # React components
│   │   ├── hooks/             # Custom hooks
│   │   ├── App.tsx            # Main app
│   │   └── main.tsx           # Entry point
│   ├── package.json
│   ├── vite.config.ts
│   └── Dockerfile
│
├── backend/                    # Node.js REST API
│   ├── src/
│   │   ├── routes/            # API endpoints
│   │   ├── services/          # Business logic
│   │   ├── auth/              # Authentication
│   │   ├── utils/             # Utilities
│   │   └── index.ts           # Server setup
│   ├── prisma/
│   │   └── schema.prisma      # Database schema
│   ├── package.json
│   └── Dockerfile
│
├── websocket-backend/          # WebSocket service
│   ├── src/
│   │   ├── websocketServer.ts # Socket.IO server
│   │   ├── kafkaConsumer.ts   # Kafka consumer
│   │   └── index.ts           # Service orchestration
│   └── package.json
│
├── worker/                     # Go processing service
│   ├── main.go                # HTTP API & routing
│   ├── facedetector.go        # Face detection
│   ├── kafka_producer.go      # Alert publishing
│   ├── rtsp_source.go         # RTSP handling
│   ├── go.mod
│   ├── models/                # OpenCV models
│   ├── mediamtx/              # MediaMTX config
│   └── Dockerfile
│
├── docker-compose.yml          # Service orchestration
├── .env                        # Environment variables
├── ARCHITECTURE.md             # Architecture docs
└── README.md                   # This file
```

## Development Notes

### Current Status

- Authentication is implemented but currently disabled for testing
- System supports 20+ simultaneous camera streams
- Face detection uses very strict parameters to minimize false positives
- All services are containerized and ready for deployment

### Testing

The project includes test RTSP streams via FFmpeg publishers:
- `rtsp://localhost:8554/local-cam-1`
- `rtsp://localhost:8554/local-cam-2`
- `rtsp://localhost:8554/local-cam-3`

These loop test video files for development and testing.

### Potential Improvements

1. **Authentication**: Enable JWT-based authentication
2. **Alert Retention**: Implement alert cleanup policy
3. **Stream Timeout**: Auto-stop inactive streams
4. **Load Balancing**: Multiple worker instances
5. **Caching**: Redis for frequently accessed data
6. **Metrics**: Prometheus/Grafana integration
7. **Testing**: Unit and integration tests

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is proprietary software. All rights reserved.

## Support

For issues and questions:
- Create an issue in the repository
- Contact the development team

## Acknowledgments

- MediaMTX for RTSP/WebRTC conversion
- OpenCV for computer vision capabilities
- Apache Kafka for event streaming
- The open-source community

---

Built with ❤️ by the Skylark team