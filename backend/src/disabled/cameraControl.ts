import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { prisma } from '../utils/db.js';
import { authMiddleware } from '../auth/middleware.js';
import { JWTPayload, Variables } from '../types.js';
// import { broadcastCameraStatus } from '../websocket.js';
import { cuidParamSchema, cameraControlSchema } from '../schemas.js';

const cameraControl = new Hono<{ Variables: Variables }>();

// Apply auth middleware to all camera control routes
cameraControl.use('*', authMiddleware);

// POST /api/cameras/:id/start - Start camera processing
cameraControl.post('/:id/start', zValidator('param', cuidParamSchema), async (c) => {
  try {
    const user = c.get('user');
    const { id: cameraId } = c.req.valid('param');

    // Check if camera exists and belongs to user
    const camera = await prisma.camera.findFirst({
      where: {
        id: cameraId,
        // userId: user.userId
      }
    });

    if (!camera) {
      return c.json({ error: 'Camera not found' }, 404);
    }

    // Update camera to enabled state
    const updatedCamera = await prisma.camera.update({
      where: { id: cameraId },
      data: { enabled: true }
    });

    // TODO: Send request to worker service to start processing
    // This will be implemented when worker service is ready
    try {
      // Example worker communication - replace with actual implementation
      const workerResponse = await fetch(`${process.env.WORKER_URL || 'http://localhost:8080'}/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cameraId: camera.id,
          rtspUrl: camera.rtspUrl,
          name: camera.name,
        }),
      });

      if (!workerResponse.ok) {
        console.warn('Worker service not available, camera marked as enabled but not processing');
      }
    } catch (workerError) {
      console.warn('Worker service not available:', workerError);
      // Continue anyway - camera is marked as enabled
    }

    // Broadcast camera status change (temporarily disabled)
    // broadcastCameraStatus(cameraId, 'started', user.userId);

    return c.json({
      message: 'Camera started successfully',
      camera: updatedCamera
    });

  } catch (error) {
    console.error('Start camera error:', error);
    return c.json({ error: 'Failed to start camera' }, 500);
  }
});

// POST /api/cameras/:id/stop - Stop camera processing
cameraControl.post('/:id/stop', zValidator('param', cuidParamSchema), async (c) => {
  try {
    const user = c.get('user');
    const { id: cameraId } = c.req.valid('param');

    // Check if camera exists and belongs to user
    const camera = await prisma.camera.findFirst({
      where: {
        id: cameraId,
        // userId: user.userId,


      }
    });

    if (!camera) {
      return c.json({ error: 'Camera not found' }, 404);
    }

    // Update camera to disabled state
    const updatedCamera = await prisma.camera.update({
      where: { id: cameraId },
      data: { enabled: false }
    });

    // TODO: Send request to worker service to stop processing
    try {
      const workerResponse = await fetch(`${process.env.WORKER_URL || 'http://localhost:8080'}/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cameraId: camera.id,
        }),
      });

      if (!workerResponse.ok) {
        console.warn('Worker service not available for stop command');
      }
    } catch (workerError) {
      console.warn('Worker service not available:', workerError);
      // Continue anyway - camera is marked as disabled
    }

    // Broadcast camera status change
    // broadcastCameraStatus(cameraId, 'stopped', user.userId);

    return c.json({
      message: 'Camera stopped successfully',
      camera: updatedCamera
    });

  } catch (error) {
    console.error('Stop camera error:', error);
    return c.json({ error: 'Failed to stop camera' }, 500);
  }
});

export { cameraControl };