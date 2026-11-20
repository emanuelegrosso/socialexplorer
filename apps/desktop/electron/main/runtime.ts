import {
  createRepositories,
  openDatabase,
  type Repositories,
  type SqliteDatabase,
} from "@social-explorer/database";
import {
  createFileLogSink,
  createLogger,
  KeyringKeyStore,
  parseLogLevel,
  ProtectedStore,
  type KeyStore,
  type Logger,
} from "@social-explorer/security";
import { createConnectorHost, type ConnectorHost } from "../connector-host/connector-host.js";
import { ShutdownRegistry } from "./lifecycle.js";
import { ensureAppPaths, resolveAppPaths, type AppPaths } from "./paths.js";

export interface AppRuntime {
  readonly paths: AppPaths;
  readonly db: SqliteDatabase;
  readonly repositories: Repositories;
  readonly logger: Logger;
  /** Protected connector auth storage; lives outside SQLite and is closed/deleted independently. */
  readonly connectorAuth: ProtectedStore;
  readonly connectorHost: ConnectorHost;
  readonly shutdown: ShutdownRegistry;
}

export interface RuntimeOptions {
  readonly userDataDir: string;
  readonly keyStore?: KeyStore;
  readonly logLevel?: string | undefined;
  readonly onConnectorPush?: (snapshot: ReturnType<ConnectorHost["snapshot"]>) => void;
}

export function createAppRuntime(options: RuntimeOptions): AppRuntime {
  const paths = ensureAppPaths(resolveAppPaths(options.userDataDir));
  const shutdown = new ShutdownRegistry();

  const logger = createLogger({
    sink: createFileLogSink(paths.logs),
    level: parseLogLevel(options.logLevel),
  });
  shutdown.register("logger", () => logger.close());

  const db = openDatabase({ filePath: paths.databaseFile });
  shutdown.register("sqlite", () => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  });

  const connectorAuth = new ProtectedStore({
    directory: paths.connectorAuth,
    keyStore: options.keyStore ?? new KeyringKeyStore(),
  });

  const connectorHost = createConnectorHost({
    authDirectory: paths.connectorAuth,
    logger,
    onPush: (snapshot) => {
      options.onConnectorPush?.(snapshot);
    },
  });
  shutdown.register("connector-host", () => connectorHost.shutdown());

  logger.info("runtime started");
  return { paths, db, repositories: createRepositories(db), logger, connectorAuth, connectorHost, shutdown };
}
