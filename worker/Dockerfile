FROM golang:1.24-bookworm

# Set environment variables
ENV CGO_ENABLED=1
ENV GOOS=linux

# Install dependencies for FFmpeg and OpenCV (gocv)
RUN apt-get update && apt-get install -y \
    pkg-config \
    ffmpeg \
    libopencv-dev \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /

# Download Haar Cascade model for face detection
RUN mkdir -p /models && \
    wget -O /models/haarcascade_frontalface_default.xml \
    https://raw.githubusercontent.com/opencv/opencv/master/data/haarcascades/haarcascade_frontalface_default.xml

# Copy go mod files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the application
RUN go build -v -o main .

# Expose port
EXPOSE 8080

# Start the application
CMD ["./main"]