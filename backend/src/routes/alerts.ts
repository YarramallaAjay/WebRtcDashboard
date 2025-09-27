import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { prisma } from '../utils/db.js';
import { authMiddleware } from '../auth/middleware.js';
import { JWTPayload, Variables } from '../types.js';
// import { broadcastAlert } from '../websocket.js';
import { alertQuerySchema, createAlertSchema, uuidParamSchema } from '../schemas.js';

const alerts = new Hono<{ Variables: Variables }>();

// GET /api/alerts - Get alerts (public for internal worker use, protected for user queries)
alerts.get('/', async (c) => {
  try {
    // Check if request has auth header for user queries
    const authHeader = c.req.header('Authorization');
    let userId: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      // This is a user request - apply authentication
      try {
        await authMiddleware(c, async () => {});
        const user = c.get('user');
        userId = user.userId;
      } catch (error) {
        return c.json({ error: 'Invalid token' }, 401);
      }
    }

    const cameraId = c.req.query('cameraId');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    let whereClause: any = {};

    if (cameraId) {
      whereClause.cameraId = cameraId;
    }

    // If user is authenticated, only show their alerts
    if (userId) {
      whereClause.camera = {
        userId: userId
      };
    }

    const alertsList = await prisma.alert.findMany({
      where: whereClause,
      include: {
        camera: {
          select: {
            id: true,
            name: true,
            location: true,
            userId: true
          }
        }
      },
      orderBy: { detectedAt: 'desc' },
      take: limit,
      skip: offset
    });

    // Filter out alerts for cameras not owned by user if userId is set
    const filteredAlerts = userId
      ? alertsList.filter(alert => alert.camera.userId === userId)
      : alertsList;

    const total = await prisma.alert.count({
      where: whereClause
    });

    return c.json({
      alerts: filteredAlerts,
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
            location: true,
            userId: true
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

// DELETE /api/alerts/:id - Delete specific alert (user only)
alerts.delete('/:id', authMiddleware, zValidator('param', uuidParamSchema), async (c) => {
  try {
    const user = c.get('user');
    const { id: alertId } = c.req.valid('param');

    // Check if alert exists and belongs to user's camera
    const alert = await prisma.alert.findFirst({
      where: {
        id: alertId,
        camera: {
          userId: user.userId
        }
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