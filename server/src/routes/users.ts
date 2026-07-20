import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { withUserTx } from '../db.js';
import { ApiError } from '../errors.js';
import { serializeUser } from '../serializers.js';

export const usersRouter = Router();

const USER_FIELD_MAP: Record<string, string> = {
  name: 'name',
  employeeId: 'employee_id',
  phone: 'phone',
  email: 'email',
  role: 'role',
  status: 'status',
  avatar: 'avatar_url',
};

usersRouter.get('/', async (req, res) => {
  const users = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC');
    return rows;
  });
  res.json(users.map(serializeUser));
});

usersRouter.post('/', async (req, res) => {
  const body = req.body ?? {};
  for (const field of ['name', 'employeeId', 'phone', 'email']) {
    if (!body[field]) throw ApiError.badRequest(`${field} is required`);
  }
  const passwordHash = await bcrypt.hash(body.password || 'Welcome123!', 10);

  const user = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (employee_id, name, phone, email, password_hash, role, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [body.employeeId, body.name, body.phone, body.email, passwordHash, body.role ?? 'caller', body.status ?? 'active'],
    );
    return rows[0];
  });

  res.status(201).json(serializeUser(user));
});

usersRouter.patch('/:id', async (req, res) => {
  const body = req.body ?? {};

  const user = await withUserTx(req.userId!, async (client) => {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(USER_FIELD_MAP)) {
      if (key in body) {
        values.push(body[key] ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (body.password) {
      values.push(await bcrypt.hash(body.password, 10));
      sets.push(`password_hash = $${values.length}`);
    }
    if (sets.length === 0) throw ApiError.badRequest('no updatable fields provided');

    values.push(req.params.id);
    const { rows } = await client.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!rows[0]) throw ApiError.notFound('User not found');
    return rows[0];
  });

  res.json(serializeUser(user));
});

usersRouter.delete('/:id', async (req, res) => {
  await withUserTx(req.userId!, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id],
    );
    if (rowCount === 0) throw ApiError.notFound('User not found');
  });
  res.status(204).end();
});
