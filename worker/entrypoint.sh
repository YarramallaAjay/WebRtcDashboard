#!/bin/bash
echo "Starting worker service..."
echo "Current directory: $(pwd)"
echo "Files in current directory:"
ls -la
echo "Looking for main executable:"
ls -la main
echo "Testing main executable:"
file main
echo "Starting main application..."
exec ./main