// src/utils/logger.ts
export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  info(message: string, ...args: any[]): void {
    console.log(`[${new Date().toISOString()}] [INFO] [${this.context}] ${message}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    console.error(`[${new Date().toISOString()}] [ERROR] [${this.context}] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    console.warn(`[${new Date().toISOString()}] [WARN] [${this.context}] ${message}`, ...args);
  }

  debug(message: string, ...args: any[]): void {
    if (process.env.DEBUG === 'true') {
      console.debug(`[${new Date().toISOString()}] [DEBUG] [${this.context}] ${message}`, ...args);
    }
  }
}
