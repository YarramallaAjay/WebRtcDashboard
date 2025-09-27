export interface User {
  id: string;
  username: string;
  password: string;
  createdAt: Date;
}

export interface Camera {
  id: string;
  name: string;
  rtspUrl: string;
  location?: string;
  enabled: boolean;
  userId: string;
  createdAt: Date;
}

export interface Alert {
  id: string;
  cameraId: string;
  frameUrl?: string;
  detectedAt: Date;
  metadata?: any;
}

export interface AuthRequest {
  username: string;
  password: string;
}

export interface JWTPayload {
  userId: string;
  username: string;
}

// Hono context variables type
export type Variables = {
  user: JWTPayload;
};

export interface CreateCameraRequest {
  name: string;
  rtspUrl: string;
  location?: string;
}

export interface UpdateCameraRequest {
  name?: string;
  rtspUrl?: string;
  location?: string;
  enabled?: boolean;
}