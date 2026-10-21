/**
 * Client half of `dsh-auto-update`: a frame-wide prompt in `shell.overlay` that lists the
 * plugin updates found by the Host half and asks before anything is installed.
 *
 * The Host serves one HTTP route prefix (`/dsh-auto-update/*`); requests stay on the page's
 * own origin so the Electron shell's protocol forwarding and a reverse-proxy prefix both work.
 */

window.__ModuleLoader__.load({
  // Must match package.json.name, including its npm scope.
  id: '@sueleven/dsh-auto-update',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const ROUTE = 'dsh-auto-update';

    function directoryBase(value) {
      let url;
      try {
        url = new URL(value === '' || value === undefined ? 'http://dsh.internal/' : value, 'http://dsh.internal/');
      } catch {
        url = new URL('http://dsh.internal/');
      }
      url.search = '';
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
      return url.href;
    }

    function routeUrl(path) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : '';
      return new URL(path.replace(/^\/+/, ''), directoryBase(base)).href;
    }

    async function request(path, method) {
      const response = await fetch(routeUrl(`${ROUTE}/${path}`), {
        method: method || 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    const text = {
      available: (count) => `发现 ${count} 个插件有新版本`,
      availableHint: '确认后会更新到最新版，重启 DSH 生效。',
      updating: '正在更新插件…',
      done: '插件已更新',
      doneHint: '重启 DSH 后生效。',
      error: '插件更新未完成',
      apply: '全部更新',
      later: '稍后提醒',
      retry: '重试检查',
      close: '关闭',
      offline: '无法连接更新服务',
    };

    function row(update, index) {
      return h(
        'div',
        {
          key: `${update.name}@${update.to}`,
          style: {
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '3px 0',
            borderTop: index === 0 ? 'none' : '1px solid rgba(255,255,255,0.08)',
          },
        },
        h(
          'span',
          {
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: '12px',
              fontWeight: 600,
              wordBreak: 'break-all',
            },
          },
          update.name,
        ),
        h(
          'span',
          { style: { fontSize: '12px', color: 'rgba(235,235,240,0.72)', whiteSpace: 'nowrap' } },
          `${update.from ?? '?'} → ${update.to ?? '?'}`,
        ),
      );
    }

    function button(label, onClick, primary, disabled) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled: disabled === true,
          style: {
            appearance: 'none',
            border: primary ? 'none' : '1px solid rgba(255,255,255,0.22)',
            background: primary ? (disabled ? 'rgba(88,150,250,0.45)' : '#3b82f6') : 'transparent',
            color: primary ? '#fff' : 'rgba(240,240,245,0.92)',
            borderRadius: '8px',
            padding: '6px 12px',
            fontSize: '12.5px',
            fontWeight: 500,
            cursor: disabled === true ? 'default' : 'pointer',
            pointerEvents: 'auto',
          },
        },
        label,
      );
    }

    function UpdatePrompt() {
      const [status, setStatus] = useState(null);
      const [offline, setOffline] = useState(false);
      const [busy, setBusy] = useState(false);
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        const tick = () => {
          request('status')
            .then((next) => {
              if (!alive.current) return;
              setStatus(next);
              setOffline(false);
            })
            .catch(() => {
              if (!alive.current) return;
              setOffline(true);
            });
        };
        tick();
        const timer = setInterval(tick, 4000);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, []);

      const act = useCallback(async (path) => {
        setBusy(true);
        try {
          const next = await request(path, 'POST');
          setStatus(next);
        } catch {
          /* the next poll reports the outcome */
        } finally {
          setBusy(false);
        }
      }, []);

      const dismiss = useCallback(() => {
        setStatus((previous) => (previous === null ? previous : { ...previous, dismissed: true }));
        request('dismiss', 'POST').catch(() => {});
      }, []);

      if (offline && status === null) return null;
      if (status === null || status.dismissed === true) return null;
      const phase = status.phase;
      const updates = Array.isArray(status.updates) ? status.updates : [];
      if (phase === 'idle' || phase === 'checking') return null;
      if (phase !== 'available' && phase !== 'updating' && phase !== 'done' && phase !== 'error') return null;

      const title =
        phase === 'available'
          ? text.available(updates.length)
          : phase === 'updating'
            ? text.updating
            : phase === 'done'
              ? text.done
              : text.error;

      const detail =
        phase === 'available'
          ? text.availableHint
          : phase === 'done'
            ? status.message || text.doneHint
            : phase === 'error'
              ? status.message || status.error || ''
              : '';

      const buttons = [];
      if (phase === 'available') {
        buttons.push(button(text.apply, () => act('apply'), true, busy));
        buttons.push(button(text.later, dismiss, false, false));
      } else if (phase === 'done') {
        buttons.push(button(text.close, dismiss, true, false));
      } else if (phase === 'error') {
        buttons.push(button(text.retry, () => act('check'), true, busy));
        buttons.push(button(text.close, dismiss, false, false));
      }

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            right: '18px',
            bottom: '18px',
            zIndex: 2147483000,
            width: '370px',
            maxWidth: 'calc(100vw - 36px)',
            boxSizing: 'border-box',
            padding: '14px 16px',
            borderRadius: '14px',
            background: 'rgba(26,27,32,0.97)',
            color: '#f2f2f5',
            boxShadow: '0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.08)',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
            fontSize: '13px',
            lineHeight: 1.5,
            pointerEvents: 'auto',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '13.5px' } },
          h('span', {
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: phase === 'done' ? '#34d399' : phase === 'error' ? '#f87171' : '#3b82f6',
              flex: '0 0 auto',
            },
          }),
          h('span', null, title),
        ),
        updates.length > 0
          ? h(
              'div',
              { style: { marginTop: '8px' } },
              updates.map((update, index) => row(update, index)),
            )
          : null,
        detail
          ? h(
              'div',
              { style: { marginTop: updates.length > 0 ? '8px' : '6px', fontSize: '12px', color: 'rgba(235,235,240,0.72)' } },
              detail,
            )
          : null,
        buttons.length > 0
          ? h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' } },
              ...buttons,
            )
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-auto-update.prompt', order: 40 }, UpdatePrompt),
        );
      },
    };
  },
});
