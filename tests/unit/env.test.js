import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertDeployedConfig,
  loadConfig,
  requireSupabaseAdminConfig,
  requireSupabaseConfig,
} from '../../src/config/env.js';

const KEY = 'x'.repeat(40);

describe('loadConfig: defaults', () => {
  it('boots with no environment at all, for local development', () => {
    const config = loadConfig({});
    assert.equal(config.appUrl, 'http://localhost:3000');
    assert.equal(config.cookiePrefix, 'cma');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.isDeployed, false);
    assert.equal(config.supabase.configured, false);
  });

  it('treats blank and whitespace-only values as absent', () => {
    const config = loadConfig({ SUPABASE_URL: '   ', LOG_LEVEL: '' });
    assert.equal(config.supabase.url, null);
    assert.equal(config.logLevel, 'info');
  });

  it('trims surrounding whitespace, which is a common paste error', () => {
    const config = loadConfig({ APP_URL: '  https://church.example  ' });
    assert.equal(config.appUrl, 'https://church.example');
  });
});

describe('loadConfig: validation', () => {
  it('rejects a relative APP_URL', () => {
    assert.throws(() => loadConfig({ APP_URL: 'church.example' }), /APP_URL/);
  });

  it('rejects a trailing slash on APP_URL, which would produce double slashes in links', () => {
    assert.throws(() => loadConfig({ APP_URL: 'https://church.example/' }), /APP_URL/);
  });

  it('rejects an APP_URL with a path', () => {
    assert.throws(() => loadConfig({ APP_URL: 'https://church.example/app' }), /APP_URL/);
  });

  it('rejects a non-https Supabase URL that is not local', () => {
    assert.throws(() => loadConfig({ SUPABASE_URL: 'http://project.supabase.co' }), /SUPABASE_URL/);
  });

  it('allows a local Supabase stack over http', () => {
    const config = loadConfig({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_ANON_KEY: KEY });
    assert.equal(config.supabase.configured, true);
  });

  it('rejects an implausibly short key rather than failing later at request time', () => {
    assert.throws(() => loadConfig({ SUPABASE_ANON_KEY: 'short' }), /SUPABASE_ANON_KEY/);
  });

  it('rejects an unknown log level', () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL/);
  });

  it('names the offending variable but never echoes its value', () => {
    const secret = 'super-secret-value-that-should-never-be-logged';
    assert.throws(
      () => loadConfig({ APP_URL: secret }),
      (error) => {
        assert.match(error.message, /APP_URL/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  });

  it('does not expose configuration errors to clients', () => {
    try {
      loadConfig({ LOG_LEVEL: 'nope' });
      assert.fail('expected a throw');
    } catch (error) {
      assert.equal(error.expose, false);
      assert.equal(error.status, 500);
      assert.equal(
        error.toClientJson('req-1').error.message,
        'The service is misconfigured. Please contact an administrator.',
      );
    }
  });
});

describe('configured flags', () => {
  it('separates user access from admin access', () => {
    const userOnly = loadConfig({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: KEY });
    assert.equal(userOnly.supabase.configured, true);
    assert.equal(userOnly.supabase.adminConfigured, false);

    const adminOnly = loadConfig({
      SUPABASE_URL: 'https://p.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: KEY,
    });
    assert.equal(adminOnly.supabase.configured, false);
    assert.equal(adminOnly.supabase.adminConfigured, true);
  });
});

describe('assertDeployedConfig', () => {
  it('is a no-op locally', () => {
    assert.doesNotThrow(() => assertDeployedConfig(loadConfig({})));
  });

  it('fails a deployment that is missing credentials, listing every one', () => {
    assert.throws(
      () => assertDeployedConfig(loadConfig({ VERCEL_ENV: 'production' })),
      (error) => {
        assert.match(error.message, /SUPABASE_URL/);
        assert.match(error.message, /SUPABASE_ANON_KEY/);
        assert.match(error.message, /SUPABASE_SERVICE_ROLE_KEY/);
        return true;
      },
    );
  });

  it('passes a fully configured deployment', () => {
    const config = loadConfig({
      VERCEL_ENV: 'production',
      APP_URL: 'https://church.example',
      SUPABASE_URL: 'https://p.supabase.co',
      SUPABASE_ANON_KEY: KEY,
      SUPABASE_SERVICE_ROLE_KEY: KEY,
    });
    assert.doesNotThrow(() => assertDeployedConfig(config));
    assert.equal(config.isProduction, true);
  });
});

describe('require* guards', () => {
  it('refuse to hand back a half-configured Supabase', () => {
    const empty = loadConfig({});
    assert.throws(() => requireSupabaseConfig(empty), /not configured/);
    assert.throws(() => requireSupabaseAdminConfig(empty), /admin access is not configured/);
  });
});
