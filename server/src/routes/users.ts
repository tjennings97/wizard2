import { Router } from 'express';
import { authenticate } from '../auth/middleware';

export const usersRouter = Router();

// GET /users/me: the client calls this when the app loads to restore the session, so this is
// where a returning user in the re-auth window gets 401 REAUTH_REQUIRED. It stays available
// while a credential change is required, so the client can read requiresCredentialChange.
usersRouter.get('/me', authenticate({ allowDuringCredentialChange: true }), (req, res) => {
  res.status(200).json(req.user);
});
