import { defineTool } from '@deepseek-ai/dsh-tools';
import { startDashboard } from './server.mjs';

export const name = 'dsh-tide-lens';
export const inject = ['connection', 'tools'];

export async function apply(ctx) {
  const dashboard = await startDashboard();
  ctx.effect(() => () => dashboard.close(), 'tide-lens: dashboard');

  ctx.connection.fetch.register({
    path: '/api/tide-lens/dashboard',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      return Response.json({ url: dashboard.url }, { headers: { 'Cache-Control': 'no-store' } });
    },
  });

  ctx.tools.register(defineTool({
    name: 'tide_lens_analyze_confirmed',
    description: '读取使用者已逐项确认的 Tide Lens 行情快照。引用时间、市场、单位、数据质量和来源，模型分数不能写成真实仓位或强平额。只基于返回证据做分析。',
    parameters: {
      ids: { type: 'array', items: { type: 'string' }, description: '可选的已确认数据快照 ID。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute({ ids }) {
      return JSON.stringify(await dashboard.analyze({ ids }));
    },
  }));
}
