import { z } from 'zod';

// Auth schemas
export const authSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters').max(20, 'Username must be at most 20 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

// Camera schemas
export const createCameraSchema = z.object({
  name: z.string().min(1, 'Camera name is required').max(100, 'Camera name must be at most 100 characters'),
  rtspUrl: z.string().url('Invalid RTSP URL format'),
  location: z.string().max(200, 'Location must be at most 200 characters').optional(),
});

export const updateCameraSchema = z.object({
  name: z.string().min(1, 'Camera name is required').max(100, 'Camera name must be at most 100 characters').optional(),
  rtspUrl: z.string().url('Invalid RTSP URL format').optional(),
  location: z.string().max(200, 'Location must be at most 200 characters').optional(),
  enabled: z.boolean().optional(),
});

// Camera control schemas
export const cameraControlSchema = z.object({
  action: z.enum(['start', 'stop', 'restart']),
});

// Query parameter schemas
export const paginationSchema = z.object({
  limit: z.string().regex(/^\d+$/, 'Limit must be a number').transform(Number).refine(val => val > 0 && val <= 100, 'Limit must be between 1 and 100').optional(),
  offset: z.string().regex(/^\d+$/, 'Offset must be a number').transform(Number).refine(val => val >= 0, 'Offset must be non-negative').optional(),
});

export const alertQuerySchema = z.object({
  cameraId: z.string().min(1).optional(),
  ...paginationSchema.shape,
});

// Parameter schemas
export const cuidParamSchema = z.object({
  id: z.string().min(1),
});

// Alert creation schema (for worker service)
export const createAlertSchema = z.object({
  cameraId: z.string().min(1),
  frameUrl: z.string().url().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});