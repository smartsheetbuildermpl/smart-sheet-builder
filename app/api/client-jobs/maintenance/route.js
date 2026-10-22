import { timingSafeEqual } from 'node:crypto';
import {
  cleanup,
  emailReady,
  notifications,
  reply,
  errorReply
} from '../../_lib/client-jobs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
async function runMaintenance(request) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` to this route.
  const expected = process.env.CRON_SECRET,
    actual = request.headers.get('authorization');
  if (
    !expected ||
    !actual ||
    Buffer.byteLength(actual) !== Buffer.byteLength(`Bearer ${expected}`) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(`Bearer ${expected}`))
  )
    return reply({ message: 'Unauthorized' }, 401);
  try {
    const purged = await cleanup();
    const emailConfigured = emailReady();
    const notified = emailConfigured ? await notifications() : 0;
    return reply({ purged, notified, emailConfigured });
  } catch (e) {
    return errorReply(e);
  }
}

// Vercel invokes cron routes with GET. One daily Vercel cron is sufficient:
// expiry itself is enforced separately in the database on every access.
export async function GET(request) {
  return runMaintenance(request);
}
