# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Architecture

This is a WebRTC Dashboard project with a multi-service architecture:

- **Frontend**: React 19 + TypeScript + Vite + TailwindCSS frontend application
- **Backend**: Node.js backend using Hono framework with Prisma ORM, JWT authentication, and bcrypt for password hashing
- **Worker**: Go service using Gin framework, with dependencies for face recognition (go-face), computer vision (gocv), and QUIC protocol support

The project appears to be designed for real-time communication and media processing, likely involving video/audio streams given the WebRTC naming and computer vision dependencies.

## Development Commands

### Frontend Development
```bash
cd frontend
npm run dev          # Start development server
npm run build        # Build for production (runs TypeScript compiler + Vite build)
npm run lint         # Run ESLint
npm run preview      # Preview production build
```

### Backend Development
The backend currently has minimal scripts defined - only a placeholder test command that exits with error.

### Root Level Dependencies
The root package.json includes shared dependencies:
- Material-UI (@mui/material, @emotion/react, @emotion/styled)
- Axios for HTTP requests
- Socket.io client for real-time communication

## Technology Stack

### Frontend
- React 19 with TypeScript
- Vite for build tooling and development server
- TailwindCSS for styling
- ESLint for code quality

### Backend
- Hono web framework
- Prisma ORM with PostgreSQL/database integration
- JWT for authentication
- bcrypt for password hashing
- TypeScript with tsx for execution and nodemon for development

### Worker (Go Service)
- Gin web framework
- Computer vision capabilities (gocv)
- Face recognition (go-face)
- QUIC protocol support
- Go 1.25.1

## Project Structure

```
├── frontend/          # React frontend application
│   └── src/
├── backend/           # Node.js API server
├── worker/            # Go worker service
├── docker-compose.yml # Container orchestration (empty)
└── .env.example       # Environment variables template (empty)
```

## Development Notes

- The project uses a monorepo structure with separate package.json files for frontend and backend
- Frontend uses Vite for fast development and building
- Backend uses Hono (modern, lightweight web framework) instead of Express
- The Go worker service suggests this application processes video/media streams
- Authentication is implemented in the backend using JWT tokens
- Database operations use Prisma ORM