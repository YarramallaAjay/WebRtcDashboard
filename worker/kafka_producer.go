package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/joho/godotenv"
	"github.com/segmentio/kafka-go"
)

// KafkaProducer wraps kafka-go writer
type KafkaProducer struct {
	writer *kafka.Writer
	topic  string
}

// FaceDetectionAlert represents a face detection event
type FaceDetectionAlert struct {
	CameraID   string                 `json:"cameraId"`
	CameraName string                 `json:"cameraName"`
	FaceCount  int                    `json:"faceCount"`
	Confidence float64                `json:"confidence"`
	ImageData  string                 `json:"imageData"` // base64 encoded thumbnail
	DetectedAt time.Time              `json:"detectedAt"`
	Metadata   map[string]interface{} `json:"metadata"` // bounding boxes, etc.
}

// NewKafkaProducer creates a new Kafka producer
func NewKafkaProducer(topic string) (*KafkaProducer, error) {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found, using environment variables")
	} else {
		log.Println("Loaded environment variables from .env file")
	}
	brokers := os.Getenv("KAFKA_BROKERS")
	if brokers == "" {
		brokers = "localhost:9092"
	}

	writer := &kafka.Writer{
		Addr:         kafka.TCP(brokers),
		Topic:        topic,
		Balancer:     &kafka.LeastBytes{},
		BatchSize:    1, // Send immediately for real-time alerts
		BatchTimeout: 10 * time.Millisecond,
		RequiredAcks: kafka.RequireOne,
		Async:        false, // Synchronous for reliability
		Compression:  kafka.Gzip, // Use Gzip instead of Snappy (better compatibility)
	}

	// Test connection
	conn, err := kafka.DialLeader(context.Background(), "tcp", brokers, topic, 0)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to kafka: %w", err)
	}
	conn.Close()

	log.Printf("Kafka producer initialized for topic '%s' with brokers: %s", topic, brokers)

	return &KafkaProducer{
		writer: writer,
		topic:  topic,
	}, nil
}

// PublishAlert sends a face detection alert to Kafka
func (kp *KafkaProducer) PublishAlert(alert FaceDetectionAlert) error {
	alertJSON, err := json.Marshal(alert)
	if err != nil {
		return fmt.Errorf("failed to marshal alert: %w", err)
	}

	message := kafka.Message{
		Key:   []byte(alert.CameraID), // Use cameraId as key for partitioning
		Value: alertJSON,
		Time:  alert.DetectedAt,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = kp.writer.WriteMessages(ctx, message)
	if err != nil {
		return fmt.Errorf("failed to write message to kafka: %w", err)
	}

	log.Printf("Published face detection alert to Kafka: camera=%s, faces=%d", alert.CameraID, alert.FaceCount)
	return nil
}

// Close closes the Kafka producer
func (kp *KafkaProducer) Close() error {
	if kp.writer != nil {
		return kp.writer.Close()
	}
	return nil
}
