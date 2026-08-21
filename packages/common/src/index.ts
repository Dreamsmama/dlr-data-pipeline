export function log(scope: string, message: string): void {
  console.log(`[${new Date().toISOString()}] [${scope}] ${message}`);
}
