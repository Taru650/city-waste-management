import { HttpException, HttpStatus } from '@nestjs/common';

/** Exports building at once in one API process; each one holds its rows and the file in memory. */
export const MAX_CONCURRENT_EXPORTS = 2;

/**
 * Bounds export memory per process: one export at a time per user (a double click or an impatient
 * retry does not build the same file twice) and a small cap overall. Per user rather than per IP,
 * so colleagues behind one office NAT do not block each other.
 */
export class ExportSlots {
  private readonly users = new Set<string>();

  constructor(private readonly max = MAX_CONCURRENT_EXPORTS) {}

  acquire(userId: string): () => void {
    if (this.users.has(userId)) {
      throw new HttpException('Your previous export is still being prepared; try again when it has downloaded', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (this.users.size >= this.max) {
      throw new HttpException('Exports are busy right now; try again in a minute', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.users.add(userId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users.delete(userId);
    };
  }

  get inUse(): number {
    return this.users.size;
  }
}
