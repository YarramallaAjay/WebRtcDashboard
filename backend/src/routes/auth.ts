import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { prisma } from '../utils/db.js';
import { hashPassword, comparePassword, generateToken } from '../auth/utils.js';
import { AuthRequest } from '../types.js';
import { authSchema } from '../schemas.js';

const auth = new Hono();

// Register endpoint
auth.post('/register', zValidator('json', authSchema), async (c) => {
  try {
    const { username, password } = c.req.valid('json');

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { username }
    });

    if (existingUser) {
      return c.json({ error: 'Username already exists' }, 409);
    }

    // Create new user
    const hashedPassword = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        username,
        password: hashedPassword,
      },
      select: {
        id: true,
        username: true,
        createdAt: true,
      }
    });

    // Generate JWT token
    const token = generateToken({
      userId: user.id,
      username: user.username,
    });

    return c.json({
      message: 'User created successfully',
      token,
      user
    }, 201);

  } catch (error) {
    console.error('Registration error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// Login endpoint
auth.post('/login', zValidator('json', authSchema), async (c) => {
  try {
    const { username, password } = c.req.valid('json');

    // Find user
    const user = await prisma.user.findUnique({
      where: { username }
    });

    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Verify password
    const isValidPassword = await comparePassword(password, user.password);
    if (!isValidPassword) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Generate JWT token
    const token = generateToken({
      userId: user.id,
      username: user.username,
    });

    return c.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        createdAt: user.createdAt,
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export { auth };