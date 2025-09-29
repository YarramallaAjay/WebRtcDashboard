# Use official golang image with Ubuntu base
FROM golang:latest

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV CGO_ENABLED=1
ENV GOOS=linux

# Install minimal dependencies for FFmpeg and go-face
RUN apt-get update && apt-get install -y \
    pkg-config \
    ffmpeg \
    libblas-dev \
    liblapack-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Remove existing binaries to avoid conflicts
RUN rm -f main worker WebRtcDashBoard

RUN go mod tidy
# Build the application
RUN echo "Building Go application..." && go build -v -o main . && echo "Build completed" && ls -la main

# Expose port
EXPOSE 8080

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Start the application
WORKDIR /app
CMD ["/app/entrypoint.sh"]