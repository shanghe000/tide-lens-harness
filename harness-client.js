window.__ModuleLoader__.load({
  id: 'dsh-tide-lens',
  factory(require) {
    const { createElement, useEffect, useState } = require('react');
    const panelId = 'tide-lens';
    const panelTitle = 'Tide Lens';

    function PanelIcon({ size = 18 }) {
      return createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, createElement('path', { d: 'M3 3v18h18M6.5 13l4.5-5 4 3 5-6' }));
    }

    function DashboardPanel() {
      const [url, setUrl] = useState('');
      const [error, setError] = useState(false);
      const [attempt, setAttempt] = useState(0);

      useEffect(() => {
        const controller = new AbortController();
        async function loadDashboard() {
          try {
            const response = await fetch('api/tide-lens/dashboard', { cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error('Dashboard unavailable');
            const data = await response.json();
            const target = new URL(data.url);
            if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port ||
                target.username || target.password || target.search || target.hash ||
                !/^\/[0-9a-f]{48}\/$/.test(target.pathname)) throw new Error('Invalid dashboard address');
            if (!controller.signal.aborted) setUrl(target.href);
          } catch {
            if (!controller.signal.aborted) setError(true);
          }
        }
        void loadDashboard();
        return () => controller.abort();
      }, [attempt]);

      return createElement('section', {
        'aria-label': panelTitle,
        style: { display: 'flex', paddingTop: 'var(--dsh-frame-top-clearance, 0px)', boxSizing: 'border-box', width: '100%', height: '100%', minWidth: 0, minHeight: 0 },
      }, url ? createElement('iframe', {
        src: url,
        title: panelTitle,
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox',
        referrerPolicy: 'no-referrer',
        style: { flex: 1, border: 0, width: '100%', height: '100%', minHeight: 0, minWidth: 0 },
      }) : createElement('div', { role: 'status', style: { margin: 'auto', padding: 24, textAlign: 'center' } },
        createElement('p', null, error ? 'Tide Lens 看板暂时无法打开。' : '正在打开 Tide Lens 看板…'),
        error ? createElement('button', {
          type: 'button',
          onClick: () => {
            setError(false);
            setAttempt(value => value + 1);
          },
        }, '重试') : null,
      ));
    }

    return {
      name: 'tide-lens-client',
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, DashboardPanel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: panelId, label: panelTitle, order: 24,
        }, PanelIcon));
      },
    };
  },
});
