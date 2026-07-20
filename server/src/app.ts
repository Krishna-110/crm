import express from 'express';
import { appPool } from './db.js';
import { changePassword, login, logout, me, requireAuth } from './auth.js';
import { errorMiddleware } from './errors.js';
import { leadsRouter } from './routes/leads.js';
import { usersRouter } from './routes/users.js';
import { medicinesRouter } from './routes/medicines.js';
import { ordersRouter } from './routes/orders.js';
import { renewalsRouter } from './routes/renewals.js';
import { followUpsRouter } from './routes/followUps.js';
import { notificationsRouter } from './routes/notifications.js';
import { miscRouter } from './routes/misc.js';

export const app = express();

app.use(express.json());

app.get('/api/health', async (_req, res) => {
  await appPool.query('SELECT 1');
  res.json({ ok: true });
});

app.post('/api/auth/login', login);
app.post('/api/auth/logout', requireAuth, logout);
app.get('/api/auth/me', requireAuth, me);
app.patch('/api/auth/password', requireAuth, changePassword);

app.use('/api/leads', requireAuth, leadsRouter);
app.use('/api/users', requireAuth, usersRouter);
app.use('/api/medicines', requireAuth, medicinesRouter);
app.use('/api/orders', requireAuth, ordersRouter);
app.use('/api/renewals', requireAuth, renewalsRouter);
app.use('/api/follow-ups', requireAuth, followUpsRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);
app.use('/api', requireAuth, miscRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use(errorMiddleware);
