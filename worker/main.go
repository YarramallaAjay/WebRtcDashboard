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

// Global map to track active re-encoding processes
var (
	activeProcesses = make(map[string]*ReencodingProcess)
	processMutex    = sync.RWMutex{}
	db              *sql.DB
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

		// Double the delay for next attempt, up to max
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

	query := `
		SELECT id, "rtspUrl", "mediamtxPath"
		FROM cameras
		WHERE "mediamtxConfigured" = true AND enabled = true AND status = 'PROCESSING'
	`

	rows, err := db.Query(query)
	if err != nil {
		log.Printf("Failed to query active cameras: %v", err)
		return
	}
	defer rows.Close()

	restoredCount := 0
	for rows.Next() {
		var cameraID, rtspURL, pathName string
		if err := rows.Scan(&cameraID, &rtspURL, &pathName); err != nil {
			log.Printf("Failed to scan camera row: %v", err)
			continue
		}

		log.Printf("Restoring path for camera %s: %s", cameraID, pathName)

		// Start re-encoding process
		if err := startReencodingProcess(cameraID, rtspURL); err != nil {
			log.Printf("Failed to restore re-encoding for camera %s: %v", cameraID, err)
			updateCameraPathInfo(cameraID, pathName, false)
			continue
		}

		// MediaMTX will automatically accept the incoming stream from FFmpeg
		// No need to configure a path source - FFmpeg publishes directly to the path
		log.Printf("MediaMTX path %s ready to accept stream from FFmpeg", pathName)

		restoredCount++
		log.Printf("Successfully restored camera %s", cameraID)
	}

	if restoredCount > 0 {
		log.Printf("Restored %d camera paths after restart", restoredCount)
	} else {
		log.Println("No active camera paths to restore")
	}
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

	// MediaMTX path status endpoint for debugging
	r.GET("/mediamtx/paths", func(c *gin.Context) {
		mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
		if mediamtxAPIURL == "" {
			mediamtxAPIURL = "http://mediamtx:9997"
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
			mediamtxAPIURL = "http://mediamtx:9997"
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
		req.SetBasicAuth("admin", "admin")

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

		// MediaMTX will automatically accept the incoming stream from FFmpeg
		// FFmpeg publishes to rtsp://mediamtx:8554/camera_{id} and MediaMTX receives it
		log.Printf("MediaMTX path %s configured to receive FFmpeg stream", pathName)

		log.Printf("Successfully started processing for camera %s", req.CameraID)
		c.JSON(http.StatusOK, gin.H{
			"message":   fmt.Sprintf("Camera %s processing started", req.CameraID),
			"pathName":  pathName,
			"status":    "mediamtx_configured",
			"sessionId": pathName,
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

		// Clean up MediaMTX path
		pathName := fmt.Sprintf("camera_%s", req.CameraID)
		if err := cleanupMediaMTXPath(pathName); err != nil {
			log.Printf("Warning: Failed to cleanup MediaMTX path %s: %v", pathName, err)
			// Don't fail the entire request just because cleanup failed
		}

		log.Printf("Successfully stopped processing for camera %s", req.CameraID)
		c.JSON(http.StatusOK, gin.H{
			"message":  fmt.Sprintf("Stopped processing for camera %s", req.CameraID),
			"pathName": pathName,
		})
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
	log.Println("Attempting to restore active camera paths...")
	go func() {
		// Wait a moment for MediaMTX to be fully ready
		time.Sleep(5 * time.Second)
		restoreActivePaths()
	}()

	// Start server
	fmt.Printf("Worker service starting on port %s\n", port)
	log.Fatal(r.Run(":" + port))
}

// cleanupMediaMTXPath removes a path from MediaMTX
func cleanupMediaMTXPath(pathName string) error {
	mediamtxAPIURL := os.Getenv("MEDIAMTX_API_URL")
	if mediamtxAPIURL == "" {
		mediamtxAPIURL = "http://mediamtx:9997"
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
		mediamtxAPIURL = "http://mediamtx:9997"
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
		mediamtxAPIURL = "http://mediamtx:9997"
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
				mediamtxAPIURL = "http://mediamtx:9997"
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
		"rtsp_transport": "tcp",     // Use TCP for input to reduce packet loss
		"buffer_size":    "2000000", // 2MB buffer
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
			"muxdelay":          "0.1",         // Reduce mux delay
			"avoid_negative_ts": "make_zero",   // Fix timestamp issues
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

	// Monitor the process in a goroutine with enhanced error handling
	go func() {
		err := execCmd.Wait()
		processMutex.Lock()
		delete(activeProcesses, cameraID)
		processMutex.Unlock()

		if err != nil {
			log.Printf("FFmpeg process for camera %s ended with error: %v", cameraID, err)
			// Clean up MediaMTX path on process failure
			pathName := fmt.Sprintf("camera_%s", cameraID)
			if cleanupErr := cleanupMediaMTXPath(pathName); cleanupErr != nil {
				log.Printf("Failed to cleanup MediaMTX path after FFmpeg failure: %v", cleanupErr)
			}
			// Update database status
			updateCameraPathInfo(cameraID, pathName, false)
		} else {
			log.Printf("FFmpeg process for camera %s ended normally", cameraID)
		}
	}()

	log.Printf("Started re-encoding process for camera %s: %s -> %s", cameraID, sourceURL, targetURL)

	// Wait for the process to start up and begin streaming
	// Check multiple times with shorter intervals for faster feedback
	log.Printf("Waiting for FFmpeg process to establish connection...")
	maxChecks := 10
	checkInterval := 500 * time.Millisecond

	for i := 0; i < maxChecks; i++ {
		time.Sleep(checkInterval)

		// Check if process is still running
		if execCmd.ProcessState != nil && execCmd.ProcessState.Exited() {
			exitErr := execCmd.ProcessState.String()
			return fmt.Errorf("FFmpeg process exited immediately (%s), check RTSP source: %s", exitErr, sourceURL)
		}

		// After a few checks, consider it successful
		if i >= 5 {
			log.Printf("FFmpeg process for camera %s is running and stable", cameraID)
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
		pathName := fmt.Sprintf("camera_%s", cameraID)
		if err := cleanupMediaMTXPath(pathName); err != nil {
			log.Printf("Warning: Failed to cleanup MediaMTX path %s: %v", pathName, err)
		}

		log.Printf("Re-encoding process for camera %s stopped and cleaned up", cameraID)
	} else {
		log.Printf("No active re-encoding process found for camera %s", cameraID)
	}
}

// getReencodedStreamURL generates the URL for publishing the re-encoded stream
func getReencodedStreamURL(cameraID string) string {
	// Generate RTSP URL for publishing re-encoded stream to MediaMTX
	// This URL must match the MediaMTX path name for proper routing
	mediamtxURL := os.Getenv("MEDIAMTX_URL")
	if mediamtxURL == "" {
		mediamtxURL = "rtsp://mediamtx:8554"
	}

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
