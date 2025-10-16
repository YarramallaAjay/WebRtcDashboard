import { EventEmitter } from 'events';

export enum ServiceStatus {
  UNKNOWN = 'UNKNOWN',
  STARTING = 'STARTING',
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  UNHEALTHY = 'UNHEALTHY',
}

export interface ServiceHealth {
  name: string;
  status: ServiceStatus;
  lastCheck: Date;
  responseTime?: number;
  details?: Record<string, any>;
  error?: string;
}

export interface SystemHealth {
  overall: ServiceStatus;
  services: Record<string, ServiceHealth>;
  timestamp: Date;
}

export class HealthChecker extends EventEmitter {
  private services: Map<string, ServiceHealth> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL = 10000; // 10 seconds
  private readonly TIMEOUT = 5000; // 5 seconds

  constructor() {
    super();
    this.initializeServices();
  }

  private initializeServices() {
    const serviceDefinitions = [
      { name: 'database', url: null, check: this.checkDatabase.bind(this) },
      { name: 'worker', url: process.env.WORKER_URL, check: this.checkWorker.bind(this) },
      { name: 'websocket-backend', url: process.env.WEBSOCKET_URL, check: this.checkWebSocket.bind(this) },
      { name: 'kafka', url: null, check: this.checkKafka.bind(this) },
      { name: 'mediamtx', url: process.env.MEDIAMTX_API_URL, check: this.checkMediaMTX.bind(this) },
    ];

    for (const service of serviceDefinitions) {
      this.services.set(service.name, {
        name: service.name,
        status: ServiceStatus.UNKNOWN,
        lastCheck: new Date(),
      });
    }
  }

  async start(): Promise<void> {
    console.log('[HealthChecker] Starting health monitoring...');

    // Initial check
    await this.performHealthChecks();

    // Schedule periodic checks
    this.checkInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.CHECK_INTERVAL);

    console.log('[HealthChecker] Health monitoring started');
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log('[HealthChecker] Health monitoring stopped');
  }

  private async performHealthChecks(): Promise<void> {
    const checks = [
      this.checkDatabase(),
      this.checkWorker(),
      this.checkWebSocket(),
      this.checkKafka(),
      this.checkMediaMTX(),
    ];

    await Promise.allSettled(checks);

    // Calculate overall system health
    const overallStatus = this.calculateOverallHealth();

    // Emit health update event
    this.emit('health-update', this.getSystemHealth());

    // Log if status changed
    console.log(`[HealthChecker] System Status: ${overallStatus}`);
  }

  private async checkDatabase(): Promise<void> {
    const serviceName = 'database';
    const startTime = Date.now();

    try {
      const { prisma } = await import('../utils/db.js');
      await prisma.$queryRaw`SELECT 1`;

      this.updateServiceHealth(serviceName, {
        status: ServiceStatus.HEALTHY,
        responseTime: Date.now() - startTime,
        details: { connected: true },
      });
    } catch (error) {
      this.updateServiceHealth(serviceName, {
        status: ServiceStatus.UNHEALTHY,
        error: 'Database connection failed',
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async checkWorker(): Promise<void> {
    const serviceName = 'worker';
    const workerUrl = process.env.WORKER_URL || 'http://localhost:8080';
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.TIMEOUT);

      const response = await fetch(`${workerUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        const data = await response.json();
        this.updateServiceHealth(serviceName, {
          status: ServiceStatus.HEALTHY,
          responseTime: Date.now() - startTime,
          details: {data}
        });
      } else {
        this.updateServiceHealth(serviceName, {
          status: ServiceStatus.DEGRADED,
          responseTime: Date.now() - startTime,
          error: `HTTP ${response.status}`,
        });
      }
    } catch (error) {
      this.updateServiceHealth(serviceName, {
        status: ServiceStatus.UNHEALTHY,
        error: 'Worker service unreachable',
        details: { error: error instanceof Error ? error.message : 'Unknown error' },
      });
    }
  }

  private async checkWebSocket(): Promise<void> {
    const serviceName = 'websocket-backend';
    const wsUrl = process.env.WEBSOCKET_URL || 'http://localhost:4000';
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.TIMEOUT);

      const response = await fetch(`${wsUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        this.updateServiceHealth(serviceName, {
          status: ServiceStatus.HEALTHY,
          responseTime: Date.now() - startTime,
        });
      } else {
        this.updateServiceHealth(serviceName, {
          status: ServiceStatus.DEGRADED,
          responseTime: Date.now() - startTime,
          error: `HTTP ${response.status}`,
        });
      }
    } catch (error) {
      this.updateServiceHealth(serviceName, {
        status: ServiceStatus.UNHEALTHY,
        error: 'WebSocket service unreachable',
      });
    }
  }

  private async checkKafka(): Promise<void> {
    const serviceName = 'kafka';

    // For now, mark as healthy if configured, degraded if not
    // In future, implement actual Kafka admin client check
    const kafkaBrokers = process.env.KAFKA_BROKERS;

    if (kafkaBrokers) {
      this.updateServiceHealth(serviceName, {
        status: ServiceStatus.HEALTHY,
        details: { brokers: kafkaBrokers },
      });
    } else {
      this.updateServiceHealth(serviceName, {
        status: ServiceStatus.DEGRADED,
        error: 'Kafka not configured',
      });
    }
  }

  private async checkMediaMTX(): Promise<void> {
    const serviceName = 'mediamtx';
    const mediaMtxUrl = 'http://localhost:8554';
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.TIMEOUT);

      const response = await fetch(`${mediaMtxUrl}/v3/config/get`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        this.updateServiceHealth(serviceName, {
          status: ServiceStatus.HEALTHY,
          responseTime: Date.now() - startTime,
        });
      } else {
        this.updateServiceHealth(serviceName, {
          status: ServiceStatus.DEGRADED,
          responseTime: Date.now() - startTime,
          error: `HTTP ${response.status}`,
        });
      }
    } catch (error) {
      this.updateServiceHealth(serviceName, {
        status: ServiceStatus.UNHEALTHY,
        error: 'MediaMTX unreachable',
      });
    }
  }

  private updateServiceHealth(serviceName: string, update: Partial<ServiceHealth>): void {
    const current = this.services.get(serviceName);
    if (current) {
      this.services.set(serviceName, {
        ...current,
        ...update,
        lastCheck: new Date(),
      });
    }
  }

  private calculateOverallHealth(): ServiceStatus {
    const statuses = Array.from(this.services.values()).map(s => s.status);

    if (statuses.every(s => s === ServiceStatus.HEALTHY)) {
      return ServiceStatus.HEALTHY;
    }

    if (statuses.some(s => s === ServiceStatus.UNHEALTHY)) {
      return ServiceStatus.UNHEALTHY;
    }

    if (statuses.some(s => s === ServiceStatus.DEGRADED)) {
      return ServiceStatus.DEGRADED;
    }

    if (statuses.some(s => s === ServiceStatus.STARTING)) {
      return ServiceStatus.STARTING;
    }

    return ServiceStatus.UNKNOWN;
  }

  getSystemHealth(): SystemHealth {
    const servicesObj: Record<string, ServiceHealth> = {};

    for (const [name, health] of this.services.entries()) {
      servicesObj[name] = health;
    }

    return {
      overall: this.calculateOverallHealth(),
      services: servicesObj,
      timestamp: new Date(),
    };
  }

  getServiceHealth(serviceName: string): ServiceHealth | undefined {
    return this.services.get(serviceName);
  }

  isSystemReady(): boolean {
    return this.calculateOverallHealth() === ServiceStatus.HEALTHY;
  }
}

// Singleton instance
let healthCheckerInstance: HealthChecker | null = null;

export function getHealthChecker(): HealthChecker {
  if (!healthCheckerInstance) {
    healthCheckerInstance = new HealthChecker();
  }
  return healthCheckerInstance;
}
