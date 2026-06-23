/** Server exiting via SIGTERM/SIGINT — do not send "Disconnected from Cursor IDE" to TG. */
let graceful = false;

export function markGracefulShutdown(): void {
  graceful = true;
}

export function isGracefulShutdown(): boolean {
  return graceful;
}
