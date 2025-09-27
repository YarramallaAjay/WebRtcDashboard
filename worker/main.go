package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
)

func main() {
	// Get port from environment or default to 8080
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Create Gin router
	r := gin.Default()

	// Health check endpoint
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "healthy",
			"service": "skylark-worker",
		})
	})

	// Placeholder for camera processing endpoints
	r.POST("/process", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"message": "Camera processing endpoint - coming soon",
		})
	})

	r.POST("/stop", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"message": "Stop processing endpoint - coming soon",
		})
	})

	// Start server
	fmt.Printf("Worker service starting on port %s\n", port)
	log.Fatal(r.Run(":" + port))
}