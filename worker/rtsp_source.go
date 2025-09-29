package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/bluenviron/gortsplib/v4"
	"github.com/bluenviron/gortsplib/v4/pkg/base"
	"github.com/bluenviron/gortsplib/v4/pkg/description"
	"github.com/bluenviron/gortsplib/v4/pkg/format"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// Frame represents a processed video frame
type Frame struct {
	Data       []byte
	Timestamp  time.Time
	Duration   time.Duration
	IsKeyFrame bool
}

// RTSPStreamManager manages RTSP connections and frame distribution
type RTSPStreamManager struct {
	url           string
	client        *gortsplib.Client
	frameChannels map[string]chan *Frame
	mu            sync.RWMutex
	ctx           context.Context
	cancel        context.CancelFunc
	isRunning     bool
	frameCount    uint64
	spsData       []byte // Store SPS parameter set
	ppsData       []byte // Store PPS parameter set
}

// NewRTSPStreamManager creates a new RTSP stream manager
func NewRTSPStreamManager(url string) *RTSPStreamManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &RTSPStreamManager{
		url:           url,
		frameChannels: make(map[string]chan *Frame),
		ctx:           ctx,
		cancel:        cancel,
	}
}

// Subscribe creates a new channel for receiving frames
func (rsm *RTSPStreamManager) Subscribe(subscriberID string) <-chan *Frame {
	rsm.mu.Lock()
	defer rsm.mu.Unlock()

	frameChan := make(chan *Frame, 100) // Buffer for 100 frames
	rsm.frameChannels[subscriberID] = frameChan

	// Send cached SPS/PPS to new subscriber if available
	go func() {
		if len(rsm.spsData) > 0 {
			spsFrame := &Frame{
				Data:       make([]byte, len(rsm.spsData)),
				Timestamp:  time.Now(),
				Duration:   0,
				IsKeyFrame: true,
			}
			copy(spsFrame.Data, rsm.spsData)

			select {
			case frameChan <- spsFrame:
				log.Printf("Sent cached SPS to subscriber %s", subscriberID)
			case <-time.After(100 * time.Millisecond):
				log.Printf("Failed to send cached SPS to subscriber %s", subscriberID)
			}
		}

		if len(rsm.ppsData) > 0 {
			ppsFrame := &Frame{
				Data:       make([]byte, len(rsm.ppsData)),
				Timestamp:  time.Now(),
				Duration:   0,
				IsKeyFrame: true,
			}
			copy(ppsFrame.Data, rsm.ppsData)

			select {
			case frameChan <- ppsFrame:
				log.Printf("Sent cached PPS to subscriber %s", subscriberID)
			case <-time.After(100 * time.Millisecond):
				log.Printf("Failed to send cached PPS to subscriber %s", subscriberID)
			}
		}
	}()

	log.Printf("Subscriber %s added to RTSP stream %s", subscriberID, rsm.url)
	return frameChan
}

// Unsubscribe removes a frame channel
func (rsm *RTSPStreamManager) Unsubscribe(subscriberID string) {
	rsm.mu.Lock()
	defer rsm.mu.Unlock()

	if frameChan, exists := rsm.frameChannels[subscriberID]; exists {
		close(frameChan)
		delete(rsm.frameChannels, subscriberID)
		log.Printf("Subscriber %s removed from RTSP stream %s", subscriberID, rsm.url)
	}
}

// Start begins RTSP stream processing
func (rsm *RTSPStreamManager) Start() error {
	if rsm.isRunning {
		return fmt.Errorf("stream manager already running")
	}

	log.Printf("Starting RTSP connection to: %s", rsm.url)

	// Create client with configuration
	transport := gortsplib.TransportTCP
	rsm.client = &gortsplib.Client{
		Transport: &transport, // Use TCP transport for better reliability
	}

	// Parse URL
	parsedURL, err := base.ParseURL(rsm.url)
	if err != nil {
		return fmt.Errorf("failed to parse RTSP URL: %w", err)
	}

	log.Printf("Connecting to RTSP server: %s", parsedURL.Host)

	// Connect to RTSP server
	err = rsm.client.Start(parsedURL.Scheme, parsedURL.Host)
	if err != nil {
		return fmt.Errorf("failed to connect to RTSP server: %w", err)
	}

	log.Printf("Connected to server, performing DESCRIBE")

	// Perform DESCRIBE request to get stream info
	desc, _, err := rsm.client.Describe(parsedURL)
	if err != nil {
		rsm.client.Close()
		return fmt.Errorf("DESCRIBE request failed: %w", err)
	}

	log.Printf("DESCRIBE successful, found %d media tracks", len(desc.Medias))

	// Find H.264 video track
	var videoMedia *description.Media
	var videoFormat *format.H264
	for i, media := range desc.Medias {
		log.Printf("Media %d: %s", i, media.Type)
		for j, formatCandidate := range media.Formats {
			log.Printf("  Format %d: %T", j, formatCandidate)
			if h264Format, ok := formatCandidate.(*format.H264); ok {
				videoMedia = media
				videoFormat = h264Format
				log.Printf("Found H.264 video track in media %d", i)
				break
			}
		}
		if videoFormat != nil {
			break
		}
	}

	if videoFormat == nil {
		rsm.client.Close()
		return fmt.Errorf("H.264 track not found in stream")
	}

	log.Printf("Setting up video track")

	// Setup video track
	_, err = rsm.client.Setup(desc.BaseURL, videoMedia, 0, 0)
	if err != nil {
		rsm.client.Close()
		return fmt.Errorf("video track setup failed: %w", err)
	}

	log.Printf("Video track setup successful, starting packet reception")

	// Start receiving packets
	rsm.client.OnPacketRTP(videoMedia, videoFormat, func(pkt *rtp.Packet) {
		rsm.distributeFrame(pkt)
	})

	log.Printf("Starting playback")

	// Start playing
	_, err = rsm.client.Play(nil)
	if err != nil {
		rsm.client.Close()
		return fmt.Errorf("PLAY request failed: %w", err)
	}

	rsm.isRunning = true
	log.Printf("RTSP stream started successfully: %s", rsm.url)

	// Start monitoring goroutine
	go rsm.monitor()

	return nil
}

// distributeFrame sends frames to all subscribers
func (rsm *RTSPStreamManager) distributeFrame(pkt *rtp.Packet) {
	// Improved H.264 NAL unit type detection
	isKeyFrame := false
	if len(pkt.Payload) > 0 {
		nalType := pkt.Payload[0] & 0x1F

		// Handle different H.264 NAL unit types
		switch nalType {
		case 1: // Non-IDR coded slice
			isKeyFrame = false
		case 5: // IDR coded slice (keyframe)
			isKeyFrame = true
		case 7: // SPS (Sequence Parameter Set)
			isKeyFrame = true
			// Store SPS data for new subscribers
			rsm.spsData = make([]byte, len(pkt.Payload))
			copy(rsm.spsData, pkt.Payload)
		case 8: // PPS (Picture Parameter Set)
			isKeyFrame = true
			// Store PPS data for new subscribers
			rsm.ppsData = make([]byte, len(pkt.Payload))
			copy(rsm.ppsData, pkt.Payload)
		case 24: // STAP-A (Single Time Aggregation Packet)
			// Check first NAL unit in aggregation
			if len(pkt.Payload) > 3 {
				firstNalType := pkt.Payload[3] & 0x1F
				isKeyFrame = firstNalType == 5 || firstNalType == 7 || firstNalType == 8
			}
		case 28: // FU-A (Fragmentation Unit)
			// Check if this is start of an IDR frame
			if len(pkt.Payload) > 1 {
				fuHeader := pkt.Payload[1]
				isStart := (fuHeader & 0x80) != 0
				if isStart {
					fragmentedNalType := fuHeader & 0x1F
					isKeyFrame = fragmentedNalType == 5 || fragmentedNalType == 7 || fragmentedNalType == 8
				}
			}
		default:
			isKeyFrame = false
		}
	}

	// Log keyframes and occasionally log regular frames
	if isKeyFrame {
		log.Printf("KEYFRAME %d: Size=%d bytes, NAL=%d, Marker=%v, Timestamp=%d",
			rsm.frameCount, len(pkt.Payload), pkt.Payload[0]&0x1F, pkt.Marker, pkt.Timestamp)
	} else if rsm.frameCount%500 == 0 {
		log.Printf("Frame %d: Size=%d bytes, Marker=%v, KeyFrame=%v, Timestamp=%d",
			rsm.frameCount, len(pkt.Payload), pkt.Marker, isKeyFrame, pkt.Timestamp)
	}
	rsm.frameCount++

	frame := &Frame{
		Data:       make([]byte, len(pkt.Payload)), // Copy payload to avoid races
		Timestamp:  time.Now(),
		Duration:   33 * time.Millisecond, // Assume 30 FPS
		IsKeyFrame: isKeyFrame,
	}
	copy(frame.Data, pkt.Payload)

	rsm.mu.RLock()
	subscriberCount := len(rsm.frameChannels)
	rsm.mu.RUnlock()

	if subscriberCount == 0 {
		return // No subscribers, skip processing
	}

	rsm.mu.RLock()
	defer rsm.mu.RUnlock()

	// Distribute to all subscribers concurrently
	for subscriberID, frameChan := range rsm.frameChannels {
		go func(id string, ch chan *Frame, f *Frame) {
			select {
			case ch <- f:
				// Frame sent successfully
			case <-time.After(5 * time.Millisecond):
				// Drop frame if channel is full to prevent blocking
				log.Printf("Dropped frame for subscriber %s (channel full)", id)
			}
		}(subscriberID, frameChan, frame)
	}
}

// monitor keeps the connection alive and handles errors
func (rsm *RTSPStreamManager) monitor() {
	log.Printf("Starting RTSP monitor for %s", rsm.url)
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-rsm.ctx.Done():
			log.Printf("RTSP monitor stopped for %s", rsm.url)
			return
		case <-ticker.C:
			// Check if client is still running
			if rsm.client != nil {
				// Wait for client errors
				go func() {
					err := rsm.client.Wait()
					if err != nil {
						log.Printf("RTSP client error for %s: %v", rsm.url, err)
						// Mark as not running so it can be restarted
						rsm.isRunning = false
					}
				}()
			}
		}
	}
}

// Stop stops the RTSP stream processing
func (rsm *RTSPStreamManager) Stop() error {
	if !rsm.isRunning {
		return nil
	}

	rsm.cancel()

	if rsm.client != nil {
		rsm.client.Close()
	}

	// Close all frame channels
	rsm.mu.Lock()
	for subscriberID, frameChan := range rsm.frameChannels {
		close(frameChan)
		delete(rsm.frameChannels, subscriberID)
		log.Printf("Closed frame channel for subscriber %s", subscriberID)
	}
	rsm.mu.Unlock()

	rsm.isRunning = false
	log.Printf("RTSP stream stopped: %s", rsm.url)
	return nil
}

// GetSubscriberCount returns the number of active subscribers
func (rsm *RTSPStreamManager) GetSubscriberCount() int {
	rsm.mu.RLock()
	defer rsm.mu.RUnlock()
	return len(rsm.frameChannels)
}

// WebRTCStreamer handles streaming frames to WebRTC peers
type WebRTCStreamer struct {
	track       *webrtc.TrackLocalStaticRTP
	framesChan  <-chan *Frame
	ctx         context.Context
	cancel      context.CancelFunc
	isStreaming bool
	mu          sync.Mutex
}

// NewWebRTCStreamer creates a new WebRTC streamer
func NewWebRTCStreamer(track *webrtc.TrackLocalStaticRTP, framesChan <-chan *Frame) *WebRTCStreamer {
	ctx, cancel := context.WithCancel(context.Background())
	return &WebRTCStreamer{
		track:      track,
		framesChan: framesChan,
		ctx:        ctx,
		cancel:     cancel,
	}
}

// Start begins streaming frames to WebRTC
func (ws *WebRTCStreamer) Start() {
	ws.mu.Lock()
	if ws.isStreaming {
		ws.mu.Unlock()
		return
	}
	ws.isStreaming = true
	ws.mu.Unlock()

	go ws.streamLoop()
}

// streamLoop processes frames and sends them via WebRTC
func (ws *WebRTCStreamer) streamLoop() {
	log.Printf("Starting WebRTC streaming loop")

	var sequenceNumber uint16
	var rtpTimestamp uint32
	startTime := time.Now()

	for {
		select {
		case <-ws.ctx.Done():
			log.Printf("WebRTC streaming stopped")
			return
		case frame, ok := <-ws.framesChan:
			if !ok {
				log.Printf("Frame channel closed, stopping WebRTC stream")
				return
			}

			// Calculate RTP timestamp (90kHz clock for H.264)
			elapsed := time.Since(startTime)
			rtpTimestamp = uint32(elapsed.Nanoseconds() / 1000 * 90 / 1000000) // Convert to 90kHz

			// Create RTP packet from frame data (already in RTP format from RTSP)
			packet := &rtp.Packet{
				Header: rtp.Header{
					Version:        2,
					Padding:        false,
					Extension:      false,
					Marker:         frame.IsKeyFrame || (len(frame.Data) > 0 && (frame.Data[0]&0x80) != 0), // Use original marker or keyframe
					PayloadType:    96,            // H.264
					SequenceNumber: sequenceNumber,
					Timestamp:      rtpTimestamp,
					SSRC:           uint32(12345), // Static SSRC
				},
				Payload: frame.Data,
			}

			sequenceNumber++

			// Send packet via WebRTC track
			if err := ws.track.WriteRTP(packet); err != nil {
				if err.Error() != "connection closed" {
					log.Printf("Failed to write RTP packet: %v", err)
				}
				return
			}
		}
	}
}

// Stop stops the WebRTC streaming
func (ws *WebRTCStreamer) Stop() {
	ws.mu.Lock()
	defer ws.mu.Unlock()

	if ws.isStreaming {
		ws.cancel()
		ws.isStreaming = false
	}
}

// Global stream managers pool
var (
	streamManagers = make(map[string]*RTSPStreamManager)
	streamMutex    sync.RWMutex
)

// GetOrCreateStreamManager gets or creates an RTSP stream manager for a URL
func GetOrCreateStreamManager(url string) *RTSPStreamManager {
	streamMutex.Lock()
	defer streamMutex.Unlock()

	if manager, exists := streamManagers[url]; exists {
		return manager
	}

	manager := NewRTSPStreamManager(url)
	streamManagers[url] = manager

	// Start the stream with retry logic
	go func() {
		maxRetries := 3
		retryDelay := 5 * time.Second

		for attempt := 1; attempt <= maxRetries; attempt++ {
			log.Printf("Starting RTSP stream %s (attempt %d/%d)", url, attempt, maxRetries)

			if err := manager.Start(); err != nil {
				log.Printf("Failed to start RTSP stream %s on attempt %d: %v", url, attempt, err)

				if attempt < maxRetries {
					log.Printf("Retrying in %v...", retryDelay)
					time.Sleep(retryDelay)
					retryDelay *= 2 // Exponential backoff
				} else {
					log.Printf("All attempts failed for RTSP stream %s, removing manager", url)
					streamMutex.Lock()
					delete(streamManagers, url)
					streamMutex.Unlock()
				}
			} else {
				log.Printf("Successfully started RTSP stream %s on attempt %d", url, attempt)
				break
			}
		}
	}()

	return manager
}

// CleanupStreamManager removes a stream manager if no subscribers
func CleanupStreamManager(url string) {
	streamMutex.Lock()
	defer streamMutex.Unlock()

	if manager, exists := streamManagers[url]; exists {
		if manager.GetSubscriberCount() == 0 {
			manager.Stop()
			delete(streamManagers, url)
			log.Printf("Cleaned up stream manager for %s", url)
		}
	}
}
