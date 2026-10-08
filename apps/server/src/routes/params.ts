import { SessionIdSchema } from '@funnel/contracts';
import { FunnelConfigSchema } from '@funnel/engine';
import { z } from 'zod';

export const FunnelIdSchema = FunnelConfigSchema.shape.funnelId;
export const SessionParamsSchema = z.object({ sessionId: SessionIdSchema });
export const FunnelParamsSchema = z.object({ funnelId: FunnelIdSchema });
export const VersionParamsSchema = FunnelParamsSchema.extend({ version: z.coerce.number().int().positive() });
