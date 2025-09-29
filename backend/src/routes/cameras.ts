import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { prisma } from '../utils/db.js';
import { authMiddleware } from '../auth/middleware.js';
import { CreateCameraRequest, UpdateCameraRequest, JWTPayload, Variables } from '../types.js';
import { createCameraSchema, updateCameraSchema,  cuidParamSchema } from '../schemas.js';

const cameras = new Hono<{ Variables: Variables }>();

// Auth middleware temporarily disabled for testing
// cameras.use('*', authMiddleware);

// GET /api/cameras - Get all cameras (no auth for testing)
cameras.get('/', async (c) => {
  try {
    const allCameras = await prisma.camera.findMany({
      include: {
        _count: {
          select: { alerts: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return c.json({
      cameras: allCameras,
      total: allCameras.length
    });

  } catch (error) {
    console.error('Get cameras error:', error);
    return c.json({ error: 'Failed to fetch cameras' }, 500);
  }
});

// POST /api/cameras - Create a new camera (no auth for testing)
cameras.post('/', zValidator('json', createCameraSchema), async (c) => {
  try {
    const { name, rtspUrl, location } = c.req.valid('json');

    const camera = await prisma.camera.create({

      data: {
        name,
        rtspUrl,
        location,
      },
      include: {
        _count: {
          select: { alerts: true }
        }
      }
    });

    return c.json({
      message: 'Camera created successfully',
      camera
    }, 201);

  } catch (error) {
    console.error('Create camera error:', error);
    return c.json({ error: 'Failed to create camera' }, 500);
  }
});

// PUT /api/cameras/:id - Update a camera (no auth for testing)
cameras.put('/:id', zValidator('param', cuidParamSchema), zValidator('json', updateCameraSchema), async (c) => {
  try {
    const { id: cameraId } = c.req.valid('param');
    const { name, rtspUrl, location, enabled } = c.req.valid('json');

    // Check if camera exists
    const existingCamera = await prisma.camera.findUnique({
      where: { id: cameraId }
    });

    if (!existingCamera) {
      return c.json({ error: 'Camera not found' }, 404);
    }

    const camera = await prisma.camera.update({
      where: { id: cameraId },
      data: {
        ...(name && { name }),
        ...(rtspUrl && { rtspUrl }),
        ...(location !== undefined && { location }),
        ...(enabled !== undefined && { enabled }),
      },
      include: {
        _count: {
          select: { alerts: true }
        }
      }
    });

    return c.json({
      message: 'Camera updated successfully',
      camera
    });

  } catch (error) {
    console.error('Update camera error:', error);
    return c.json({ error: 'Failed to update camera' }, 500);
  }
});

// DELETE /api/cameras/:id - Delete a camera (no auth for testing)
cameras.delete('/:id', zValidator('param', cuidParamSchema), async (c) => {
  try {
    const { id: cameraId } = c.req.valid('param');

    // Check if camera exists
    const existingCamera = await prisma.camera.findUnique({
      where: { id: cameraId }
    });

    if (!existingCamera) {
      return c.json({ error: 'Camera not found' }, 404);
    }

    // Delete all associated alerts first, then camera
    await prisma.alert.deleteMany({
      where: { cameraId }
    });

    await prisma.camera.delete({
      where: { id: cameraId }
    });

    return c.json({
      message: 'Camera deleted successfully'
    });

  } catch (error) {
    console.error('Delete camera error:', error);
    return c.json({ error: 'Failed to delete camera' }, 500);
  }
});

// POST /api/cameras/:id/start - Start camera streaming
cameras.post('/:id/start', zValidator('param', cuidParamSchema), async (c) => {
  try {
    const { id: cameraId } = c.req.valid('param');

    // Check if camera exists
    const camera = await prisma.camera.findUnique({
      where: { id: cameraId }
    });

    if (!camera) {
      return c.json({ error: 'Camera not found' }, 404);
    }

    // First set camera to CONNECTING status
    await prisma.camera.update({
      where: { id: cameraId },
      data: {
        status: 'CONNECTING'
      }
    });

    // Notify Go worker to start processing with improved error handling
    try {
      console.log(`Requesting worker to start processing camera ${camera.id}`);

      const workerResponse = await fetch(`${process.env.WORKER_URL || 'http://worker:8080'}/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: camera.id,
          rtspUrl: camera.rtspUrl,
          name: camera.name,
        }),
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });

      const responseText = await workerResponse.text();

      if (!workerResponse.ok) {
        console.error(`Worker service failed for camera ${camera.id}:`, responseText);
        // Update camera status to reflect worker failure
        await prisma.camera.update({
          where: { id: cameraId },
          data: {
            status: 'ERROR',
            enabled: false
          }
        });

        return c.json({
          error: `Worker service failed: ${responseText}`,
          camera: null
        }, 500);
      } else {
        // Parse worker response
        let workerData;
        try {
          workerData = JSON.parse(responseText);
        } catch (parseError) {
          console.error('Failed to parse worker response:', parseError);
          workerData = { message: responseText };
        }

        console.log(`Worker successfully started processing camera ${camera.id}:`, workerData.message);

        // Worker successfully started processing - enable camera and set status
        const finalCamera = await prisma.camera.update({
          where: { id: cameraId },
          data: {
            enabled: true,
            status: 'PROCESSING'
          },
          include: {
            _count: {
              select: { alerts: true }
            }
          }
        });

        return c.json({
          message: 'Camera started successfully',
          camera: finalCamera,
          workerInfo: {
            pathName: workerData.pathName,
            sessionId: workerData.sessionId
          }
        });
      }
    } catch (workerError) {
      console.error(`Worker service error for camera ${camera.id}:`, workerError);
      // Update camera status to reflect error
      await prisma.camera.update({
        where: { id: cameraId },
        data: {
          status: 'ERROR',
          enabled: false
        }
      });

      const errorMessage = workerError instanceof Error ? workerError.message : 'Unknown worker error';
      return c.json({
        error: `Worker service error: ${errorMessage}`,
        camera: null
      }, 500);
    }

  } catch (error) {
    console.error('Start camera error:', error);
    return c.json({ error: 'Failed to start camera' }, 500);
  }
});

// POST /api/cameras/:id/stop - Stop camera streaming
cameras.post('/:id/stop', zValidator('param', cuidParamSchema), async (c) => {
  try {
    const { id: cameraId } = c.req.valid('param');

    // Check if camera exists
    const camera = await prisma.camera.findUnique({
      where: { id: cameraId }
    });

    if (!camera) {
      return c.json({ error: 'Camera not found' }, 404);
    }

    // Update camera status
    const updatedCamera = await prisma.camera.update({
      where: { id: cameraId },
      data: {
        enabled: false,
        status: 'OFFLINE'
      }
    });

    // Notify Go worker to stop processing with improved error handling
    try {
      console.log(`Requesting worker to stop processing camera ${camera.id}`);

      const workerResponse = await fetch(`${process.env.WORKER_URL || 'http://worker:8080'}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cameraId: camera.id }),
        signal: AbortSignal.timeout(15000), // 15 second timeout
      });

      const responseText = await workerResponse.text();

      if (!workerResponse.ok) {
        console.warn(`Worker service failed to stop camera ${camera.id}:`, responseText);
        // Don't fail the entire request, but log the warning
      } else {
        console.log(`Worker successfully stopped processing camera ${camera.id}`);
      }
    } catch (workerError) {
      console.warn(`Worker service error stopping camera ${camera.id}:`, workerError);
      // Don't fail the entire request, continue with database update
    }

    return c.json({
      message: 'Camera stopped successfully',
      camera: updatedCamera
    });

  } catch (error) {
    console.error('Stop camera error:', error);
    return c.json({ error: 'Failed to stop camera' }, 500);
  }
});

// GET /api/cameras/:id/status - Get camera status
cameras.get('/:id/status', zValidator('param', cuidParamSchema), async (c) => {
  try {
    const { id: cameraId } = c.req.valid('param');

    const camera = await prisma.camera.findUnique({
      where: { id: cameraId },
      select: {
        id: true,
        name: true,
        status: true,
        enabled: true,
        _count: {
          select: { alerts: true }
        }
      }
    });

    if (!camera) {
      return c.json({ error: 'Camera not found' }, 404);
    }

    return c.json({ camera });

  } catch (error) {
    console.error('Get camera status error:', error);
    return c.json({ error: 'Failed to get camera status' }, 500);
  }
});

export { cameras };