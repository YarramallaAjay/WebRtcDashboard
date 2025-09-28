import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { prisma } from '../utils/db.js';
// import { authMiddleware } from '../auth/middleware.js'; // Disabled for Phase 1
import { JWTPayload, Variables } from '../types.js';
// import { broadcastAlert } from '../websocket.js';
import { alertQuerySchema, createAlertSchema, cuidParamSchema } from '../schemas.js';

const alerts = new Hono<{ Variables: Variables }>();

// GET /api/alerts - Get alerts (no auth for testing)
alerts.get('/', async (c) => {
  try {
    const cameraId = c.req.query('cameraId');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    let whereClause: any = {};

    if (cameraId) {
      whereClause.cameraId = cameraId;
    }

    const alertsList = await prisma.alert.findMany({
      where: whereClause,
      include: {
        camera: {
          select: {
            id: true,
            name: true,
            location: true
          }
        }
      },
      orderBy: { detectedAt: 'desc' },
      take: limit,
      skip: offset
    });

    const total = await prisma.alert.count({
      where: whereClause
    });

    return c.json({
      alerts: alertsList,
      total,
      limit,
      offset
    });

  } catch (error) {
    console.error('Get alerts error:', error);
    return c.json({ error: 'Failed to fetch alerts' }, 500);
  }
});

// POST /api/alerts - Create new alert (for internal worker use)
alerts.post('/', zValidator('json', createAlertSchema), async (c) => {
  try {
    const { cameraId, frameUrl, metadata } = c.req.valid('json');

    // Verify camera exists
    const camera = await prisma.camera.findUnique({
      where: { id: cameraId }
    });

    if (!camera) {
      return c.json({ error: 'Camera not found' }, 404);
    }

    const alert = await prisma.alert.create({
      data: {
        cameraId,
        frameUrl,
        metadata,
      },
      include: {
        camera: {
          select: {
            id: true,
            name: true,
            location: true
          }
        }
      }
    });

    // Broadcast alert via WebSocket (temporarily disabled)
    // broadcastAlert(alert);

    return c.json({
      message: 'Alert created successfully',
      alert
    }, 201);

  } catch (error) {
    console.error('Create alert error:', error);
    return c.json({ error: 'Failed to create alert' }, 500);
  }
});

// DELETE /api/alerts/:id - Delete specific alert (no auth for testing)
alerts.delete('/:id', zValidator('param', cuidParamSchema), async (c) => {
  try {
    // const user = c.get('user'); // Disabled for Phase 1 testing
    const { id: alertId } = c.req.valid('param');

    // Check if alert exists (simplified for testing without auth)
    const alert = await prisma.alert.findFirst({
      where: {
        id: alertId
      }
    });

    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    await prisma.alert.delete({
      where: { id: alertId }
    });

    return c.json({
      message: 'Alert deleted successfully'
    });

  } catch (error) {
    console.error('Delete alert error:', error);
    return c.json({ error: 'Failed to delete alert' }, 500);
  }
});

export { alerts };