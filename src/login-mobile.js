import { loginMobile } from './mobile-auth.js';

process.umask(0o077);
try {
  await loginMobile();
  console.log('Restart the MCP server to use the renewable mobile session.');
} catch (error) {
  console.error(error.message || 'Mobile sign-in failed.');
  process.exitCode = 1;
}
