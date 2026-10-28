import { db } from '@/db/connection';
import { JobModel, type EnqueueOptions } from '@/models/JobModel';

export const QUEUES = { PUSH: 'push', VIDEO: 'video', MAINTENANCE: 'maintenance' } as const;

/** Adds work for the background worker (npm run worker, started together with the website by npm run dev). */
export const JobQueue = {
  add(queue: string, name: string, payload: unknown = {}, o: EnqueueOptions = {}) {
    return JobModel.enqueue(db(), queue, name, payload, o);
  },
};
