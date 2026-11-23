import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

// The Expo account and project the app is released from belong to whoever releases it, not to the source code, so
// they live in app.local.json, which git ignores. That file is not uploaded to the EAS build server; the server names
// the project in EAS_BUILD_PROJECT_ID instead. The same file holds the App Store Connect app's id (ascAppId), which only
// scripts/submit-ios.mjs reads.
interface LocalConfig {
  owner?: string;
  projectId?: string;
}

function readLocalConfig(): LocalConfig {
  const file = join(__dirname, 'app.local.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LocalConfig) : {};
}

// The app's JavaScript can be updated without a store release, but only from the EAS project it is released from; a
// copy built without one (a local build, someone else's fork) takes none, so it never asks a server that is not its
// own. An update reaches only builds of the same app version: a change that needs new native code is a new version
// and goes through the store. The update is looked for at launch without holding the launch up, and used from the
// next start. This lives here rather than in its own file because Expo loads this file without resolving imports of
// other TypeScript files.
export function updatesConfig(projectId: string | undefined): Pick<ExpoConfig, 'runtimeVersion' | 'updates'> {
  return {
    runtimeVersion: { policy: 'appVersion' },
    updates: projectId
      ? { url: `https://u.expo.dev/${projectId}`, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 }
      : { enabled: false },
  };
}

// app.json cannot hold comments, so its network settings are explained here. iOS allows plain http only on the local
// network (NSAllowsLocalNetworking), where a self-hosted server is often reached by its address. Android's network
// security configuration can only allow cleartext by domain name, not for private address ranges, so it stays allowed
// there; the connect screen keeps a server on the internet on https unless the person accepts a warning
// (src/lib/address.ts).
export default ({ config }: ConfigContext): ExpoConfig => {
  const local = readLocalConfig();
  const projectId = local.projectId ?? process.env.EAS_BUILD_PROJECT_ID;
  return {
    ...config,
    ...updatesConfig(projectId),
    ...(local.owner ? { owner: local.owner } : {}),
    extra: { ...config.extra, ...(projectId ? { eas: { projectId } } : {}) },
  } as ExpoConfig;
};
