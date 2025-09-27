import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { prisma } from '../utils/db.js';
import { authMiddleware } from '../auth/middleware.js';
import { CreateCameraRequest, UpdateCameraRequest, JWTPayload, Variables } from '../types.js';
import { createCameraSchema, updateCameraSchema, uuidParamSchema } from '../schemas.js';

const cameras = new Hono<{ Variables: Variables }>();

// Apply auth middleware to all camera routes
cameras.use('*', authMiddleware);

// GET /api/cameras - Get all cameras for the authenticated user
cameras.get('/', async (c) => {
  try {
    const user = c.get('user');

    const userCameras = await prisma.camera.findMany({
      where: { userId: user.userId },
      include: {
        _count: {
          select: { alerts: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return c.json({
      cameras: userCameras,
      total: userCameras.length
    });

  } catch (error) {
    console.error('Get cameras error:', error);
    return c.json({ error: 'Failed to fetch cameras' }, 500);
  }
});

// POST /api/cameras - Create a new camera
cameras.post('/', zValidator('json', createCameraSchema), async (c) => {
  try {
    const user = c.get('user');
    const { name, rtspUrl, location } = c.req.valid('json');

    const camera = await prisma.camera.create({
      data: {
        name,
        rtspUrl,
        location,
        userId: user.userId,
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

// PUT /api/cameras/:id - Update a camera
cameras.put('/:id', zValidator('param', uuidParamSchema), zValidator('json', updateCameraSchema), async (c) => {
  try {
    const user = c.get('user');
    const { id: cameraId } = c.req.valid('param');
    const { name, rtspUrl, location, enabled } = c.req.valid('json');

    // Check if camera exists and belongs to user
    const existingCamera = await prisma.camera.findFirst({
      where: {
        id: cameraId,
        userId: user.userId
      }
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

// DELETE /api/cameras/:id - Delete a camera
cameras.delete('/:id', zValidator('param', uuidParamSchema), async (c) => {
  try {
    const user = c.get('user');
    const { id: cameraId } = c.req.valid('param');

    // Check if camera exists and belongs to user
    const existingCamera = await prisma.camera.findFirst({
      where: {
        id: cameraId,
        userId: user.userId
      }
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

export { cameras };