import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * The demo-data test counts whole tables, so it needs the freshly built (empty) test database that every run starts
 * with. Vitest otherwise orders files by how long they took last time, which let other files run before it.
 * It rolls everything back at the end, so the files after it still start clean.
 */
export default class DemoDataFirst extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const isDemo = (f: TestSpecification) => /demo-seed\.test\.ts$/.test(f.moduleId);
    return [...sorted.filter(isDemo), ...sorted.filter((f) => !isDemo(f))];
  }
}
