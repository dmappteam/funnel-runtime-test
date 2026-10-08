// Library entry for the server's "Add demo data" button. The CLI is src/cli.ts.
export { FUNNEL_ID as DEMO_FUNNEL_ID } from './api';
export { runDemoTraffic, type DemoTrafficOptions, type DemoTrafficResult } from './demoTraffic';
export type { HttpRequest, HttpResponse, Transport } from './transport';
