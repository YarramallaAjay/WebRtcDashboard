import { jwt } from 'hono/jwt';
import { Context, Next } from 'hono';
import { verifyToken } from './utils.js';


// export const jwtMiddleware = jwt({
//   secret: JWT_SECRET,
// });

export const authMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header required' }, 401);
  }

  try {
    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    c.set('user', payload);
    await next();
  } catch (error) {
    return c.json({ error: 'Invalid token' }, 401);
  }
};