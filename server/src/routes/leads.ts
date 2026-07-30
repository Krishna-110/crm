import { Router } from 'express';
import type pg from 'pg';
import { withUserTx } from '../db.js';
import { ApiError } from '../errors.js';
import { serializeLead, serializeLeadActivity, serializeLeadMedicine, serializeFollowUp } from '../serializers.js';
import { fetchOrderById } from './orders.js';

export const leadsRouter = Router();

const LEAD_WITH_CHILDREN_SQL = `
  SELECT l.*, lm.medicines, la.activities
  FROM leads l
  LEFT JOIN LATERAL (
    SELECT json_agg(m ORDER BY m.created_at) AS medicines
    FROM lead_medicines m WHERE m.lead_id = l.id
  ) lm ON true
  LEFT JOIN LATERAL (
    SELECT json_agg(a ORDER BY a.created_at DESC) AS activities
    FROM lead_activities a WHERE a.lead_id = l.id
  ) la ON true
`;

function rowToLead(row: Record<string, any>) {
  return serializeLead(
    row,
    (row.medicines ?? []).map(serializeLeadMedicine),
    (row.activities ?? []).map(serializeLeadActivity),
  );
}

export async function fetchLeadById(client: pg.PoolClient, id: string) {
  const { rows } = await client.query(`${LEAD_WITH_CHILDREN_SQL} WHERE l.id = $1 AND l.deleted_at IS NULL`, [id]);
  return rows[0] ? rowToLead(rows[0]) : null;
}

// Best-effort catalog match by exact (case-insensitive) name; NULL means free-text/uncatalogued.
async function matchProductId(client: pg.PoolClient, name: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT id FROM products WHERE is_active AND (brand_name ILIKE $1 OR generic_name ILIKE $1) LIMIT 1`,
    [name],
  );
  return rows[0]?.id ?? null;
}

type MedicineInput = { name: string; days: number | string };

async function insertLeadMedicines(client: pg.PoolClient, leadId: string, medicines: MedicineInput[]) {
  for (const m of medicines) {
    const productId = await matchProductId(client, m.name);
    await client.query(
      'INSERT INTO lead_medicines (lead_id, product_id, medicine_name, days) VALUES ($1,$2,$3,$4)',
      [leadId, productId, m.name, Number(m.days) || 1],
    );
  }
}

const LEAD_FIELD_MAP: Record<string, string> = {
  customerName: 'customer_name',
  mobile: 'mobile',
  alternateNumber: 'alternate_number',
  address: 'address',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  doctorName: 'doctor_name',
  disease: 'disease',
  assignedCaller: 'assigned_caller_id',
  leadSource: 'lead_source',
  status: 'status',
  notes: 'notes',
  paymentScreenshot: 'payment_screenshot',
  nextFollowUp: 'next_follow_up_at',
  lastFollowUp: 'last_follow_up_at',
};

leadsRouter.get('/', async (req, res) => {
  const leads = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(`${LEAD_WITH_CHILDREN_SQL} WHERE l.deleted_at IS NULL ORDER BY l.created_at DESC`);
    return rows;
  });
  res.json(leads.map(rowToLead));
});

leadsRouter.post('/', async (req, res) => {
  const body = req.body ?? {};
  for (const field of ['customerName', 'mobile', 'address', 'city', 'state', 'pincode', 'disease']) {
    if (!body[field]) throw ApiError.badRequest(`${field} is required`);
  }
  const medicines: MedicineInput[] = Array.isArray(body.medicines) ? body.medicines : [];
  if (medicines.length === 0) throw ApiError.badRequest('at least one medicine is required');

  const lead = await withUserTx(req.userId!, async (client) => {
    const { rows: selfRows } = await client.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    const assignedCallerId = selfRows[0]?.role === 'caller' ? req.userId : (body.assignedCaller || null);
    const medicineSummary = medicines.map((m) => m.name).join(', ');

    const { rows } = await client.query(
      `INSERT INTO leads (customer_name, mobile, alternate_number, address, city, state, pincode,
                          medicine_required, quantity, disease, doctor_name, assigned_caller_id, lead_source,
                          notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        body.customerName, body.mobile, body.alternateNumber ?? null, body.address, body.city, body.state, body.pincode,
        medicineSummary, body.disease, body.doctorName ?? null, assignedCallerId, body.leadSource ?? 'other',
        body.notes ?? null, req.userId,
      ],
    );
    const leadId = rows[0].id;

    await insertLeadMedicines(client, leadId, medicines);
    await client.query(
      `INSERT INTO lead_activities (lead_id, activity_type, description, created_by) VALUES ($1, 'created', $2, $3)`,
      [leadId, `Lead created — ${body.disease}`, req.userId],
    );

    return fetchLeadById(client, leadId);
  });

  res.status(201).json(lead);
});

leadsRouter.patch('/:id', async (req, res) => {
  const body = req.body ?? {};

  const lead = await withUserTx(req.userId!, async (client) => {
    const { rows: beforeRows } = await client.query(
      'SELECT status, assigned_caller_id, address, pincode, payment_screenshot FROM leads WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id],
    );
    const before = beforeRows[0];
    if (!before) throw ApiError.notFound('Lead not found');

    const targetStatus = 'status' in body ? body.status : before.status;
    if (targetStatus === 'sold') {
      const address = 'address' in body ? body.address : before.address;
      const pincode = 'pincode' in body ? body.pincode : before.pincode;
      const paymentScreenshot = 'paymentScreenshot' in body ? body.paymentScreenshot : before.payment_screenshot;

      if (!address || !String(address).trim()) {
        throw ApiError.badRequest('Address is required when Lead Status is Sold');
      }
      if (!pincode || !String(pincode).trim()) {
        throw ApiError.badRequest('Pincode is required when Lead Status is Sold');
      }
      if (!paymentScreenshot || !String(paymentScreenshot).trim()) {
        throw ApiError.badRequest('Payment Screenshot is required when Lead Status is Sold');
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(LEAD_FIELD_MAP)) {
      if (key in body) {
        values.push(body[key] ?? null);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length > 0) {
      values.push(req.params.id);
      const { rowCount } = await client.query(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = $${values.length} AND deleted_at IS NULL`,
        values,
      );
      if (rowCount === 0) throw ApiError.notFound('Lead not found');
    }

    if (Array.isArray(body.medicines)) {
      await client.query('DELETE FROM lead_medicines WHERE lead_id = $1', [req.params.id]);
      await insertLeadMedicines(client, req.params.id, body.medicines);
      const summary = body.medicines.map((m: MedicineInput) => m.name).join(', ');
      await client.query('UPDATE leads SET medicine_required = $1 WHERE id = $2', [summary, req.params.id]);
    }

    if ('status' in body && body.status !== before.status) {
      await client.query(
        `INSERT INTO lead_activities (lead_id, activity_type, description, created_by) VALUES ($1, 'status_change', $2, $3)`,
        [req.params.id, `Status changed from ${before.status} to ${body.status}`, req.userId],
      );
    }
    if ('assignedCaller' in body && body.assignedCaller !== before.assigned_caller_id) {
      const { rows: callerRows } = await client.query('SELECT name FROM users WHERE id = $1', [body.assignedCaller ?? null]);
      const name = callerRows[0]?.name ?? 'Unassigned';
      await client.query(
        `INSERT INTO lead_activities (lead_id, activity_type, description, created_by) VALUES ($1, 'assignment', $2, $3)`,
        [req.params.id, `Assigned to ${name}`, req.userId],
      );
    }

    return fetchLeadById(client, req.params.id);
  });

  res.json(lead);
});

leadsRouter.delete('/:id', async (req, res) => {
  await withUserTx(req.userId!, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE leads SET deleted_at = now(), updated_by = $2 WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id, req.userId],
    );
    if (rowCount === 0) throw ApiError.notFound('Lead not found');
  });
  res.status(204).end();
});

leadsRouter.post('/:id/activities', async (req, res) => {
  const body = req.body ?? {};
  const description = body.description;
  if (!description) throw ApiError.badRequest('description is required');

  const medicineInput = body.medicine;
  if (medicineInput !== undefined && medicineInput !== null) {
    if (typeof medicineInput.name !== 'string' || !medicineInput.name.trim()) {
      throw ApiError.badRequest('medicine name is required');
    }
    if (!Number.isFinite(Number(medicineInput.days)) || Number(medicineInput.days) <= 0) {
      throw ApiError.badRequest('medicine days must be a positive number');
    }
  }

  const result = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO lead_activities (lead_id, activity_type, description, created_by)
       SELECT id, 'comment', $2, $3 FROM leads WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [req.params.id, description, req.userId],
    );
    if (!rows[0]) throw ApiError.notFound('Lead not found');

    let medicine = null;
    if (medicineInput) {
      const name = medicineInput.name.trim();
      await insertLeadMedicines(client, req.params.id, [{ name, days: medicineInput.days }]);

      const { rows: allMeds } = await client.query(
        'SELECT medicine_name FROM lead_medicines WHERE lead_id = $1 ORDER BY created_at',
        [req.params.id],
      );
      await client.query('UPDATE leads SET medicine_required = $1 WHERE id = $2', [
        allMeds.map((m) => m.medicine_name).join(', '),
        req.params.id,
      ]);

      const { rows: newMedRows } = await client.query(
        'SELECT * FROM lead_medicines WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.id],
      );
      medicine = serializeLeadMedicine(newMedRows[0]);
    }

    return { activity: serializeLeadActivity(rows[0]), medicine };
  });

  res.status(201).json(result);
});

leadsRouter.post('/:id/convert', async (req, res) => {
  const unitPrice = Number(req.body?.unitPrice) || 0;

  const result = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query('SELECT convert_lead_to_order($1, $2) AS order_id', [req.params.id, unitPrice]);
    const order = await fetchOrderById(client, rows[0].order_id);
    const lead = await fetchLeadById(client, req.params.id);
    return { order, lead };
  });

  res.json(result);
});

leadsRouter.post('/:id/follow-ups', async (req, res) => {
  const body = req.body ?? {};
  if (!body.scheduledDate) throw ApiError.badRequest('scheduledDate is required');

  const result = await withUserTx(req.userId!, async (client) => {
    const { rows: customerRows } = await client.query(
      'SELECT resolve_or_create_customer_for_lead($1) AS customer_id',
      [req.params.id],
    );
    const customerId = customerRows[0].customer_id;

    const { rows: fuRows } = await client.query(
      `INSERT INTO follow_ups (customer_id, customer_name, lead_id, scheduled_at, type, status, notes, created_by)
       SELECT $1, l.customer_name, l.id, $2, $3, 'pending', $4, $5
       FROM leads l WHERE l.id = $6
       RETURNING *`,
      [customerId, body.scheduledDate, body.type ?? 'call', body.notes ?? null, req.userId, req.params.id],
    );

    await client.query('UPDATE leads SET next_follow_up_at = $1 WHERE id = $2', [body.scheduledDate, req.params.id]);
    await client.query(
      `INSERT INTO lead_activities (lead_id, activity_type, description, created_by) VALUES ($1, 'follow_up', $2, $3)`,
      [req.params.id, `Follow-up scheduled for ${body.scheduledDate}`, req.userId],
    );

    const lead = await fetchLeadById(client, req.params.id);
    return { followUp: serializeFollowUp(fuRows[0]), lead };
  });

  res.status(201).json(result);
});
