import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/**
 * Marks a route that works without signing in. Keep this list short and make sure every public route
 * protects itself: the WhatsApp webhook checks Meta's signature, the Instagram callback checks its state.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
