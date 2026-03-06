process.env.TAURI_EMBEDDED = '1';
process.env.AG_SKIP_AUTO_LAUNCH = '1';

await import('./server.js');
