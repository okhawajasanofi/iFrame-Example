import { startServers } from './bootstrap';

startServers()
  .then(({ cfg }) => {
    console.log(`Mainframe     ${cfg.mainOrigin}`);
    console.log(`Child origin  ${cfg.childOrigin}`);
    if (!cfg.production) console.log('Demo logins (password Passw0rd!): alice@acme.test (admin), bob@acme.test (user), dave@acme.test (viewer), carol@globex.test (admin)');
  })
  .catch((e) => {
    console.error('Failed to start:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
