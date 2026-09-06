import { Request, Response, NextFunction } from 'express';
import { clerkMiddleware, getAuth, createClerkClient } from '@clerk/express';
import { prisma } from '../config/database.js';
import { AppError } from '../utils/AppError.js';
import { AuthenticatedRequest } from '../types/index.js';
import { devAuth } from './devAuth.js';
import { getWorkerEnv } from '../config/workerEnv.js';

/**
 * Clerk Authentication Middleware
 *
 * 1. Uses @clerk/express getAuth() to extract auth state from the request.
 * 2. Looks up (or creates) the internal database user.
 * 3. Attaches auth info and the internal DB user ID to the request.
 *
 * NOTE: clerkMiddleware() must be applied globally on the Express app
 * BEFORE this middleware is used on individual routes.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const workerEnv = getWorkerEnv();
    const isDev =
      process.env.NODE_ENV === 'development' ||
      workerEnv?.NODE_ENV === 'development';

    // If running in development and no Authorization header is provided, use devAuth
    if (isDev && !req.headers.authorization) {
      await devAuth(req, res, () => {});
      if ((req as AuthenticatedRequest).dbUserId) {
        return next();
      }
    }

    const auth = getAuth(req);

    if (!auth || !auth.userId) {
      throw AppError.unauthorized('Authentication required');
    }

    const clerkUserId = auth.userId;

    // Find or create the user in our database
    let user = await prisma.user.findUnique({
      where: { clerkId: clerkUserId },
    });

    if (!user) {
      // First-time login — fetch user details from Clerk and create a record
      let email = '';
      let name: string | null = null;
      try {
        const secretKey =
          process.env.CLERK_SECRET_KEY ||
          (workerEnv?.CLERK_SECRET_KEY as string) ||
          '';
        const client = createClerkClient({ secretKey });
        const clerkUser = await client.users.getUser(clerkUserId);
        email = clerkUser.emailAddresses?.[0]?.emailAddress ?? '';
        name =
          `${clerkUser.firstName ?? ''} ${clerkUser.lastName ?? ''}`.trim() ||
          null;
      } catch (clerkErr) {
        console.warn(
          'Could not fetch user details from Clerk API, using claims fallback:',
          clerkErr
        );
        const claims = (auth.sessionClaims as any) || {};
        email =
          claims.email ||
          claims.primary_email_address ||
          `${clerkUserId}@user.clerk`;
        name = claims.name || claims.full_name || null;
      }

      user = await prisma.user.create({
        data: {
          clerkId: clerkUserId,
          email,
          name,
        },
      });
    }

    // Attach auth info to the request
    (req as AuthenticatedRequest).auth = {
      userId: clerkUserId,
      sessionId: auth.sessionId ?? '',
    };
    (req as AuthenticatedRequest).dbUserId = user.id;

    next();
  } catch (error) {
    next(error);
  }
}

// Re-export clerkMiddleware for use in the main app
export { clerkMiddleware };
