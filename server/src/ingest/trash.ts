import { Q } from '../db/index.js';

/** Days a deleted conversation stays in the super-only archive before it is purged. */
export const CONVO_KEEP_DAYS = 5;

/** Purges archived conversations older than CONVO_KEEP_DAYS, or the given one right away. */
export async function purgeDeletedConversations(db: Q, onlyId?: number): Promise<number> {
  const due = onlyId ? 'id=$1 AND deleted_at IS NOT NULL' : `deleted_at IS NOT NULL AND deleted_at < now() - interval '${CONVO_KEEP_DAYS} days'`;
  const r = await db.query(`DELETE FROM conversations WHERE ${due}`, onlyId ? [onlyId] : []);
  return r.rowCount ?? 0;
}
