import { getOverviewStats } from '../services/admin.service.js';

export async function overview(req, res) {
  res.json({ success: true, data: await getOverviewStats() });
}
