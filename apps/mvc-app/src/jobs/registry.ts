import { db } from '@/db/connection';
import { JobModel } from '@/models/JobModel';
import { ComplaintService } from '@/services/ComplaintService';
import { MediaService } from '@/services/MediaService';
import { NotificationService } from '@/services/NotificationService';
import { PrivacyService } from '@/services/PrivacyService';
import { SlaService } from '@/services/SlaService';
import { ZoneService } from '@/services/ZoneService';
import { JobRunner } from './runner';
import { QUEUES } from './queue';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Everything the background worker does. Add a handler here and (if it repeats) its schedule. */
export function createRunner(): JobRunner {
  const runner = new JobRunner();

  // Work started by a request
  runner.register(QUEUES.PUSH, 'dispatch', () => NotificationService.dispatchPending());
  runner.register(QUEUES.VIDEO, 'transcode', (payload: { mediaId: string }, job) => MediaService.processVideoJob(payload.mediaId, job));

  // Work on a timer
  runner
    .register(QUEUES.MAINTENANCE, 'push-dispatch', () => NotificationService.dispatchPending()) // safety net if a kick was lost
    .every(QUEUES.MAINTENANCE, 'push-dispatch', 30 * SECOND);
  runner.register(QUEUES.MAINTENANCE, 'sla-sweep', () => SlaService.sweep()).every(QUEUES.MAINTENANCE, 'sla-sweep', MINUTE);
  runner.register(QUEUES.MAINTENANCE, 'auto-close', () => ComplaintService.autoCloseStale()).every(QUEUES.MAINTENANCE, 'auto-close', HOUR);
  runner.register(QUEUES.MAINTENANCE, 'purge-media', () => MediaService.purgeOrphans()).every(QUEUES.MAINTENANCE, 'purge-media', HOUR);
  runner.register(QUEUES.MAINTENANCE, 'requeue-videos', () => MediaService.requeueStalledVideos()).every(QUEUES.MAINTENANCE, 'requeue-videos', 10 * MINUTE);
  runner.register(QUEUES.MAINTENANCE, 'prune-jobs', () => JobModel.pruneFinished(db(), 7)).every(QUEUES.MAINTENANCE, 'prune-jobs', 24 * HOUR);

  runner.register(QUEUES.MAINTENANCE, 'zone-handover', () => ZoneService.handover()).every(QUEUES.MAINTENANCE, 'zone-handover', 5 * MINUTE);
  runner.register(QUEUES.MAINTENANCE, 'privacy-purge', () => PrivacyService.purge()).every(QUEUES.MAINTENANCE, 'privacy-purge', 24 * HOUR);

  return runner;
}
