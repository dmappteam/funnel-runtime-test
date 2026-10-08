import type { AggregateInput, AnalyticsReport } from '@funnel/contracts';

/** Pure aggregation of deduplicated-or-not events into the dashboard report. Implemented by the analytics track. */
export function aggregate(_input: AggregateInput): AnalyticsReport {
  throw new Error('aggregate() is not implemented yet');
}
