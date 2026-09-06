export interface WorkerEnv {
  HYPERDRIVE?: {
    connectionString: string;
  };

  ASSETS?: {
    fetch(
      request: Request | string,
      init?: RequestInit
    ): Promise<Response>;
  };

  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;

  [key: string]: unknown;
}

let currentWorkerEnv: WorkerEnv | null = null;

export function setWorkerEnv(env: WorkerEnv | null): void {
  currentWorkerEnv = env;
  if (env && typeof process !== 'undefined' && process.env) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string' && value) {
        process.env[key] = value;
      }
    }
    if (env.HYPERDRIVE?.connectionString) {
      process.env.DATABASE_URL = env.HYPERDRIVE.connectionString;
    }

  }
}

export function getWorkerEnv(): WorkerEnv | null {
  return currentWorkerEnv;
}