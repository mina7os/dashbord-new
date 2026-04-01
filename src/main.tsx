import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';

declare global {
  interface Window {
    __APP_CONFIG__?: {
      supabaseUrl?: string;
      supabaseAnonKey?: string;
    };
  }
}

async function bootstrap() {
  try {
    const res = await fetch('/api/public-config');
    if (res.ok) {
      const data = await res.json();
      window.__APP_CONFIG__ = {
        supabaseUrl: data.supabaseUrl,
        supabaseAnonKey: data.supabaseAnonKey,
      };
    }
  } catch (err) {
    console.error('[Bootstrap] Failed to load public config:', err);
  }

  const { default: App } = await import('./App');

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
