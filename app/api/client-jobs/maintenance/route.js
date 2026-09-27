import { timingSafeEqual } from 'node:crypto';
import {
  cleanup,
  notifications,
  reply,
  errorReply
} from '../../_lib/client-jobs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(request) {
  const expected = process.env.CLIENT_JOBS_CRON_SECRET,
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
    const notified = await notifications();
    return reply({ purged, notified });
  } catch (e) {
    return errorReply(e);
  }
}
