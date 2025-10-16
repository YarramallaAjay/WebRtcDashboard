import React from 'react';

export enum ServiceStatus {
  UNKNOWN = 'UNKNOWN',
  STARTING = 'STARTING',
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  UNHEALTHY = 'UNHEALTHY',
}

interface ServiceHealthIndicatorProps {
  status: ServiceStatus;
  serviceName: string;
  details?: string;
}

const statusColors: Record<ServiceStatus, string> = {
  [ServiceStatus.HEALTHY]: 'bg-green-500',
  [ServiceStatus.DEGRADED]: 'bg-orange-500',
  [ServiceStatus.UNHEALTHY]: 'bg-red-500',
  [ServiceStatus.STARTING]: 'bg-yellow-500',
  [ServiceStatus.UNKNOWN]: 'bg-gray-500',
};

const statusText: Record<ServiceStatus, string> = {
  [ServiceStatus.HEALTHY]: 'Healthy',
  [ServiceStatus.DEGRADED]: 'Degraded',
  [ServiceStatus.UNHEALTHY]: 'Unhealthy',
  [ServiceStatus.STARTING]: 'Starting',
  [ServiceStatus.UNKNOWN]: 'Unknown',
};

export const ServiceHealthIndicator: React.FC<ServiceHealthIndicatorProps> = ({
  status,
  serviceName,
  details,
}) => {
  return (
    <div className="flex items-center gap-2 p-2 rounded-md bg-gray-50 dark:bg-gray-800">
      <div className={`w-3 h-3 rounded-full ${statusColors[status]} animate-pulse`} />
      <div className="flex-1">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {serviceName}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {statusText[status]}
          {details && ` - ${details}`}
        </div>
      </div>
    </div>
  );
};
