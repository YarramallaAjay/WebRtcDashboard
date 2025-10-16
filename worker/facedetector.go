package main

import (
	"encoding/base64"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"gocv.io/x/gocv"
)

// FaceDetector handles face detection using OpenCV/gocv
type FaceDetector struct {
	classifier    *gocv.CascadeClassifier
	enabled       bool
	interval      time.Duration
	threshold     float64
	kafkaProducer *KafkaProducer
	mu            sync.Mutex
}

// NewFaceDetector creates a new face detector
func NewFaceDetector(kafkaProducer *KafkaProducer) (*FaceDetector, error) {
	enabled := os.Getenv("FACE_DETECTION_ENABLED") == "true"
	if !enabled {
		log.Println("Face detection is disabled")
		return &FaceDetector{enabled: false}, nil
	}

	// Load face detection cascade classifier
	modelPath := os.Getenv("FACE_DETECTION_MODEL_PATH")
	if modelPath == "" {
		modelPath = "/app/models"
	}

	cascadePath := modelPath + "/haarcascade_frontalface_default.xml"
	classifier := gocv.NewCascadeClassifier()

	if !classifier.Load(cascadePath) {
		return nil, fmt.Errorf("failed to load cascade classifier from %s", cascadePath)
	}

	intervalMs, _ := strconv.Atoi(os.Getenv("FACE_DETECTION_INTERVAL"))
	if intervalMs == 0 {
		intervalMs = 1000 // Default 1 second
	}

	threshold, _ := strconv.ParseFloat(os.Getenv("FACE_DETECTION_CONFIDENCE_THRESHOLD"), 64)
	if threshold == 0 {
		threshold = 0.5
	}

	log.Printf("Face detector initialized: interval=%dms, threshold=%.2f", intervalMs, threshold)

	return &FaceDetector{
		classifier:    &classifier,
		enabled:       true,
		interval:      time.Duration(intervalMs) * time.Millisecond,
		threshold:     threshold,
		kafkaProducer: kafkaProducer,
	}, nil
}

// DetectFaces detects faces in an image and returns face count
func (fd *FaceDetector) DetectFaces(img gocv.Mat) (int, []image.Rectangle) {
	if !fd.enabled || fd.classifier == nil {
		return 0, nil
	}

	// Validate input frame
	if img.Empty() || img.Cols() < 50 || img.Rows() < 50 {
		return 0, nil
	}

	// Convert to grayscale for better face detection
	gray := gocv.NewMat()
	defer gray.Close()
	gocv.CvtColor(img, &gray, gocv.ColorBGRToGray)

	// Apply Gaussian blur to reduce noise and false detections
	gocv.GaussianBlur(gray, &gray, image.Pt(5, 5), 0, 0, gocv.BorderDefault)

	// Apply histogram equalization to improve detection in varying lighting
	gocv.EqualizeHist(gray, &gray)

	// VERY STRICT parameters to minimize false positives
	// Parameters: scaleFactor=1.15, minNeighbors=8, minSize=(60x60)
	// - scaleFactor: 1.15 = less sensitive, skips more scales
	// - minNeighbors: 8 = require 8+ overlapping detections (VERY strict)
	// - minSize: 60x60 = only detect reasonably sized faces
	faces := fd.classifier.DetectMultiScaleWithParams(
		gray,
		1.15,              // scaleFactor: higher = less sensitive
		8,                 // minNeighbors: VERY high to minimize false positives (was 6)
		0,                 // flags
		image.Pt(60, 60),  // minSize: larger minimum (was 40x40)
		image.Pt(400, 400), // maxSize: limit max face size to avoid weird detections
	)

	// Additional multi-stage filtering
	validFaces := make([]image.Rectangle, 0)
	for _, face := range faces {
		// 1. Aspect ratio check: faces should be roughly square
		aspectRatio := float64(face.Dx()) / float64(face.Dy())
		if aspectRatio < 0.75 || aspectRatio > 1.25 {
			continue // Too narrow or too wide
		}

		// 2. Size check: face should be reasonable size
		faceArea := face.Dx() * face.Dy()
		if faceArea < 3600 || faceArea > 160000 { // 60x60 to 400x400
			continue
		}

		// 3. Position check: face should not be at extreme edges
		imgWidth := img.Cols()
		imgHeight := img.Rows()
		margin := 10 // pixels from edge

		if face.Min.X < margin || face.Min.Y < margin ||
			face.Max.X > imgWidth-margin || face.Max.Y > imgHeight-margin {
			continue // Too close to edge, likely false positive
		}

		validFaces = append(validFaces, face)
	}

	if len(faces) > 0 || len(validFaces) > 0 {
		log.Printf("[FaceDetector] Raw detections: %d, Valid faces after filtering: %d", len(faces), len(validFaces))
	}

	return len(validFaces), validFaces
}

// ProcessFrameForFaceDetection processes a frame and sends alert if faces detected
func (fd *FaceDetector) ProcessFrameForFaceDetection(cameraID, cameraName string, frame gocv.Mat) {
	if !fd.enabled {
		return
	}

	fd.mu.Lock()
	defer fd.mu.Unlock()

	faceCount, faces := fd.DetectFaces(frame)

	if faceCount == 0 {
		return
	}

	log.Printf("Detected %d face(s) in camera %s", faceCount, cameraID)

	// Draw rectangles around detected faces
	annotatedFrame := frame.Clone()
	defer annotatedFrame.Close()

	for _, face := range faces {
		gocv.Rectangle(&annotatedFrame, face, color.RGBA{0, 255, 0, 0}, 2)
	}

	// Encode frame to JPEG for thumbnail
	buf, err := gocv.IMEncode(".jpg", annotatedFrame)
	if err != nil {
		log.Printf("Failed to encode frame: %v", err)
		return
	}
	defer buf.Close()

	// Convert to base64
	imageData := base64.StdEncoding.EncodeToString(buf.GetBytes())

	// Create alert metadata with bounding boxes
	metadata := make(map[string]interface{})
	boundingBoxes := make([]map[string]int, 0, len(faces))
	for _, face := range faces {
		boundingBoxes = append(boundingBoxes, map[string]int{
			"x":      face.Min.X,
			"y":      face.Min.Y,
			"width":  face.Dx(),
			"height": face.Dy(),
		})
	}
	metadata["faces"] = boundingBoxes

	// Publish alert to Kafka
	alert := FaceDetectionAlert{
		CameraID:   cameraID,
		CameraName: cameraName,
		FaceCount:  faceCount,
		Confidence: fd.threshold, // Using threshold as proxy for confidence
		ImageData:  imageData,
		DetectedAt: time.Now(),
		Metadata:   metadata,
	}

	if fd.kafkaProducer != nil {
		if err := fd.kafkaProducer.PublishAlert(alert); err != nil {
			log.Printf("Failed to publish face detection alert: %v", err)
		}
	} else {
		log.Printf("Kafka producer not available, skipping alert publication for camera %s (faces detected: %d)", cameraID, faceCount)
	}
}

// EncodeJPEG encodes an image to JPEG bytes
func EncodeJPEG(img image.Image) ([]byte, error) {
	var buf []byte
	writer := &jpegWriter{buf: &buf}
	err := jpeg.Encode(writer, img, &jpeg.Options{Quality: 85})
	return buf, err
}

type jpegWriter struct {
	buf *[]byte
}

func (w *jpegWriter) Write(p []byte) (n int, err error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}

// Close cleans up the face detector
func (fd *FaceDetector) Close() {
	if fd.classifier != nil {
		fd.classifier.Close()
	}
}
