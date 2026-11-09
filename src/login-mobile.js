import { loginMobile, outdatedHint } from './mobile-auth.js';

process.umask(0o077);
try {
  await loginMobile();
  console.log('Restart the MCP server to use the renewable mobile session.');
} catch (error) {
  const rejected = [400, 401, 403].includes(error.httpStatus);
  console.error(`${error.message || 'Mobile sign-in failed.'}${rejected ? ` ${outdatedHint}` : ''}`);
  process.exitCode = 1;
}
