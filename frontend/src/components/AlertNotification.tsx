import { useEffect, useState } from 'react';
import type { FaceDetectionAlert } from '../hooks/useWebSocket';

interface AlertNotificationProps {
  alert: FaceDetectionAlert;
  onClose: () => void;
}

export const AlertNotification = ({ alert, onClose }: AlertNotificationProps) => {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Auto-close after 10 seconds
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300); // Wait for animation
    }, 10000);

    return () => clearTimeout(timer);
  }, [onClose]);

  if (!visible) {
    return null;
  }

  return (
    <div
      className={`fixed top-4 right-4 max-w-sm bg-white border-l-4 border-red-500 shadow-lg rounded-lg overflow-hidden transition-all duration-300 ${
        visible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-full'
      }`}
      style={{ zIndex: 9999 }}
    >
      <div className="p-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <svg
              className="h-6 w-6 text-red-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div className="ml-3 flex-1">
            <h3 className="text-sm font-medium text-gray-900">Face Detected!</h3>
            <div className="mt-2 text-sm text-gray-600">
              <p>
                <strong>{alert.cameraName}</strong> detected <strong>{alert.faceCount}</strong>{' '}
                {alert.faceCount === 1 ? 'face' : 'faces'}
              </p>
              <p className="text-xs mt-1">
                {new Date(alert.detectedAt).toLocaleTimeString()}
              </p>
            </div>
            {alert.imageData && (
              <div className="mt-3">
                <img
                  src={`data:image/jpeg;base64,${alert.imageData}`}
                  alt="Face detection"
                  className="w-full rounded border border-gray-200"
                />
              </div>
            )}
          </div>
          <button
            onClick={() => {
              setVisible(false);
              setTimeout(onClose, 300);
            }}
            className="ml-3 flex-shrink-0 inline-flex text-gray-400 hover:text-gray-500 focus:outline-none"
          >
            <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

interface AlertsContainerProps {
  alerts: FaceDetectionAlert[];
  onDismiss: (alertId: string) => void;
}

export const AlertsContainer = ({ alerts, onDismiss }: AlertsContainerProps) => {
  return (
    <div className="fixed top-0 right-0 p-4 space-y-4" style={{ zIndex: 9999 }}>
      {alerts.slice(0, 3).map((alert) => (
        <AlertNotification
          key={alert.id}
          alert={alert}
          onClose={() => onDismiss(alert.id)}
        />
      ))}
    </div>
  );
};
