import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { prisma } from '../utils/db.js';
import { Variables } from '../types.js';
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

    // Step 1: Create camera in database
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

    // Step 2: Register camera with worker to configure MediaMTX path
    try {
      console.log(`Registering camera ${camera.id} with worker service`);

      const workerResponse = await fetch(`${process.env.WORKER_URL || 'http://worker:8080'}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameraId: camera.id,
          name: camera.name,
        }),
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (workerResponse.ok) {
        const workerData: any = await workerResponse.json();
        console.log(`Camera ${camera.id} registered successfully with path: ${workerData.pathName}`);

        // Step 3: Update camera with MediaMTX path info from worker
        const updatedCamera = await prisma.camera.update({
          where: { id: camera.id },
          data: {
            mediamtxPath: workerData.pathName,
            mediamtxConfigured: true,
          },
          include: {
            _count: {
              select: { alerts: true }
            }
          }
        });

        return c.json({
          message: 'Camera created and registered successfully',
          camera: updatedCamera,
          mediamtxPath: workerData.pathName
        }, 201);
      } else {
        const errorText = await workerResponse.text();
        console.warn(`Failed to register camera ${camera.id} with worker: ${errorText}`);
        // Camera created but not registered - can register later when starting
        return c.json({
          message: 'Camera created but registration pending',
          camera,
          warning: 'MediaMTX path will be configured when camera is started'
        }, 201);
      }
    } catch (workerError) {
      console.warn(`Worker registration error for camera ${camera.id}:`, workerError);
      // Camera created but not registered - can register later when starting
      return c.json({
        message: 'Camera created but registration pending',
        camera,
        warning: 'MediaMTX path will be configured when camera is started'
      }, 201);
    }

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

    // Check if camera is already registered with MediaMTX path
    if (!camera.mediamtxConfigured || !camera.mediamtxPath) {
      console.log(`Camera ${camera.id} not registered, registering now...`);

      // Register camera with worker first
      try {
        const registerResponse = await fetch(`${process.env.WORKER_URL || 'http://worker:8080'}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cameraId: camera.id,
            name: camera.name,
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (registerResponse.ok) {
          const registerData: any = await registerResponse.json();
          await prisma.camera.update({
            where: { id: cameraId },
            data: {
              mediamtxPath: registerData.pathName,
              mediamtxConfigured: true,
            }
          });
          console.log(`Camera ${camera.id} registered with path ${registerData.pathName}`);
        } else {
          console.warn(`Failed to register camera ${camera.id}, proceeding anyway`);
        }
      } catch (registerError) {
        console.warn(`Registration error for camera ${camera.id}:`, registerError);
        // Continue anyway - worker might auto-configure
      }
    }

    // Set camera to CONNECTING status
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
        signal: AbortSignal.timeout(60000), // Increased to 60 second timeout
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

// GET /api/cameras/streams - Get all cameras with MediaMTX streaming links
cameras.get('/streams/active', async (c) => {
  try {
    // Get active cameras from database
    const activeCameras = await prisma.camera.findMany({
      where: {
        enabled: true,
        status: 'PROCESSING'
      },
      select: {
        id: true,
        name: true,
        location: true,
        status: true,
        enabled: true,
        mediamtxPath: true,
        lastProcessedAt: true
      }
    });

    // Get stream info from worker
    let workerStreams = [];
    try {
      const workerResponse = await fetch(`${process.env.WORKER_URL || 'http://worker:8080'}/streams`, {
        signal: AbortSignal.timeout(5000)
      });

      if (workerResponse.ok) {
        const workerData:any = await workerResponse.json();
        workerStreams = workerData.streams || [];
      }
    } catch (workerError) {
      console.warn('Failed to get worker streams:', workerError);
    }

    // Combine database and worker info
    const streamsWithLinks = activeCameras.map(camera => {
      const workerStream = workerStreams.find((s: any) => s.cameraId === camera.id);
      const mediamtxWebRTCURL = process.env.VITE_MEDIAMTX_URL || 'http://localhost:8891';
      const pathName = camera.mediamtxPath || `camera_${camera.id}`;

      console.log('Camera data:', { id: camera.id, enabled: camera.enabled, status: camera.status });

      return {
        id: camera.id,
        name: camera.name,
        location: camera.location,
        status: camera.status,
        enabled: camera.enabled,
        pathName,
        webrtcUrl: `${mediamtxWebRTCURL}/${pathName}`,
        uptime: workerStream?.uptime || null,
        framesProcessed: workerStream?.framesProcessed || 0,
        lastProcessedAt: camera.lastProcessedAt
      };
    });

    return c.json({
      streams: streamsWithLinks,
      total: streamsWithLinks.length
    });

  } catch (error) {
    console.error('Get camera streams error:', error);
    return c.json({ error: 'Failed to get camera streams' }, 500);
  }
});

// POST /api/cameras/start-batch - Start multiple cameras
cameras.post('/start-batch', async (c) => {
  try {
    const body = await c.req.json();
    const cameraIds = body.cameraIds as string[];

    if (!Array.isArray(cameraIds) || cameraIds.length === 0) {
      return c.json({ error: 'cameraIds array is required' }, 400);
    }

    // Get cameras from database
    const cameras = await prisma.camera.findMany({
      where: {
        id: { in: cameraIds }
      }
    });

    if (cameras.length === 0) {
      return c.json({ error: 'No cameras found' }, 404);
    }

    // Update all cameras to CONNECTING
    await prisma.camera.updateMany({
      where: {
        id: { in: cameras.map(c => c.id) }
      },
      data: {
        status: 'CONNECTING'
      }
    });

    // Prepare batch request for worker
    const batchRequest = {
      cameras: cameras.map(camera => ({
        cameraId: camera.id,
        rtspUrl: camera.rtspUrl,
        name: camera.name
      }))
    };

    // Send batch request to worker
    try {
      const workerResponse = await fetch(`${process.env.WORKER_URL || 'http://worker:8080'}/process-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchRequest),
        signal: AbortSignal.timeout(60000) // 60 second timeout for batch
      });

      const workerData:any = await workerResponse.json();

      if (!workerResponse.ok) {
        // Update failed cameras
        await prisma.camera.updateMany({
          where: { id: { in: cameraIds } },
          data: { status: 'ERROR', enabled: false }
        });

        return c.json({
          error: 'Worker batch processing failed',
          details: workerData
        }, 500);
      }

      // Update cameras based on batch results
      const results = workerData.results || [];
      for (const result of results) {
        if (result.success) {
          await prisma.camera.update({
            where: { id: result.cameraId },
            data: {
              enabled: true,
              status: 'PROCESSING'
            }
          });
        } else {
          await prisma.camera.update({
            where: { id: result.cameraId },
            data: {
              enabled: false,
              status: 'ERROR'
            }
          });
        }
      }

      return c.json({
        message: `Batch start completed: ${workerData.successful}/${workerData.total} successful`,
        successful: workerData.successful,
        failed: workerData.failed,
        results: workerData.results
      });

    } catch (workerError) {
      console.error('Worker batch error:', workerError);
      // Update all cameras to ERROR
      await prisma.camera.updateMany({
        where: { id: { in: cameraIds } },
        data: { status: 'ERROR', enabled: false }
      });

      return c.json({
        error: 'Worker service error',
        details: workerError instanceof Error ? workerError.message : 'Unknown error'
      }, 500);
    }

  } catch (error) {
    console.error('Batch start error:', error);
    return c.json({ error: 'Failed to start cameras in batch' }, 500);
  }
});

export { cameras };