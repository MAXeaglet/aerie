module.exports = {
  apps: [{
    name: 'aerie',
    script: 'node',
    args: 'dist/index.js',
    cwd: __dirname,
    max_restarts: 10,
    min_uptime: 5000,
    restart_delay: 3000,
    max_memory_restart: '200M',
    env: { NODE_ENV: 'production' },
    error_file: '~/.warpgate-mcp/logs/pm2-error.log',
    out_file: '~/.warpgate-mcp/logs/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
