import { Hono } from 'hono';
import { getHealthChecker, ServiceStatus } from '../services/healthChecker.js';

const system = new Hono();

// GET /api/system/health - Get system health status
system.get('/health', (c) => {
  const healthChecker = getHealthChecker();
  const systemHealth = healthChecker.getSystemHealth();

  // Return appropriate HTTP status based on overall health
  const statusCode = systemHealth.overall === ServiceStatus.HEALTHY ? 200 :
                     systemHealth.overall === ServiceStatus.DEGRADED ? 200 :
                     503;

  return c.json(systemHealth, statusCode);
});

// GET /api/system/health/:service - Get specific service health
system.get('/health/:service', (c) => {
  const serviceName = c.req.param('service');
  const healthChecker = getHealthChecker();
  const serviceHealth = healthChecker.getServiceHealth(serviceName);

  if (!serviceHealth) {
    return c.json({ error: 'Service not found' }, 404);
  }

  return c.json(serviceHealth);
});

// GET /api/system/ready - Readiness check (all services healthy)
system.get('/ready', (c) => {
  const healthChecker = getHealthChecker();
  const isReady = healthChecker.isSystemReady();

  if (isReady) {
    return c.json({ ready: true, message: 'All services are healthy' });
  } else {
    const systemHealth = healthChecker.getSystemHealth();
    return c.json({
      ready: false,
      message: 'System not ready',
      status: systemHealth.overall,
      services: systemHealth.services,
    }, 503);
  }
});

export { system };
