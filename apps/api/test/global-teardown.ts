export default async function globalTeardown() {
  const pid = (globalThis as { __MOTO_PID__?: number }).__MOTO_PID__;
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
}
