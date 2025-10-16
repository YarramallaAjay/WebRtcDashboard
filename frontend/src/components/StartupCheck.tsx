import React, { useEffect, useState } from 'react';
import { ServiceHealthIndicator, ServiceStatus } from './ServiceHealthIndicator';

interface ServiceHealth {
  name: string;
  status: ServiceStatus;
  lastCheck: string;
  responseTime?: number;
  details?: Record<string, any>;
  error?: string;
}

interface SystemHealth {
  overall: ServiceStatus;
  services: Record<string, ServiceHealth>;
  timestamp: string;
}

interface StartupCheckProps {
  children: React.ReactNode;
}

export const StartupCheck: React.FC<StartupCheckProps> = ({ children }) => {
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkSystemHealth = async () => {
    try {
      const backendUrl = 'http://localhost:3000';
      const response = await fetch(`${backendUrl}/api/system/health`);

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }

      const health: SystemHealth = await response.json();
      setSystemHealth(health);
      setIsReady(health.overall === ServiceStatus.HEALTHY);
      setError(null);
    } catch (err) {
      console.error('[StartupCheck] Health check failed:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
      setIsReady(false);
    }
  };

  useEffect(() => {
    // Initial check
    checkSystemHealth();

    // Poll every 5 seconds
    const interval = setInterval(checkSystemHealth, 5000);

    return () => clearInterval(interval);
  }, []);

  if (error && !systemHealth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-4 h-4 rounded-full bg-red-500 animate-pulse" />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              System Error
            </h1>
          </div>
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            Unable to connect to backend service.
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-500 mb-6">
            {error}
          </p>
          <button
            onClick={checkSystemHealth}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!isReady && systemHealth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className={`w-4 h-4 rounded-full ${
              systemHealth.overall === ServiceStatus.STARTING ? 'bg-yellow-500' :
              systemHealth.overall === ServiceStatus.DEGRADED ? 'bg-orange-500' :
              'bg-red-500'
            } animate-pulse`} />
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              System Starting...
            </h1>
          </div>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Waiting for all services to become ready. This may take a few moments.
          </p>
          <div className="space-y-2 mb-6">
            {Object.values(systemHealth.services).map((service) => (
              <ServiceHealthIndicator
                key={service.name}
                status={service.status}
                serviceName={service.name}
                details={service.error || (service.responseTime ? `${service.responseTime}ms` : undefined)}
              />
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-500">
            <span>Last checked: {new Date(systemHealth.timestamp).toLocaleTimeString()}</span>
            <span>Auto-refreshing...</span>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
