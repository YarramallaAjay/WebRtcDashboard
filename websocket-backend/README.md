# WebSocket-Backend Service

A dedicated WebSocket service that consumes face detection alerts from Kafka and broadcasts them to connected frontend clients in real-time.

## Architecture

```
Worker (Go) → Kafka (camera-events topic) → WebSocket-Backend → Frontend (React)
                                               ↓
                                          Socket.IO Server
```

## Features

- **Kafka Consumer**: Consumes messages from `camera-events` topic
- **WebSocket Server**: Broadcasts alerts to connected clients via Socket.IO
- **Real-time Alerts**: Instant notification of face detection events
- **Room-based Broadcasting**: Support for camera-specific subscriptions
- **Comprehensive Logging**: Detailed logs for debugging

## Installation

```bash
cd websocket-backend
npm install
```

## Configuration

Create a `.env` file (or copy from `.env` in the project root):

```env
PORT=4000
KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=camera-events
KAFKA_GROUP_ID=websocket-alert-consumer
CORS_ORIGIN=http://localhost:5173,http://localhost:3000
```

## Running the Service

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm run build
npm start
```

## API / Events

### Server → Client Events

- **`connected`**: Welcome message when client connects
  ```json
  {
    "message": "Connected to face detection alerts service",
    "timestamp": "2025-10-08T00:00:00.000Z",
    "socketId": "abc123"
  }
  ```

- **`face-detection-alert`**: Face detection alert broadcast to all clients
  ```json
  {
    "id": "alert_1234567890_cameraId",
    "cameraId": "camera123",
    "cameraName": "Front Door",
    "faceCount": 2,
    "confidence": 0.85,
    "imageData": "base64...",
    "detectedAt": "2025-10-08T00:00:00.000Z",
    "metadata": { "faces": [...] }
  }
  ```

- **`camera-alert`**: Camera-specific alert (sent to subscribed rooms)

### Client → Server Events

- **`subscribe:camera`**: Subscribe to alerts for a specific camera
  ```javascript
  socket.emit('subscribe:camera', 'cameraId123');
  ```

- **`unsubscribe:camera`**: Unsubscribe from camera alerts
  ```javascript
  socket.emit('unsubscribe:camera', 'cameraId123');
  ```

- **`ping`**: Test connection (server responds with `pong`)

## Logs

The service provides detailed logging:

- **Kafka**: Connection status, message consumption
- **WebSocket**: Client connections, disconnections, broadcasts
- **Alerts**: Face detection event details

Example output:
```
[Kafka] ✓ Connected to Kafka
[Kafka] ✓✓✓ Kafka consumer is now listening for messages...
[WebSocket] ✓ New client connected! Socket ID: abc123
[Kafka] 🔔 New message received!
[WebSocket] 📢 Broadcasting face detection alert!
```

## Testing

### Test WebSocket Connection
```javascript
const socket = io('http://localhost:4000');

socket.on('connected', (data) => {
  console.log('Connected:', data);
});

socket.on('face-detection-alert', (alert) => {
  console.log('Alert:', alert);
});
```

### Monitor Kafka Messages
```bash
docker exec skylark-kafka kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic camera-events \
  --from-beginning
```

## Integration

### Frontend Integration

Update your frontend environment:
```env
VITE_WEBSOCKET_URL=http://localhost:4000
```

The frontend will automatically connect using `useWebSocket` hook.

## Troubleshooting

### Kafka Connection Issues
- Ensure Kafka is running: `docker ps | grep kafka`
- Check broker address: `KAFKA_BROKERS=localhost:9092`
- Verify topic exists: `docker exec skylark-kafka kafka-topics.sh --list --bootstrap-server localhost:9092`

### WebSocket Connection Issues
- Check CORS origins in `.env`
- Verify port 4000 is not in use
- Check browser console for connection errors

### No Alerts Received
- Verify worker is publishing to Kafka
- Check Kafka consumer is connected (look for `[Kafka] ✓✓✓` log)
- Ensure frontend is connected (look for `[WebSocket] ✓ New client connected`)
- Check camera has `faceDetectionEnabled: true`

## Dependencies

- **kafkajs**: Kafka client for Node.js
- **socket.io**: WebSocket library
- **dotenv**: Environment configuration
- **typescript**: Type safety
