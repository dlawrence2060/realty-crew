import { API_KEY_AVAILABLE } from './config.ts';
import * as db from './db.ts';

/**
 * Agents bill the claude.ai login (or CLAUDE_CODE_OAUTH_TOKEN) by default. An API key in
 * the server's environment is used only when the "API key" toggle is on as well.
 */
export function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `/usr/local/bin:${process.env.PATH ?? ''}`,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'realty-crew/0.1.0',
  };
  if (!(API_KEY_AVAILABLE && db.getSettings().useApiKey)) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}
