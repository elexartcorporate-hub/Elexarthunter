// PM2 ecosystem — untuk Node.js / Next.js app
// Letakkan di root project, lalu: pm2 start ecosystem.config.js
// Auto-start saat reboot: pm2 save && pm2 startup

module.exports = {
  apps: [
    {
      name: 'hunter-app',
      cwd: '/var/www/hunter.elexart.com',
      script: 'node_modules/.bin/next',       // ganti sesuai framework
      args: 'start -p 3000',
      instances: 1,                            // ganti 'max' utk cluster mode
      exec_mode: 'fork',                       // 'cluster' jika instances > 1
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      out_file: '/var/log/pm2/hunter-app.out.log',
      error_file: '/var/log/pm2/hunter-app.err.log',
      time: true,
    },
  ],
};
