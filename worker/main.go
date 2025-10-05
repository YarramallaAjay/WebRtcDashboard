package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq" // PostgreSQL driver
	ffmpeg "github.com/u2takey/ffmpeg-go"
	"gocv.io/x/gocv"
)

// WebRTCOfferRequest represents the incoming WebRTC offer request
type WebRTCOfferRequest struct {
	CameraID string `json:"cameraId" binding:"required"`
	RTSPURL  string `json:"rtspUrl" binding:"required"`
}

// WebRTCOfferResponse represents the response with the answer
type WebRTCOfferResponse struct {
	Answer    string `json:"answer"`
	SessionID string `json:"sessionId"`
	Status    string `json:"status"`
	Error     string `json:"error,omitempty"`
}

// ReencodingProcess represents an active re-encoding process
type ReencodingProcess struct {
	CameraID  string
	SourceURL string
	TargetURL string
	Context   context.Context
	Cancel    context.CancelFunc
	Command   *exec.Cmd
}

// WorkerConfig holds configuration for the worker service
type WorkerConfig struct {
	MaxConcurrentStreams int
	MaxMemoryMB          int
	MaxCPUPercent        int
}

// StreamMetrics tracks metrics for a single stream
type StreamMetrics struct {
	CameraID        string
	StartTime       time.Time
	BytesProcessed  uint64
	FramesProcessed uint64
	LastFrameTime   time.Time
	ErrorCount      int
}

// CircuitBreaker implements circuit breaker pattern for stream failures
type CircuitBreaker struct {
	CameraID        string
	FailureCount    int
	LastFailureTime time.Time
	State           string // "closed", "open", "half-open"
	MaxFailures     int
	ResetTimeout    time.Duration
	mu              sync.RWMutex
}

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker(cameraID string) *CircuitBreaker {
	return &CircuitBreaker{
		CameraID:     cameraID,
		State:        "closed",
		MaxFailures:  10,              // Increased from 3 to 10 for better tolerance
		ResetTimeout: 1 * time.Minute, // Reduced from 5min to 1min for faster recovery
	}
}

// RecordFailure records a failure and updates circuit breaker state
func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.FailureCount++
	cb.LastFailureTime = time.Now()

	if cb.FailureCount >= cb.MaxFailures {
		cb.State = "open"
		log.Printf("Circuit breaker opened for camera %s after %d failures", cb.CameraID, cb.FailureCount)
	}
}

// RecordSuccess records a success and resets failure count
func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.FailureCount = 0
	cb.State = "closed"
}

// CanAttempt checks if an attempt can be made
func (cb *CircuitBreaker) CanAttempt() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.State == "closed" {
		return true
	}

	// Check if reset timeout has elapsed
	if time.Since(cb.LastFailureTime) > cb.ResetTimeout {
		cb.State = "half-open"
		log.Printf("Circuit breaker half-open for camera %s, allowing retry", cb.CameraID)
		return true
	}

	return false
}

// Global map to track active re-encoding processes
var (
	activeProcesses = make(map[string]*ReencodingProcess)
	processMutex    = sync.RWMutex{}
	db              *sql.DB
	workerConfig    = WorkerConfig{
		MaxConcurrentStreams: 20, // Default to 20 concurrent streams
		MaxMemoryMB:          4096,
		MaxCPUPercent:        80,
	}
	streamMetrics        = make(map[string]*StreamMetrics)
	streamMetricsMutex   = sync.RWMutex{}
	circuitBreakers      = make(map[string]*CircuitBreaker)
	circuitBreakersMutex = sync.RWMutex{}
	kafkaProducer        *KafkaProducer
	faceDetector         *FaceDetector
	faceDetectionActive  = make(map[string]context.CancelFunc) // Track active face detection goroutines
	faceDetectionMutex   = sync.RWMutex{}
)

// RetryConfig holds configuration for retry operations
type RetryConfig struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

// RetryOperation performs an operation with exponential backoff retry
func RetryOperation(operation func() error, config RetryConfig, operationName string) error {
	var lastErr error
	delay := config.BaseDelay

	for attempt := 1; attempt <= config.MaxAttempts; attempt++ {
		err := operation()
		if err == nil {
			if attempt > 1 {
				log.Printf("Operation '%s' succeeded on attempt %d", operationName, attempt)
			}
			return nil
		}

		lastErr = err
		log.Printf("Operation '%s' failed on attempt %d/%d: %v",
			operationName, attempt, config.MaxAttempts, err)

		if attempt == config.MaxAttempts {
			break
		}

		// Sleep with exponential backoff
		log.Printf("Retrying '%s' in %v...", operationName, delay)
		time.Sleep(delay)

		// Double the delay for next attempt, up to max(Exponential Backoff)
		delay *= 2
		if delay > config.MaxDelay {
			delay = config.MaxDelay
		}
	}

	return fmt.Errorf("operation '%s' failed after %d attempts, last error: %w",
		operationName, config.MaxAttempts, lastErr)
}

// Database helper functions
func initDatabase() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Println("Warning: DATABASE_URL not set, path persistence disabled")
		return
	}

	var err error
	db, err = sql.Open("postgres", databaseURL)
	if err != nil {
		log.Printf("Failed to connect to database: %v", err)
		return
	}

	// Test the connection
	if err := db.Ping(); err != nil {
		log.Printf("Failed to ping database: %v", err)
		db = nil
		return
	}

	log.Println("Database connection established successfully")
}

// waitForMediaMTXReady waits for MediaMTX API to become available with retry logic
func waitForMediaMTXReady(maxWaitTime time.Duration) error {
	mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
	if mediamtxAPIURL == "" {
		mediamtxAPIURL = "http://localhost:9997"
	}

	checkInterval := 2 * time.Second
	timeout := time.After(maxWaitTime)
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	log.Printf("Waiting for MediaMTX API to become ready at %s (timeout: %v)", mediamtxAPIURL, maxWaitTime)

	for {
		select {
		case <-timeout:
			return fmt.Errorf("timeout waiting for MediaMTX API after %v", maxWaitTime)
		case <-ticker.C:
			client := &http.Client{Timeout: 3 * time.Second}
			resp, err := client.Get(mediamtxAPIURL + "/v3/paths/list")
			if err != nil {
				log.Printf("MediaMTX API not ready yet: %v", err)
				continue
			}
			resp.Body.Close()

			if resp.StatusCode == http.StatusOK {
				log.Println("MediaMTX API is ready")
				return nil
			}
			log.Printf("MediaMTX API returned unexpected status: %d", resp.StatusCode)
		}
	}
}

// isMediaMTXHealthy checks if MediaMTX API is responding
func isMediaMTXHealthy() bool {
	mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
	if mediamtxAPIURL == "" {
		mediamtxAPIURL = "http://localhost:9997"
	}

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(mediamtxAPIURL + "/v3/paths/list")
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK
}

// updateCameraPathInfo stores MediaMTX path information in the database
func updateCameraPathInfo(cameraID, pathName string, configured bool) {
	if db == nil {
		return // Database not available
	}

	var lastProcessedAt interface{}
	if configured {
		lastProcessedAt = time.Now()
	}

	query := `
		UPDATE cameras
		SET "mediamtxPath" = $1,
		    "mediamtxConfigured" = $2,
		    "lastProcessedAt" = $3,
		    status = $4
		WHERE id = $5
	`

	status := "PROCESSING"
	if !configured {
		status = "OFFLINE"
		lastProcessedAt = nil
	}

	_, err := db.Exec(query, pathName, configured, lastProcessedAt, status, cameraID)
	if err != nil {
		log.Printf("Failed to update camera path info: %v", err)
	} else {
		log.Printf("Updated database: camera %s, path %s, configured: %t", cameraID, pathName, configured)
	}
}

// getCameraInfo retrieves camera information from database
func getCameraInfo(cameraID string) (rtspURL, pathName string, configured bool, err error) {
	if db == nil {
		return "", "", false, fmt.Errorf("database not available")
	}

	query := `
		SELECT "rtspUrl", "mediamtxPath", "mediamtxConfigured"
		FROM cameras
		WHERE id = $1
	`

	var dbRtspURL, dbPathName sql.NullString
	var dbConfigured sql.NullBool

	err = db.QueryRow(query, cameraID).Scan(&dbRtspURL, &dbPathName, &dbConfigured)
	if err != nil {
		return "", "", false, err
	}

	return dbRtspURL.String, dbPathName.String, dbConfigured.Bool, nil
}

// restoreActivePaths restores MediaMTX paths for cameras that were processing before restart
func restoreActivePaths() {
	if db == nil {
		log.Println("Database not available, skipping path restoration")
		return
	}

	// Wait for MediaMTX to be fully ready before attempting restoration
	log.Println("Waiting for MediaMTX API to become ready before path restoration...")
	if err := waitForMediaMTXReady(30 * time.Second); err != nil {
		log.Printf("MediaMTX not ready after waiting: %v", err)
		log.Println("Will retry path restoration later...")
		// Schedule retry after 30 seconds
		time.AfterFunc(30*time.Second, restoreActivePaths)
		return
	}

	// Query cameras that need restoration
	// Include both actively processing cameras AND cameras with configured paths
	query := `
		SELECT id, "rtspUrl", "mediamtxPath", enabled, status
		FROM cameras
		WHERE "mediamtxConfigured" = true
	`

	rows, err := db.Query(query)
	if err != nil {
		log.Printf("Failed to query cameras for restoration: %v", err)
		return
	}
	defer rows.Close()

	type CameraToRestore struct {
		ID       string
		RTSPURL  string
		PathName string
		Enabled  bool
		Status   string
	}

	camerasToRestore := []CameraToRestore{}
	for rows.Next() {
		var camera CameraToRestore
		if err := rows.Scan(&camera.ID, &camera.RTSPURL, &camera.PathName, &camera.Enabled, &camera.Status); err != nil {
			log.Printf("Failed to scan camera row: %v", err)
			continue
		}
		camerasToRestore = append(camerasToRestore, camera)
	}

	if len(camerasToRestore) == 0 {
		log.Println("No camera paths to restore")
		return
	}

	log.Printf("Found %d cameras with configured MediaMTX paths", len(camerasToRestore))

	restoredCount := 0
	preconfiguredCount := 0

	for _, camera := range camerasToRestore {
		log.Printf("Processing camera %s (enabled: %v, status: %s, path: %s)",
			camera.ID, camera.Enabled, camera.Status, camera.PathName)

		// If camera was actively processing, restart the stream
		if camera.Enabled && camera.Status == "PROCESSING" {
			log.Printf("Restoring active stream for camera %s", camera.ID)

			// Use retry logic for restoration
			retryConfig := RetryConfig{
				MaxAttempts: 3,
				BaseDelay:   2 * time.Second,
				MaxDelay:    10 * time.Second,
			}

			err := RetryOperation(func() error {
				return startReencodingProcess(camera.ID, camera.RTSPURL)
			}, retryConfig, fmt.Sprintf("restore camera %s", camera.ID))

			if err != nil {
				log.Printf("Failed to restore camera %s after retries: %v", camera.ID, err)
				// Update status to ERROR
				updateCameraPathInfo(camera.ID, camera.PathName, false)
				continue
			}

			restoredCount++
			log.Printf("Successfully restored active stream for camera %s", camera.ID)
		} else {
			// Camera is registered but not actively streaming
			// Just ensure the path info is in database (already configured)
			log.Printf("Camera %s is registered but not streaming (path pre-configured)", camera.ID)
			preconfiguredCount++
		}
	}

	log.Printf("Path restoration completed: %d streams restored, %d paths pre-configured",
		restoredCount, preconfiguredCount)
}

func main() {
	// Get port from environment or default to 8080
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Initialize database connection
	log.Println("Initializing database connection...")
	initDatabase()

	// Initialize Kafka producer
	log.Println("Initializing Kafka producer...")
	var err error
	kafkaProducer, err = NewKafkaProducer("camera-events")
	if err != nil {
		log.Printf("Warning: Failed to initialize Kafka producer: %v", err)
		log.Println("Face detection alerts will not be sent to Kafka")
	} else {
		log.Println("Kafka producer initialized successfully")
	}

	// Initialize face detector
	log.Println("Initializing face detector...")
	faceDetector, err = NewFaceDetector(kafkaProducer)
	if err != nil {
		log.Printf("Warning: Failed to initialize face detector: %v", err)
		log.Println("Face detection will be disabled")
	} else if faceDetector.enabled {
		log.Println("Face detector initialized successfully")
	}

	// Create Gin router
	r := gin.Default()

	r.Use(cors.Default()) // All origins allowed by default

	// Health check endpoint
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "healthy",
			"service": "skylark-worker",
		})
	})

	// GET /streams - List all active streams with MediaMTX links
	r.GET("/streams", func(c *gin.Context) {
		processMutex.RLock()
		streamMetricsMutex.RLock()
		defer processMutex.RUnlock()
		defer streamMetricsMutex.RUnlock()

		mediamtxWebRTCURL := os.Getenv("MEDIAMTX_WEBRTC_URL")
		if mediamtxWebRTCURL == "" {
			mediamtxWebRTCURL = "http://localhost:8891"
		}

		type StreamInfo struct {
			CameraID        string    `json:"cameraId"`
			PathName        string    `json:"pathName"`
			WebRTCURL       string    `json:"webrtcUrl"`
			RTSPSourceURL   string    `json:"rtspSourceUrl"`
			Status          string    `json:"status"`
			StartTime       time.Time `json:"startTime"`
			Uptime          string    `json:"uptime"`
			FramesProcessed uint64    `json:"framesProcessed,omitempty"`
		}

		streams := make([]StreamInfo, 0, len(activeProcesses))
		for cameraID, process := range activeProcesses {
			pathName := fmt.Sprintf("camera_%s", cameraID)
			webrtcURL := fmt.Sprintf("%s/%s", mediamtxWebRTCURL, pathName)

			info := StreamInfo{
				CameraID:      cameraID,
				PathName:      pathName,
				WebRTCURL:     webrtcURL,
				RTSPSourceURL: process.SourceURL,
				Status:        "ACTIVE",
			}

			// Add metrics if available
			if metrics, exists := streamMetrics[cameraID]; exists {
				info.StartTime = metrics.StartTime
				info.Uptime = time.Since(metrics.StartTime).Round(time.Second).String()
				info.FramesProcessed = metrics.FramesProcessed
			}

			streams = append(streams, info)
		}

		c.JSON(http.StatusOK, gin.H{
			"streams":       streams,
			"total":         len(streams),
			"maxConcurrent": workerConfig.MaxConcurrentStreams,
		})
	})

	// GET /metrics - Resource usage metrics
	r.GET("/metrics", func(c *gin.Context) {
		processMutex.RLock()
		streamMetricsMutex.RLock()
		activeCount := len(activeProcesses)
		processMutex.RUnlock()

		type MetricsSummary struct {
			CameraID        string `json:"cameraId"`
			Uptime          string `json:"uptime"`
			FramesProcessed uint64 `json:"framesProcessed"`
			ErrorCount      int    `json:"errorCount"`
		}

		metricsData := make([]MetricsSummary, 0, len(streamMetrics))
		for cameraID, metrics := range streamMetrics {
			metricsData = append(metricsData, MetricsSummary{
				CameraID:        cameraID,
				Uptime:          time.Since(metrics.StartTime).Round(time.Second).String(),
				FramesProcessed: metrics.FramesProcessed,
				ErrorCount:      metrics.ErrorCount,
			})
		}
		streamMetricsMutex.RUnlock()

		c.JSON(http.StatusOK, gin.H{
			"activeStreams": activeCount,
			"maxStreams":    workerConfig.MaxConcurrentStreams,
			"utilization":   fmt.Sprintf("%.1f%%", float64(activeCount)/float64(workerConfig.MaxConcurrentStreams)*100),
			"streams":       metricsData,
		})
	})

	// GET /health/streams - Health check for all streams
	r.GET("/health/streams", func(c *gin.Context) {
		processMutex.RLock()
		activeCount := len(activeProcesses)
		processMutex.RUnlock()

		healthy := true
		issues := []string{}

		// Check if we're at capacity
		if activeCount >= workerConfig.MaxConcurrentStreams {
			healthy = false
			issues = append(issues, "at maximum capacity")
		}

		// Check for stale streams (no activity in 5 minutes)
		streamMetricsMutex.RLock()
		for cameraID, metrics := range streamMetrics {
			if time.Since(metrics.LastFrameTime) > 5*time.Minute {
				healthy = false
				issues = append(issues, fmt.Sprintf("camera %s: no activity for %v", cameraID, time.Since(metrics.LastFrameTime)))
			}
		}
		streamMetricsMutex.RUnlock()

		status := "healthy"
		statusCode := http.StatusOK
		if !healthy {
			status = "unhealthy"
			statusCode = http.StatusServiceUnavailable
		}

		c.JSON(statusCode, gin.H{
			"status":        status,
			"activeStreams": activeCount,
			"maxStreams":    workerConfig.MaxConcurrentStreams,
			"issues":        issues,
		})
	})

	// MediaMTX path status endpoint for debugging
	r.GET("/mediamtx/paths", func(c *gin.Context) {
		mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
		if mediamtxAPIURL == "" {
			mediamtxAPIURL = "http://localhost:9997"
		}

		client := &http.Client{Timeout: 5 * time.Second}
		resp, err := client.Get(mediamtxAPIURL + "/v3/paths/list")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": fmt.Sprintf("Failed to get MediaMTX paths: %v", err),
			})
			return
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		c.Header("Content-Type", "application/json")
		c.String(resp.StatusCode, string(body))
	})

	// Individual path status endpoint
	r.GET("/mediamtx/path/:pathName", func(c *gin.Context) {
		pathName := c.Param("pathName")
		mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
		if mediamtxAPIURL == "" {
			mediamtxAPIURL = "http://localhost:9997"
		}

		apiURL := fmt.Sprintf("%s/v3/paths/get/%s", mediamtxAPIURL, pathName)
		client := &http.Client{Timeout: 5 * time.Second}

		req, err := http.NewRequest("GET", apiURL, nil)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": fmt.Sprintf("Failed to create request: %v", err),
			})
			return
		}
		// req.SetBasicAuth("admin", "admin")

		resp, err := client.Do(req)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": fmt.Sprintf("Failed to get path status: %v", err),
			})
			return
		}
		defer resp.Body.Close()

		body, _ := io.ReadAll(resp.Body)
		c.Header("Content-Type", "application/json")
		c.String(resp.StatusCode, string(body))
	})

	// Register camera and configure MediaMTX path (without starting stream)
	r.POST("/register", func(c *gin.Context) {
		var req struct {
			CameraID string `json:"cameraId" binding:"required"`
			Name     string `json:"name"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		log.Printf("Registering camera %s for MediaMTX path configuration", req.CameraID)

		// Check MediaMTX health before proceeding
		if !isMediaMTXHealthy() {
			log.Printf("MediaMTX is not healthy, cannot register camera %s", req.CameraID)
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "MediaMTX service is not available",
			})
			return
		}

		// Generate path name for MediaMTX
		pathName := fmt.Sprintf("camera_%s", req.CameraID)

		// Pre-configure MediaMTX path (will accept any publisher)
		// This ensures the path exists before FFmpeg tries to stream
		log.Printf("Pre-configuring MediaMTX path: %s", pathName)

		// Update database to mark camera as registered
		updateCameraPathInfo(req.CameraID, pathName, true)

		log.Printf("Successfully registered camera %s with path %s", req.CameraID, pathName)
		c.JSON(http.StatusOK, gin.H{
			"message":            fmt.Sprintf("Camera %s registered successfully", req.CameraID),
			"pathName":           pathName,
			"mediamtxPath":       pathName,
			"mediamtxConfigured": true,
		})
	})

	// Pre-configure MediaMTX paths for multiple cameras (batch registration)
	r.POST("/preconfig-paths", func(c *gin.Context) {
		var req struct {
			Cameras []struct {
				CameraID string `json:"cameraId" binding:"required"`
				Name     string `json:"name"`
			} `json:"cameras" binding:"required"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		log.Printf("Pre-configuring MediaMTX paths for %d cameras", len(req.Cameras))

		// Check MediaMTX health before proceeding
		if !isMediaMTXHealthy() {
			log.Println("MediaMTX is not healthy, cannot pre-configure paths")
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "MediaMTX service is not available",
			})
			return
		}

		type PreconfigResult struct {
			CameraID string `json:"cameraId"`
			PathName string `json:"pathName"`
			Success  bool   `json:"success"`
			Error    string `json:"error,omitempty"`
		}

		results := make([]PreconfigResult, 0, len(req.Cameras))
		successCount := 0

		for _, camera := range req.Cameras {
			pathName := fmt.Sprintf("camera_%s", camera.CameraID)
			result := PreconfigResult{
				CameraID: camera.CameraID,
				PathName: pathName,
			}

			// Update database to mark camera path as configured
			updateCameraPathInfo(camera.CameraID, pathName, true)
			result.Success = true
			successCount++
			log.Printf("Pre-configured path for camera %s: %s", camera.CameraID, pathName)

			results = append(results, result)
		}

		log.Printf("Pre-configuration completed: %d/%d successful", successCount, len(req.Cameras))
		c.JSON(http.StatusOK, gin.H{
			"message":    fmt.Sprintf("Pre-configured %d/%d camera paths", successCount, len(req.Cameras)),
			"total":      len(req.Cameras),
			"successful": successCount,
			"failed":     len(req.Cameras) - successCount,
			"results":    results,
		})
	})

	// Unified camera processing endpoint
	r.POST("/process", func(c *gin.Context) {
		var req struct {
			CameraID string `json:"cameraId" binding:"required"`
			RTSPURL  string `json:"rtspUrl" binding:"required"`
			Name     string `json:"name"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		// Check if we've reached the concurrent stream limit
		processMutex.RLock()
		activeCount := len(activeProcesses)
		processMutex.RUnlock()

		if activeCount >= workerConfig.MaxConcurrentStreams {
			log.Printf("Cannot start camera %s: reached max concurrent streams (%d/%d)",
				req.CameraID, activeCount, workerConfig.MaxConcurrentStreams)
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error": fmt.Sprintf("Maximum concurrent streams reached (%d/%d)",
					activeCount, workerConfig.MaxConcurrentStreams),
			})
			return
		}

		log.Printf("Starting processing for camera %s with RTSP URL: %s", req.CameraID, req.RTSPURL)

		// Generate path name for MediaMTX
		pathName := fmt.Sprintf("camera_%s", req.CameraID)

		// Stop any existing process for this camera first
		// This will also clean up the MediaMTX path
		stopReencodingProcess(req.CameraID)

		// Wait a moment for cleanup to complete
		time.Sleep(500 * time.Millisecond)

		// Start re-encoding process to remove B-frames
		err := startReencodingProcess(req.CameraID, req.RTSPURL)
		if err != nil {
			log.Printf("Failed to start re-encoding process: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"error": fmt.Sprintf("Failed to start re-encoding: %v", err),
			})
			return
		}

		// Wait for MediaMTX path to be ready with stream
		log.Printf("Waiting for MediaMTX path %s to receive stream from FFmpeg...", pathName)
		streamReadyErr := waitForPathWithStream(pathName, 60*time.Second)
		if streamReadyErr != nil {
			log.Printf("Error: Stream not ready for path %s: %v", pathName, streamReadyErr)
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error":   fmt.Sprintf("Stream not ready: %v", streamReadyErr),
				"message": "FFmpeg stream did not become ready in time",
			})
			return
		}
		log.Printf("MediaMTX path %s has active stream and is ready", pathName)

		log.Printf("Successfully started processing for camera %s", req.CameraID)
		c.JSON(http.StatusOK, gin.H{
			"message":   fmt.Sprintf("Camera %s processing started", req.CameraID),
			"pathName":  pathName,
			"status":    "ready",
			"sessionId": pathName,
			"webrtcUrl": fmt.Sprintf("%s/%s", os.Getenv("MEDIAMTX_WEBRTC_URL"), pathName),
		})
	})

	// POST /process-batch - Start processing multiple cameras
	r.POST("/process-batch", func(c *gin.Context) {
		var req struct {
			Cameras []struct {
				CameraID string `json:"cameraId" binding:"required"`
				RTSPURL  string `json:"rtspUrl" binding:"required"`
				Name     string `json:"name"`
			} `json:"cameras" binding:"required"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		// Check if batch would exceed limit
		processMutex.RLock()
		activeCount := len(activeProcesses)
		processMutex.RUnlock()

		if activeCount+len(req.Cameras) > workerConfig.MaxConcurrentStreams {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error": fmt.Sprintf("Batch would exceed max concurrent streams (%d/%d)",
					activeCount+len(req.Cameras), workerConfig.MaxConcurrentStreams),
			})
			return
		}

		type BatchResult struct {
			CameraID string `json:"cameraId"`
			Success  bool   `json:"success"`
			PathName string `json:"pathName,omitempty"`
			Error    string `json:"error,omitempty"`
		}

		results := make([]BatchResult, 0, len(req.Cameras))
		var wg sync.WaitGroup
		resultsMutex := sync.Mutex{}

		// Start cameras concurrently
		for _, camera := range req.Cameras {
			wg.Add(1)
			go func(cam struct {
				CameraID string `json:"cameraId" binding:"required"`
				RTSPURL  string `json:"rtspUrl" binding:"required"`
				Name     string `json:"name"`
			}) {
				defer wg.Done()

				pathName := fmt.Sprintf("camera_%s", cam.CameraID)
				result := BatchResult{
					CameraID: cam.CameraID,
					PathName: pathName,
				}

				// Stop any existing process
				stopReencodingProcess(cam.CameraID)
				time.Sleep(500 * time.Millisecond)

				// Start re-encoding
				err := startReencodingProcess(cam.CameraID, cam.RTSPURL)
				if err != nil {
					result.Success = false
					result.Error = err.Error()
					log.Printf("Batch: Failed to start camera %s: %v", cam.CameraID, err)
				} else {
					result.Success = true
					log.Printf("Batch: Successfully started camera %s", cam.CameraID)
				}

				resultsMutex.Lock()
				results = append(results, result)
				resultsMutex.Unlock()
			}(camera)
		}

		wg.Wait()

		// Count successes
		successCount := 0
		for _, result := range results {
			if result.Success {
				successCount++
			}
		}

		c.JSON(http.StatusOK, gin.H{
			"message":    fmt.Sprintf("Batch processing completed: %d/%d successful", successCount, len(req.Cameras)),
			"total":      len(req.Cameras),
			"successful": successCount,
			"failed":     len(req.Cameras) - successCount,
			"results":    results,
		})
	})

	r.POST("/stop", func(c *gin.Context) {
		var req struct {
			CameraID string `json:"cameraId" binding:"required"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		log.Printf("Stopping processing for camera %s", req.CameraID)

		// Stop the re-encoding process
		stopReencodingProcess(req.CameraID)

		// // Clean up MediaMTX path
		pathName := fmt.Sprintf("camera_%s", req.CameraID)
		// if err := cleanupMediaMTXPath(pathName); err != nil {
		// 	log.Printf("Warning: Failed to cleanup MediaMTX path %s: %v", pathName, err)
		// 	// Don't fail the entire request just because cleanup failed
		// }

		log.Printf("Successfully stopped processing for camera %s", req.CameraID)
		c.JSON(http.StatusOK, gin.H{
			"message":  fmt.Sprintf("Stopped processing for camera %s", req.CameraID),
			"pathName": pathName,
		})
	})

	// POST /face-detection/toggle - Toggle face detection for a camera
	r.POST("/face-detection/toggle", func(c *gin.Context) {
		var req struct {
			CameraID string `json:"cameraId" binding:"required"`
			Enabled  bool   `json:"enabled"`
		}

		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		log.Printf("Toggle face detection for camera %s: %v", req.CameraID, req.Enabled)

		if req.Enabled {
			// Start face detection if not already running
			processMutex.RLock()
			process, exists := activeProcesses[req.CameraID]
			processMutex.RUnlock()

			if !exists {
				c.JSON(http.StatusBadRequest, gin.H{
					"error": "Camera is not actively streaming. Start the camera first.",
				})
				return
			}

			// Get RTSP URL from database
			rtspURL, _, _, err := getCameraInfo(req.CameraID)
			if err != nil {
				log.Printf("Failed to get camera info: %v", err)
				c.JSON(http.StatusInternalServerError, gin.H{
					"error": fmt.Sprintf("Failed to get camera info: %v", err),
				})
				return
			}

			// Check if face detection is already active
			faceDetectionMutex.RLock()
			_, alreadyActive := faceDetectionActive[req.CameraID]
			faceDetectionMutex.RUnlock()

			if alreadyActive {
				c.JSON(http.StatusOK, gin.H{
					"message":  "Face detection already active for this camera",
					"cameraId": req.CameraID,
					"enabled":  true,
				})
				return
			}

			// Start face detection
			faceDetectionCtx, faceDetectionCancel := context.WithCancel(process.Context)
			faceDetectionMutex.Lock()
			faceDetectionActive[req.CameraID] = faceDetectionCancel
			faceDetectionMutex.Unlock()

			startFaceDetection(req.CameraID, rtspURL, faceDetectionCtx)

			log.Printf("Face detection started for camera %s", req.CameraID)
			c.JSON(http.StatusOK, gin.H{
				"message":  "Face detection enabled successfully",
				"cameraId": req.CameraID,
				"enabled":  true,
			})
		} else {
			// Stop face detection
			stopFaceDetection(req.CameraID)

			log.Printf("Face detection stopped for camera %s", req.CameraID)
			c.JSON(http.StatusOK, gin.H{
				"message":  "Face detection disabled successfully",
				"cameraId": req.CameraID,
				"enabled":  false,
			})
		}
	})

	// WebRTC offer endpoint - now redirects to unified processing
	r.POST("/webrtc/offer", func(c *gin.Context) {
		var req WebRTCOfferRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, WebRTCOfferResponse{
				Status: "error",
				Error:  fmt.Sprintf("Invalid request: %v", err),
			})
			return
		}

		log.Printf("Received WebRTC offer for camera %s, redirecting to unified processing", req.CameraID)

		// // Forward to unified processing endpoint
		// processReq := struct {
		// 	CameraID string `json:"cameraId"`
		// 	RTSPURL  string `json:"rtspUrl"`
		// 	Name     string `json:"name"`
		// }{
		// 	CameraID: req.CameraID,
		// 	RTSPURL:  req.RTSPURL,
		// 	Name:     fmt.Sprintf("Camera_%s", req.CameraID),
		// }

		// Call unified processing internally
		pathName := fmt.Sprintf("camera_%s", req.CameraID)

		// Stop any existing process for this camera first
		// This will also clean up the MediaMTX path
		stopReencodingProcess(req.CameraID)

		// Wait a moment for cleanup to complete
		time.Sleep(500 * time.Millisecond)

		// Start re-encoding process
		err := startReencodingProcess(req.CameraID, req.RTSPURL)
		if err != nil {
			log.Printf("Failed to start re-encoding process: %v", err)
			c.JSON(http.StatusInternalServerError, WebRTCOfferResponse{
				Status: "error",
				Error:  fmt.Sprintf("Failed to start re-encoding: %v", err),
			})
			return
		}

		// MediaMTX will automatically accept the incoming stream from FFmpeg
		// FFmpeg publishes to rtsp://mediamtx:8554/camera_{id} and MediaMTX receives it
		log.Printf("MediaMTX path %s ready to receive FFmpeg stream", pathName)

		log.Printf("Successfully configured MediaMTX path %s for camera %s", pathName, req.CameraID)

		c.JSON(http.StatusOK, WebRTCOfferResponse{
			Answer:    "",
			SessionID: pathName,
			Status:    "mediamtx_configured",
		})
	})

	// Restore active camera paths after MediaMTX is ready
	log.Println("Scheduling path restoration after MediaMTX initialization...")
	go func() {
		// Wait longer for MediaMTX to be fully ready (increased from 5s to 10s)
		time.Sleep(10 * time.Second)
		restoreActivePaths()
	}()

	// Setup cleanup on shutdown
	defer func() {
		log.Println("Shutting down worker service...")

		// Close Kafka producer
		if kafkaProducer != nil {
			log.Println("Closing Kafka producer...")
			if err := kafkaProducer.Close(); err != nil {
				log.Printf("Error closing Kafka producer: %v", err)
			}
		}

		// Close face detector
		if faceDetector != nil {
			log.Println("Closing face detector...")
			faceDetector.Close()
		}

		log.Println("Worker service shutdown complete")
	}()

	// Start server
	fmt.Printf("Worker service starting on port %s\n", port)
	log.Fatal(r.Run(":" + port))
}

// cleanupMediaMTXPath removes a path from MediaMTX
func cleanupMediaMTXPath(pathName string) error {
	mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
	if mediamtxAPIURL == "" {
		mediamtxAPIURL = "http://localhost:9997"
	}

	// Delete the path
	deleteURL := mediamtxAPIURL + "/v3/config/paths/delete/" + pathName
	deleteReq, err := http.NewRequest("DELETE", deleteURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create delete request: %w", err)
	}
	deleteReq.SetBasicAuth("admin", "admin")

	client := &http.Client{Timeout: 10 * time.Second}
	deleteResp, err := client.Do(deleteReq)
	if err != nil {
		return fmt.Errorf("failed to delete path: %w", err)
	}
	defer deleteResp.Body.Close()

	if deleteResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(deleteResp.Body)
		// Don't treat "path not found" as an error
		if deleteResp.StatusCode == http.StatusNotFound {
			log.Printf("MediaMTX path %s was already deleted or didn't exist", pathName)
			return nil
		}
		return fmt.Errorf("failed to delete path %s: status %d, body: %s", pathName, deleteResp.StatusCode, string(body))
	}

	log.Printf("Successfully cleaned up MediaMTX path: %s", pathName)

	// Update database to reflect path cleanup
	cameraID := getCorrespondingCameraID(pathName)
	updateCameraPathInfo(cameraID, pathName, false)

	return nil
}

// forceCleanupMediaMTXPath forcefully removes a path from MediaMTX with multiple attempts
func forceCleanupMediaMTXPath(pathName string) error {
	mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
	if mediamtxAPIURL == "" {
		mediamtxAPIURL = "http://localhost:9997"
	}

	client := &http.Client{Timeout: 5 * time.Second}

	// Try multiple deletion attempts
	for attempt := 1; attempt <= 3; attempt++ {
		log.Printf("Force cleanup attempt %d for MediaMTX path: %s", attempt, pathName)

		// Delete the path
		deleteURL := mediamtxAPIURL + "/v3/config/paths/delete/" + pathName
		deleteReq, err := http.NewRequest("DELETE", deleteURL, nil)
		if err != nil {
			return fmt.Errorf("failed to create delete request: %w", err)
		}
		deleteReq.SetBasicAuth("admin", "admin")

		deleteResp, err := client.Do(deleteReq)
		if err != nil {
			log.Printf("Delete attempt %d failed: %v", attempt, err)
			if attempt < 3 {
				time.Sleep(time.Duration(attempt) * time.Second)
				continue
			}
			return fmt.Errorf("failed to delete path after %d attempts: %w", attempt, err)
		}
		defer deleteResp.Body.Close()

		if deleteResp.StatusCode == http.StatusOK || deleteResp.StatusCode == http.StatusNotFound {
			log.Printf("Successfully force cleaned up MediaMTX path: %s", pathName)
			return nil
		}

		body, _ := io.ReadAll(deleteResp.Body)
		log.Printf("Delete attempt %d failed with status %d: %s", attempt, deleteResp.StatusCode, string(body))

		if attempt < 3 {
			time.Sleep(time.Duration(attempt) * time.Second)
		}
	}

	return fmt.Errorf("failed to force cleanup path %s after 3 attempts", pathName)
}

// configureMediaMTXPath configures a path in MediaMTX via API and waits for it to be ready
func configureMediaMTXPath(pathName, rtspURL string) error {
	// Get MediaMTX API URL from environment or default
	mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
	if mediamtxAPIURL == "" {
		mediamtxAPIURL = "http://localhost:9997"
	}

	// Ensure the path is clean before creating
	log.Printf("Ensuring MediaMTX path %s is clean before configuration", pathName)
	if err := cleanupMediaMTXPath(pathName); err != nil {
		log.Printf("Warning: Failed to cleanup existing path %s: %v", pathName, err)
	}

	// Wait a moment for cleanup to complete
	time.Sleep(500 * time.Millisecond)

	// MediaMTX API endpoint
	apiURL := mediamtxAPIURL + "/v3/config/paths/add/" + pathName

	// Path configuration optimized for WebRTC streaming
	// Removed deprecated parameters: readTimeout, writeTimeout, sourceProtocol,
	// rtspTransport, rtspsTransport, webrtcICEUDPMuxAddress, webrtcICETCPMuxAddress
	pathConfig := map[string]any{
		"source":         rtspURL,
		"sourceOnDemand": false, // Start immediately
		"runOnInit":      "",    // No init command
		"runOnDemand":    "",    // No demand command
		"runOnReady":     "",    // No ready command
	}

	// Convert to JSON
	jsonData, err := json.Marshal(pathConfig)
	if err != nil {
		return fmt.Errorf("failed to marshal path config: %w", err)
	}

	// Create HTTP request with basic auth and timeout
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("POST", apiURL, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.SetBasicAuth("admin", "admin") // Default MediaMTX credentials

	// Configure retry for MediaMTX API calls
	retryConfig := RetryConfig{
		MaxAttempts: 3,
		BaseDelay:   2 * time.Second,
		MaxDelay:    10 * time.Second,
	}

	var resp *http.Response
	err = RetryOperation(func() error {
		// Create new request for each attempt to avoid reused body issues
		retryReq, reqErr := http.NewRequest("POST", apiURL, bytes.NewBuffer(jsonData))
		if reqErr != nil {
			return fmt.Errorf("failed to create request: %w", reqErr)
		}
		retryReq.Header.Set("Content-Type", "application/json")
		retryReq.SetBasicAuth("admin", "admin")

		var httpErr error
		resp, httpErr = client.Do(retryReq)
		if httpErr != nil {
			return fmt.Errorf("HTTP request failed: %w", httpErr)
		}

		// Don't defer close here since we need to use resp outside this function
		// Check if the request was successful
		if resp.StatusCode >= 500 {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			return fmt.Errorf("MediaMTX server error (status %d): %s", resp.StatusCode, string(body))
		}

		return nil
	}, retryConfig, fmt.Sprintf("MediaMTX API call for path %s", pathName))

	if err != nil {
		return fmt.Errorf("failed to make API request after retries: %w", err)
	}
	defer resp.Body.Close()

	// Check response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read API response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		// Log detailed error information
		log.Printf("MediaMTX API error - Status: %d, Response: %s, URL: %s",
			resp.StatusCode, string(body), apiURL)

		// Handle case where path already exists (shouldn't happen after cleanup)
		if resp.StatusCode == http.StatusBadRequest && bytes.Contains(body, []byte("path already exists")) {
			log.Printf("MediaMTX path %s still exists after cleanup, forcing removal...", pathName)
			// Force cleanup and try again
			if err := forceCleanupMediaMTXPath(pathName); err != nil {
				return fmt.Errorf("failed to force cleanup path %s: %w", pathName, err)
			}
			time.Sleep(1 * time.Second)

			// Retry the request - create new request to reset body
			retryReq, err := http.NewRequest("POST", apiURL, bytes.NewBuffer(jsonData))
			if err != nil {
				return fmt.Errorf("failed to create retry request: %w", err)
			}
			retryReq.Header.Set("Content-Type", "application/json")
			retryReq.SetBasicAuth("admin", "admin")

			resp2, err := client.Do(retryReq)
			if err != nil {
				return fmt.Errorf("failed to retry API request: %w", err)
			}
			defer resp2.Body.Close()

			if resp2.StatusCode != http.StatusOK {
				body2, _ := io.ReadAll(resp2.Body)
				log.Printf("MediaMTX API retry failed - Status: %d, Response: %s",
					resp2.StatusCode, string(body2))
				return fmt.Errorf("MediaMTX API retry failed with status %d: %s", resp2.StatusCode, string(body2))
			}
			log.Printf("Successfully configured MediaMTX path %s after retry", pathName)
		} else {
			// Provide more detailed error message based on status code
			var errorMsg string
			switch resp.StatusCode {
			case http.StatusBadRequest:
				errorMsg = fmt.Sprintf("Bad request to MediaMTX API (invalid configuration): %s", string(body))
			case http.StatusUnauthorized:
				errorMsg = fmt.Sprintf("MediaMTX API authentication failed: %s", string(body))
			case http.StatusForbidden:
				errorMsg = fmt.Sprintf("MediaMTX API access forbidden: %s", string(body))
			case http.StatusNotFound:
				errorMsg = fmt.Sprintf("MediaMTX API endpoint not found: %s", string(body))
			case http.StatusInternalServerError:
				errorMsg = fmt.Sprintf("MediaMTX internal server error: %s", string(body))
			default:
				errorMsg = fmt.Sprintf("MediaMTX API returned status %d: %s", resp.StatusCode, string(body))
			}
			return fmt.Errorf(errorMsg)
		}
	}

	log.Printf("Successfully configured MediaMTX path: %s", pathName)

	// Wait for the RTSP source to be ready with better error handling
	log.Printf("Waiting for MediaMTX path %s to be ready...", pathName)
	err = waitForPathReady(pathName)
	if err != nil {
		// If path isn't ready, clean up and return error
		log.Printf("Path %s failed to become ready: %v", pathName, err)
		cleanupMediaMTXPath(pathName)
		stopReencodingProcess(getCorrespondingCameraID(pathName))
		return fmt.Errorf("path not ready after waiting: %w", err)
	}

	log.Printf("MediaMTX path %s is ready for streaming", pathName)

	// Store path information in database
	cameraID := getCorrespondingCameraID(pathName)
	updateCameraPathInfo(cameraID, pathName, true)

	return nil
}

// waitForPathWithStream waits for a MediaMTX path to have an active stream with readers
func waitForPathWithStream(pathName string, timeout time.Duration) error {
	checkInterval := 1 * time.Second
	timeoutChan := time.After(timeout)
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
	if mediamtxAPIURL == "" {
		mediamtxAPIURL = "http://localhost:9997"
	}

	log.Printf("Waiting for path %s to have active stream (timeout: %v)", pathName, timeout)

	for {
		select {
		case <-timeoutChan:
			return fmt.Errorf("timeout waiting for path %s to have active stream after %v", pathName, timeout)
		case <-ticker.C:
			apiURL := fmt.Sprintf("%s/v3/paths/get/%s", mediamtxAPIURL, pathName)
			client := &http.Client{Timeout: 3 * time.Second}

			req, err := http.NewRequest("GET", apiURL, nil)
			if err != nil {
				continue
			}
			// No auth needed - MediaMTX configured for anonymous access

			resp, err := client.Do(req)
			if err != nil {
				log.Printf("Error checking path %s: %v (retrying...)", pathName, err)
				continue
			}

			if resp.StatusCode == http.StatusOK {
				var pathInfo map[string]any
				err := json.NewDecoder(resp.Body).Decode(&pathInfo)
				resp.Body.Close()

				if err != nil {
					continue
				}

				// Check if path has active source
				if ready, exists := pathInfo["ready"]; exists && ready == true {
					// Check if there's a source connected (FFmpeg publisher)
					if source, hasSource := pathInfo["source"].(map[string]any); hasSource && source != nil {
						log.Printf("Path %s is ready with active source", pathName)
						return nil
					}

					// Also check if there's actual data being sent (backup check)
					if bytesSent, ok := pathInfo["bytesSent"].(float64); ok && bytesSent > 0 {
						log.Printf("Path %s is ready with %v bytes sent", pathName, bytesSent)
						return nil
					}
					log.Printf("Path %s is ready but no active source yet", pathName)
				}
			} else {
				resp.Body.Close()
			}
		}
	}
}

// waitForPathReady waits for a MediaMTX path to have an active RTSP source
func waitForPathReady(pathName string) error {
	maxWaitTime := 45 * time.Second  // Increased timeout
	checkInterval := 2 * time.Second // Increased interval
	timeout := time.After(maxWaitTime)
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()

	log.Printf("Waiting for MediaMTX path %s to become ready (timeout: %v)", pathName, maxWaitTime)

	for {
		select {
		case <-timeout:
			return fmt.Errorf("timeout waiting for path %s to be ready after %v", pathName, maxWaitTime)
		case <-ticker.C:
			// Get MediaMTX API URL from environment or default
			mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
			if mediamtxAPIURL == "" {
				mediamtxAPIURL = "http://localhost:9997"
			}

			// Check if path has active source
			apiURL := fmt.Sprintf("%s/v3/paths/get/%s", mediamtxAPIURL, pathName)

			// Create GET request with basic auth and timeout
			client := &http.Client{Timeout: 5 * time.Second}
			req, err := http.NewRequest("GET", apiURL, nil)
			if err != nil {
				log.Printf("Error creating request for path %s: %v", pathName, err)
				continue
			}
			req.SetBasicAuth("admin", "admin") // Default MediaMTX credentials

			resp, err := client.Do(req)
			if err != nil {
				log.Printf("Error checking path %s status: %v", pathName, err)
				continue
			}

			if resp.StatusCode == http.StatusOK {
				var pathInfo map[string]any
				err := json.NewDecoder(resp.Body).Decode(&pathInfo)
				resp.Body.Close()

				if err != nil {
					log.Printf("Error parsing path info for %s: %v", pathName, err)
					continue
				}

				// Log detailed path information for debugging
				log.Printf("Path %s status: ready=%v, source=%v", pathName, pathInfo["ready"], pathInfo["source"])

				// Check if path is ready and has an active source
				if ready, exists := pathInfo["ready"]; exists && ready == true {
					if source, hasSource := pathInfo["source"]; hasSource && source != nil {
						log.Printf("Path %s is ready with active source: %v", pathName, source)
						return nil // Path is ready!
					} else {
						log.Printf("Path %s is ready but has no active source yet", pathName)
					}
				} else {
					log.Printf("Path %s is not yet ready", pathName)
				}
			} else {
				resp.Body.Close()
				if resp.StatusCode == http.StatusNotFound {
					log.Printf("Path %s not found in MediaMTX", pathName)
				} else {
					log.Printf("MediaMTX API returned status %d for path %s", resp.StatusCode, pathName)
				}
			}
		}
	}
}

// startReencodingProcess starts an FFmpeg process to re-encode a stream and remove B-frames
func startReencodingProcess(cameraID, sourceURL string) error {
	// Check circuit breaker
	circuitBreakersMutex.Lock()
	cb, exists := circuitBreakers[cameraID]
	if !exists {
		cb = NewCircuitBreaker(cameraID)
		circuitBreakers[cameraID] = cb
	}
	circuitBreakersMutex.Unlock()

	if !cb.CanAttempt() {
		return fmt.Errorf("circuit breaker is open for camera %s, retry later", cameraID)
	}

	processMutex.Lock()
	defer processMutex.Unlock()

	// Check if process already exists and stop it
	if process, exists := activeProcesses[cameraID]; exists {
		log.Printf("Stopping existing re-encoding process for camera %s", cameraID)
		if process.Cancel != nil {
			process.Cancel()
		}
		// Force kill if needed
		if process.Command != nil && process.Command.Process != nil {
			process.Command.Process.Kill()
		}
		delete(activeProcesses, cameraID)
	}

	// Create context for cancellation
	ctx, cancel := context.WithCancel(context.Background())

	// Generate target URL for re-encoded stream
	targetURL := getReencodedStreamURL(cameraID)

	// Create FFmpeg command optimized for WebRTC streaming with minimal packet loss
	cmd := ffmpeg.Input(sourceURL, ffmpeg.KwArgs{
		"rtsp_transport": "tcp",      // Use TCP for input to reduce packet loss
		"buffer_size":    "4000000",  // 4MB buffer (increased for unstable streams)
		"timeout":        "60000000", // 30 second I/O timeout (microseconds) - increased tolerance
		"max_delay":      "5000000",  // 5 second max demux delay
	}).
		Output(targetURL, ffmpeg.KwArgs{
			"c:v":               "libx264",     // H264 codec
			"profile:v":         "baseline",    // Baseline profile (no B-frames)
			"level":             "3.1",         // H264 level
			"preset":            "ultrafast",   // Fastest encoding for low latency
			"tune":              "zerolatency", // Low latency tuning
			"g":                 "30",          // Keyframe every 30 frames (1s at 30fps)
			"keyint_min":        "30",          // Minimum keyframe interval
			"bf":                "0",           // No B-frames
			"refs":              "1",           // Single reference frame
			"maxrate":           "1500k",       // Maximum bitrate 1.5Mbps
			"bufsize":           "3000k",       // Buffer size 3Mbps
			"pix_fmt":           "yuv420p",     // Compatible pixel format
			"c:a":               "aac",         // Audio codec
			"b:a":               "64k",         // Audio bitrate
			"ar":                "44100",       // Audio sample rate
			"f":                 "rtsp",        // Output format
			"rtsp_transport":    "tcp",         // Use TCP transport
			"timeout":           "60000000",    // 30s Output I/O timeout (increased)
			"muxdelay":          "0.1",         // Reduce mux delay
			"avoid_negative_ts": "make_zero",   // Fix timestamp issues
			"fflags":            "+genpts",     // Generate presentation timestamps
			"err_detect":        "ignore_err",  // Ignore decoding errors to keep stream alive
		}).
		OverWriteOutput()

	// Start the FFmpeg process
	execCmd := cmd.Compile()
	execCmd.Stderr = os.Stderr // Redirect FFmpeg logs

	// Set the context for cancellation
	if ctx != nil {
		execCmd = exec.CommandContext(ctx, execCmd.Args[0], execCmd.Args[1:]...)
		execCmd.Stderr = os.Stderr
	}

	err := execCmd.Start()
	if err != nil {
		cancel()
		cb.RecordFailure()
		return fmt.Errorf("failed to start FFmpeg process: %w", err)
	}

	// Store the process
	activeProcesses[cameraID] = &ReencodingProcess{
		CameraID:  cameraID,
		SourceURL: sourceURL,
		TargetURL: targetURL,
		Context:   ctx,
		Cancel:    cancel,
		Command:   execCmd,
	}

	// Initialize metrics for this stream
	streamMetricsMutex.Lock()
	streamMetrics[cameraID] = &StreamMetrics{
		CameraID:      cameraID,
		StartTime:     time.Now(),
		LastFrameTime: time.Now(),
	}
	streamMetricsMutex.Unlock()

	// Check if face detection is enabled for this camera in the database
	if db != nil {
		var faceDetectionEnabled bool
		query := `SELECT "faceDetectionEnabled" FROM cameras WHERE id = $1`
		err := db.QueryRow(query, cameraID).Scan(&faceDetectionEnabled)

		if err == nil && faceDetectionEnabled {
			log.Printf("Face detection is enabled for camera %s, starting detection...", cameraID)

			// Start face detection for this camera
			faceDetectionMutex.Lock()
			// Stop any existing face detection
			if existingCancel, exists := faceDetectionActive[cameraID]; exists {
				existingCancel()
			}
			// Create new context for face detection
			faceDetectionCtx, faceDetectionCancel := context.WithCancel(context.Background())
			faceDetectionActive[cameraID] = faceDetectionCancel
			faceDetectionMutex.Unlock()

			// Start face detection goroutine
			startFaceDetection(cameraID, sourceURL, faceDetectionCtx)
		} else {
			log.Printf("Face detection is disabled for camera %s (default: false)", cameraID)
		}
	}

	// Monitor the process in a goroutine with enhanced error handling
	go func() {
		err := execCmd.Wait()
		processMutex.Lock()
		delete(activeProcesses, cameraID)
		processMutex.Unlock()

		// Stop face detection
		stopFaceDetection(cameraID)

		// Clean up metrics
		streamMetricsMutex.Lock()
		delete(streamMetrics, cameraID)
		streamMetricsMutex.Unlock()

		if err != nil {
			log.Printf("FFmpeg process for camera %s ended with error: %v", cameraID, err)

			// Record failure in circuit breaker
			circuitBreakersMutex.RLock()
			cb, cbExists := circuitBreakers[cameraID]
			circuitBreakersMutex.RUnlock()

			if cbExists {
				cb.RecordFailure()

				// Auto-restart with exponential backoff if circuit breaker allows
				if cb.CanAttempt() {
					// Calculate backoff delay based on failure count (with jitter)
					failureCount := cb.FailureCount
					baseDelay := 2 * time.Second
					maxDelay := 30 * time.Second

					// Exponential backoff: 2^n seconds (capped at 30s)
					backoffDelay := time.Duration(1<<uint(failureCount)) * baseDelay
					if backoffDelay > maxDelay {
						backoffDelay = maxDelay
					}

					// Add jitter (±20%) to prevent thundering herd
					jitter := time.Duration(float64(backoffDelay) * 0.2 * (2*float64(time.Now().UnixNano()%100)/100.0 - 1))
					backoffDelay += jitter

					log.Printf("Auto-restarting FFmpeg for camera %s after failure (attempt %d, waiting %v)", cameraID, failureCount, backoffDelay)
					time.Sleep(backoffDelay)

					// Get camera info from database
					_, pathName, configured, dbErr := getCameraInfo(cameraID)
					if dbErr == nil && configured {
						// Try to restart
						if restartErr := startReencodingProcess(cameraID, sourceURL); restartErr != nil {
							log.Printf("Failed to auto-restart camera %s: %v", cameraID, restartErr)
							updateCameraPathInfo(cameraID, pathName, false)
						} else {
							log.Printf("Successfully auto-restarted camera %s", cameraID)
						}
						return // Exit goroutine after restart attempt
					}
				} else {
					log.Printf("Circuit breaker open for camera %s, skipping auto-restart (will retry in %v)", cameraID, cb.ResetTimeout)
				}
			}

			// Clean up MediaMTX path on process failure
			pathName := fmt.Sprintf("camera_%s", cameraID)
			if cleanupErr := cleanupMediaMTXPath(pathName); cleanupErr != nil {
				log.Printf("Failed to cleanup MediaMTX path after FFmpeg failure: %v", cleanupErr)
			}
			// Update database status
			updateCameraPathInfo(cameraID, pathName, false)
		} else {
			log.Printf("FFmpeg process for camera %s ended normally", cameraID)

			// Record success in circuit breaker
			circuitBreakersMutex.RLock()
			if cb, exists := circuitBreakers[cameraID]; exists {
				cb.RecordSuccess()
			}
			circuitBreakersMutex.RUnlock()
		}
	}()

	log.Printf("Started re-encoding process for camera %s: %s -> %s", cameraID, sourceURL, targetURL)

	// Wait for the process to start up and begin streaming
	// Check multiple times with shorter intervals for faster feedback
	log.Printf("Waiting for FFmpeg process to establish connection...")
	maxChecks := 10
	checkInterval := 500 * time.Millisecond

	for i := range maxChecks {
		time.Sleep(checkInterval)

		// Check if process is still running
		if execCmd.ProcessState != nil && execCmd.ProcessState.Exited() {
			exitErr := execCmd.ProcessState.String()
			return fmt.Errorf("FFmpeg process exited immediately (%s), check RTSP source: %s", exitErr, sourceURL)
		}

		// After a few checks, consider it successful
		if i >= 5 {
			log.Printf("FFmpeg process for camera %s is running and stable", cameraID)

			// Record success in circuit breaker
			circuitBreakersMutex.RLock()
			if cb, exists := circuitBreakers[cameraID]; exists {
				cb.RecordSuccess()
			}
			circuitBreakersMutex.RUnlock()

			// Update database to mark camera as processing
			pathName := fmt.Sprintf("camera_%s", cameraID)
			updateCameraPathInfo(cameraID, pathName, true)
			return nil
		}
	}

	return nil
}

// stopReencodingProcess stops the re-encoding process for a camera
func stopReencodingProcess(cameraID string) {
	processMutex.Lock()
	defer processMutex.Unlock()

	// Stop face detection first
	stopFaceDetection(cameraID)

	if process, exists := activeProcesses[cameraID]; exists {
		log.Printf("Stopping re-encoding process for camera %s", cameraID)

		// Cancel the context
		if process.Cancel != nil {
			process.Cancel()
		}

		// Try graceful shutdown first, then force kill
		if process.Command != nil && process.Command.Process != nil {
			// Give it 3 seconds to shut down gracefully
			done := make(chan bool, 1)
			go func() {
				process.Command.Wait()
				done <- true
			}()

			select {
			case <-done:
				log.Printf("FFmpeg process for camera %s shut down gracefully", cameraID)
			case <-time.After(3 * time.Second):
				log.Printf("Force killing FFmpeg process for camera %s", cameraID)
				if err := process.Command.Process.Kill(); err != nil {
					log.Printf("Failed to kill FFmpeg process for camera %s: %v", cameraID, err)
				}
			}
		}

		delete(activeProcesses, cameraID)

		// Clean up MediaMTX path after stopping FFmpeg
		// pathName := fmt.Sprintf("camera_%s", cameraID)
		// if err := cleanupMediaMTXPath(pathName); err != nil {
		// 	log.Printf("Warning: Failed to cleanup MediaMTX path %s: %v", pathName, err)
		// }

		log.Printf("Re-encoding process for camera %s stopped and cleaned up", cameraID)
	} else {
		log.Printf("No active re-encoding process found for camera %s", cameraID)
	}
}

// getReencodedStreamURL generates the URL for publishing the re-encoded stream
func getReencodedStreamURL(cameraID string) string {
	// Generate RTSP URL for publishing re-encoded stream to MediaMTX
	// This URL must match the MediaMTX path name for proper routing
	mediamtxURL := "rtsp://localhost:8554"
	// if mediamtxURL == "" {
	// 	mediamtxURL = "rtsp://localhost:8554"
	// }

	// FIXED: Use consistent path naming - camera_{cameraID} (matches MediaMTX path)
	return fmt.Sprintf("%s/camera_%s", mediamtxURL, cameraID)
}

// getCorrespondingCameraID extracts camera ID from MediaMTX path name
func getCorrespondingCameraID(pathName string) string {
	// pathName format: "camera_<cameraID>"
	if len(pathName) > 7 && pathName[:7] == "camera_" {
		return pathName[7:]
	}
	return pathName // fallback
}

// getCameraName retrieves camera name from database
func getCameraName(cameraID string) string {
	if db == nil {
		return ""
	}

	var name string
	query := `SELECT name FROM cameras WHERE id = $1`
	err := db.QueryRow(query, cameraID).Scan(&name)
	if err != nil {
		log.Printf("Failed to get camera name for %s: %v", cameraID, err)
		return ""
	}
	return name
}

// startFaceDetection starts face detection for a camera stream
func startFaceDetection(cameraID, rtspURL string, ctx context.Context) {
	if faceDetector == nil || !faceDetector.enabled {
		return
	}

	log.Printf("Starting face detection for camera %s", cameraID)

	// Get camera name from database
	cameraName := getCameraName(cameraID)
	if cameraName == "" {
		cameraName = fmt.Sprintf("Camera_%s", cameraID)
	}

	go func() {
		// Retry logic for opening video capture (external streams may be slow to start)
		var capture *gocv.VideoCapture
		var err error
		maxRetries := 5
		retryDelay := 3 * time.Second

		for attempt := 1; attempt <= maxRetries; attempt++ {
			select {
			case <-ctx.Done():
				log.Printf("Face detection cancelled for camera %s before video capture opened", cameraID)
				return
			default:
			}

			capture, err = gocv.OpenVideoCapture(rtspURL)
			if err == nil && capture != nil && capture.IsOpened() {
				log.Printf("Successfully opened video capture for face detection on camera %s (attempt %d)", cameraID, attempt)
				break
			}

			if err != nil {
				log.Printf("Failed to open video capture for face detection on camera %s (attempt %d/%d): %v", cameraID, attempt, maxRetries, err)
			}

			if attempt < maxRetries {
				log.Printf("Retrying face detection video capture in %v...", retryDelay)
				time.Sleep(retryDelay)
				retryDelay *= 2 // Exponential backoff
			} else {
				log.Printf("All attempts failed to open video capture for face detection on camera %s", cameraID)
				return
			}
		}
		defer capture.Close()

		// Wait for stream to stabilize
		time.Sleep(5 * time.Second)

		img := gocv.NewMat()
		defer img.Close()

		ticker := time.NewTicker(faceDetector.interval)
		defer ticker.Stop()

		log.Printf("Face detection active for camera %s (interval: %v)", cameraID, faceDetector.interval)

		for {
			select {
			case <-ctx.Done():
				log.Printf("Stopping face detection for camera %s", cameraID)
				return
			case <-ticker.C:
				// Read frame from video capture
				if ok := capture.Read(&img); !ok {
					log.Printf("Failed to read frame from camera %s for face detection", cameraID)
					// Try to reconnect
					capture.Close()
					capture, err = gocv.OpenVideoCapture(rtspURL)
					if err != nil {
						log.Printf("Failed to reconnect video capture for camera %s: %v", cameraID, err)
						return
					}
					continue
				}

				if img.Empty() {
					continue
				}

				// Process frame for face detection
				faceDetector.ProcessFrameForFaceDetection(cameraID, cameraName, img)
			}
		}
	}()
}

// stopFaceDetection stops face detection for a camera
func stopFaceDetection(cameraID string) {
	faceDetectionMutex.Lock()
	defer faceDetectionMutex.Unlock()

	if cancel, exists := faceDetectionActive[cameraID]; exists {
		log.Printf("Stopping face detection for camera %s", cameraID)
		cancel()
		delete(faceDetectionActive, cameraID)
	}
}
