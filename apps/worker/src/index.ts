import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { ComposioConnector, IntegrationProviderSettings } from "@rakazo/adapters";
import { hostedStagingConfig } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createWorkerDrain } from "./drain.js";
import { startWorkerHealth } from "./health.js";
import { startStagingWorker } from "./release-staging.js";
import { createWorkerSecretStore } from "./secret-store.js";

if (process.env.RAKAZO_RELEASE_PROFILE !== "staging") loadRootEnv();

import {
  AutumnFileConnector,
  artifactStorageOptionsFromEnv,
  assertHomeStorageConfiguration,
  ChatSdkMessagingSurface,
  CodexCatalogCache,
  createAgentHomeStore,
  createArtifactStore,
  createBackgroundJobHandlers,
  createCloudAgentConnection,
  createConnectorStack,
  createJobReconciler,
  createMessagingContextLoader,
  createPostgresReconciliationLeadership,
  createRunExecutor,
  createRunSandbox,
  createRunSecretWriter,
  createSessionAdmissionRuntime,
  createTicketChangeNotifier,
  createWebProvider,
  DISCOVERY_PREWARM_REFRESH_MS,
  databaseCapacityBackoffMs,
  ExpoPushProvider,
  firstPartyMcpUrl,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  InstalledConnectorProvider,
  isComposioEnabled,
  isMessagingSurfaceEnabled,
  isPipedreamEnabled,
  McpConnector,
  McpOAuthBroker,
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  PiAgentRuntime,
  PipedreamConnector,
  PostgresRealtimeFanout,
  pipedreamConfigFromEnv,
  prewarmToolDiscovery,
  reconcileCloudAgents,
  reconcileComputerUpdates,
  resolveDeploymentModel,
  resolvePiSessionRoot,
  resolveSandboxProvider,
  ScriptedAgentRuntime,
  SmtpEmailProvider,
  SpaceMemoryProviderResolver,
  sandboxProviderOptionsFromEnv,
  startJobQueueReporter,
  withSecretPersistence,
} from "@rakazo/adapters";
import { createAuth, getOidcAccessToken, oidcConfigFromEnv } from "@rakazo/auth";
import { resolveAuthSecret, resolveEncryptionKey, resolveSupervisorToken } from "@rakazo/core";
import {
  closePoolSessions,
  createBoardEvents,
  createDb,
  createPool,
  createThreadEvents,
  isTooManyDatabaseConnections,
  parsePositiveInteger,
  pushSessionExpiresAt,
  SESSION_RELEASE_MS,
} from "@rakazo/db";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { MarkdownMemoryStore } from "@rakazo/memory";

const staging = hostedStagingConfig(process.env);
const logger = createRootLogger(
  SERVICE_NAMES.worker,
  staging ? { NODE_ENV: "production" } : process.env,
);
// performance.now() is ms since process start, so this includes node + import time.
logger.info("boot.phase", {
  phase: "imports.done",
  "boot.elapsed_ms": Math.round(performance.now()),
});

async function main() {
  if (staging) {
    const stop = await startStagingWorker(staging);
    process.once("SIGTERM", () => void stop());
    process.once("SIGINT", () => void stop());
    logger.info("restricted staging worker ready");
    return;
  }
  const artifactStorage = artifactStorageOptionsFromEnv(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const shutdown = new AbortController();
  // Prisma and job publishing hold a connection only per query or transaction, so DATABASE_URL
  // may be a transaction-mode pooler. graphile's runner (LISTEN, prepared statements) and the
  // reconciler's lock keep a session for the process lifetime, so they use the session URL,
  // REALTIME_DATABASE_URL, when it is a separate connection.
  const created = createDb(databaseUrl, {
    poolMax: parsePositiveInteger(process.env.DB_POOL_MAX, 8),
    applicationName: "rakazo-worker",
  });
  const { pool } = created;
  let { prisma } = created;
  const sessionAdmission = await createSessionAdmissionRuntime(prisma, "worker", process.env);
  const sessionUrl = process.env.REALTIME_DATABASE_URL ?? databaseUrl;
  // LISTEN, the lock, and two for fetching and completing jobs.
  const sessionPool =
    sessionUrl === databaseUrl
      ? pool
      : createPool(sessionUrl, {
          poolMax: 4,
          applicationName:
            sessionAdmission?.admission.sessionApplicationName ?? "rakazo-worker-session",
          verifyConnection: sessionAdmission?.verifyConnection,
        });
  const realtime = new PostgresRealtimeFanout({
    connectionString: sessionUrl,
    publisher: pool,
    applicationName: sessionAdmission?.admission.sessionApplicationName,
    verifyConnection: sessionAdmission?.verifyConnection,
    assertConnectionAdmission: sessionAdmission?.assertConnectionAdmission,
  });
  sessionAdmission?.bindOwners(realtime, sessionPool);
  const secrets = await createWorkerSecretStore(process.env, realtime);
  if (secrets.describe().capabilities.degraded)
    logger.warn("Secret storage degraded; encrypted credentials remain available");
  prisma = withSecretPersistence(prisma, secrets);
  const events = createThreadEvents(prisma, realtime, {
    runSecretWriter: createRunSecretWriter(secrets),
  });
  const ticketBoardEnabled = process.env.TICKET_BOARD_ENABLED === "true";
  const boardEvents = createBoardEvents(realtime);
  const dataDir = process.env.DATA_DIR ?? "./data";
  const runtime =
    process.env.AGENT_RUNTIME === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({ sessionRoot: resolvePiSessionRoot(dataDir) });
  // Same resolver the API uses, so both processes agree on provider, model and key.
  const { key: deploymentModelKey, configured: deploymentModelConfigured } =
    resolveDeploymentModel();
  const sandboxProvider = resolveSandboxProvider(process.env);
  const sandbox = createRunSandbox(sandboxProvider, {
    ...sandboxProviderOptionsFromEnv(process.env),
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    supervisorToken: sandboxProvider === "docker" ? resolveSupervisorToken(process.env) : undefined,
    dataDir,
    prisma,
  });
  const allowPrivateEndpoint = process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true";
  const trustedMcpEndpoint = firstPartyMcpUrl(process.env.FIRST_PARTY_MCP_URL);
  const firstPartyOidc = trustedMcpEndpoint ? oidcConfigFromEnv(process.env) : undefined;
  if (trustedMcpEndpoint && !firstPartyOidc)
    throw new Error("FIRST_PARTY_MCP_URL requires OIDC configuration");
  const firstPartyAuth =
    trustedMcpEndpoint && firstPartyOidc
      ? createAuth(prisma, {
          oidc: firstPartyOidc,
          passwordAuth: process.env.AUTH_PASSWORD_ENABLED !== "false",
          secret: resolveAuthSecret(process.env),
          baseURL: process.env.BETTER_AUTH_URL ?? process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
          webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
          signupsEnabled: process.env.SIGNUPS_ENABLED,
          signupAllowlist: process.env.SIGNUP_ALLOWLIST,
        })
      : undefined;
  const mcpOAuth = new McpOAuthBroker(prisma, secrets, {}, allowPrivateEndpoint);
  const mcp = new McpConnector(
    prisma,
    secrets,
    {
      stdioEnabled: process.env.MCP_STDIO_ENABLED === "true",
      allowedCommands: (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      events,
      allowPrivateEndpoint,
      firstParty:
        trustedMcpEndpoint && firstPartyOidc && firstPartyAuth
          ? {
              endpoint: trustedMcpEndpoint,
              accessToken: (context, rejectedToken) =>
                getOidcAccessToken(prisma, firstPartyAuth, firstPartyOidc, context, rejectedToken),
            }
          : undefined,
    },
    mcpOAuth,
  );
  const pipedreamConfig = pipedreamConfigFromEnv({
    pipedreamClientId: process.env.PIPEDREAM_CLIENT_ID,
    pipedreamClientSecret: process.env.PIPEDREAM_CLIENT_SECRET,
    pipedreamProjectId: process.env.PIPEDREAM_PROJECT_ID,
    pipedreamEnvironment: process.env.PIPEDREAM_ENVIRONMENT,
    encryptionKey: resolveEncryptionKey(process.env),
  });
  const pipedream = isPipedreamEnabled(pipedreamConfig)
    ? new PipedreamConnector(pipedreamConfig)
    : undefined;
  // pollInboundMessages stays false (the default) here: this process
  // only ever sends outbound (messaging.deliver jobs). It must never poll
  // Telegram — that would steal the single getUpdates slot away from the
  // API process, which is the one with the inbound sink actually wired up.
  const messagingPlatforms = messagingPlatformsFromEnv(messagingEnvFromProcess(process.env));
  const messaging = isMessagingSurfaceEnabled(messagingPlatforms, {
    deploymentModelConfigured,
    openSignup: process.env.MESSAGING_OPEN_SIGNUP === "true",
  })
    ? new ChatSdkMessagingSurface(messagingPlatforms)
    : undefined;
  const integrationSettings = new IntegrationProviderSettings(
    prisma,
    secrets,
    resolveEncryptionKey(process.env),
    {
      composio: isComposioEnabled(process.env.COMPOSIO_API_KEY)
        ? new ComposioConnector(process.env.COMPOSIO_API_KEY)
        : undefined,
      pipedream,
    },
  );
  const artifacts = createArtifactStore(dataDir, artifactStorage);
  const stack = createConnectorStack(false, undefined, [
    new InstalledConnectorProvider(prisma, secrets, {}, allowPrivateEndpoint),
    ...integrationSettings.providers(),
    mcp,
    new AutumnFileConnector(prisma, secrets, artifacts),
  ]);
  const connector = stack.destination;
  await connector.start();
  integrationSettings.warmDirectories();
  const prewarm = () =>
    void prewarmToolDiscovery(prisma, stack.connector, shutdown.signal).catch((error) =>
      logger.warn("discovery.prewarm failed", { error: String(error) }),
    );
  prewarm();
  setInterval(prewarm, DISCOVERY_PREWARM_REFRESH_MS).unref();
  const memoryProviders = new SpaceMemoryProviderResolver(prisma, secrets);
  await assertHomeStorageConfiguration(prisma, artifactStorage);
  const home = createAgentHomeStore(dataDir, artifactStorage, prisma);
  const workerConcurrency = parsePositiveInteger(process.env.GRAPHILE_WORKER_CONCURRENCY, 4);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(pool);
  if (!inMemoryJobs) startJobQueueReporter(pool, workerConcurrency, shutdown.signal);
  const ticketChanges = createTicketChangeNotifier({
    boardEvents,
    jobs,
    prisma,
    ticketBoardEnabled,
  });
  const jobHost: JobWorkerHost =
    inMemoryJobs ??
    new GraphileJobWorkerHost(sessionPool, {
      concurrency: workerConcurrency,
      noHandleSignals: true,
    });
  // One provider instance so emulator launches and polls share the same Map.
  const cloudAgent = createCloudAgentConnection();
  // Shared with the reconciler so a stuck wait uses the same push path as a finish notice.
  const notifications = new ExpoPushProvider(prisma, (sessionId) =>
    pushSessionExpiresAt(prisma, sessionId),
  );
  // Account email from the same settings the API uses, for "email me when this finishes".
  const email = process.env.SMTP_URL
    ? new SmtpEmailProvider({ url: process.env.SMTP_URL, from: process.env.EMAIL_FROM ?? "" })
    : undefined;
  const executor = createRunExecutor({
    prisma,
    runtime,
    // Live per-account Codex catalog; never refreshes or writes credentials.
    codexCatalog: new CodexCatalogCache(),
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders,
    home,
    artifacts,
    connector: stack.connector,
    connectors: stack.connector,
    listConnectedPluginSlugs: async (userId) => {
      const provider = await integrationSettings.resolve("composio");
      if (!provider) return [];
      return provider.listConnectedExternalIds({
        userId,
        spaceId: "",
        operationId: "connections.sync",
        traceId: "connections.sync",
        signal: AbortSignal.timeout(15_000),
      });
    },
    secrets: [
      deploymentModelKey ?? "",
      process.env.COMPOSIO_API_KEY ?? "",
      process.env.CURSOR_API_KEY ?? "",
      process.env.TYPESAFE_API_KEY ?? "",
    ].filter(Boolean),
    secretStore: secrets,
    mcpAllowPrivateEndpoint: process.env.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    deploymentModelKey,
    deploymentModelConfigured,
    dataDir,
    notifications,
    email,
    webOrigin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    jobs,
    events,
    onTicketChange: ticketChanges,
    ticketBoardEnabled,
    messaging: messaging ? createMessagingContextLoader(prisma) : undefined,
    web: createWebProvider(),
    cloudAgent,
    shutdownSignal: shutdown.signal,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: process.pid.toString(),
    runtime,
    secretStore: secrets,
    memoryProviders,
    deploymentModelKey,
    deploymentModelConfigured,
    messaging,
    cloudAgent,
    connector: stack.connector,
    shutdownSignal: shutdown.signal,
    // Keep at least two in five slots for conversations.
    scheduledRunSlots: Math.max(1, Math.floor((workerConcurrency * 3) / 5)),
  });
  // graphile-worker run() connects through the shared pool. createPool already
  // retries connect() on 53300 a finite number of times. Keep retrying start
  // until Postgres has capacity: exhausting then returning from main().catch
  // left a live process that held connections but never ran jobs or registered
  // signal handlers, even after capacity returned. Do not exit(1) here; that
  // crash-loops into the same saturated Postgres. GraphileJobWorkerHost also
  // observes runner.promise after start and restarts with the same backoff if
  // the runner dies later on 53300 (unhandledRejection still swallows that
  // code so we do not Docker crash-loop on transient completeJob failures).
  for (let attempt = 0; ; attempt += 1) {
    try {
      await jobHost.start(jobHandlers);
      break;
    } catch (error) {
      if (!isTooManyDatabaseConnections(error)) throw error;
      logger.error("worker job host start waiting on database capacity", error);
      await new Promise((resolve) => setTimeout(resolve, databaseCapacityBackoffMs(attempt)));
    }
  }
  const reconciler = createJobReconciler({
    prisma,
    jobs,
    events,
    notifications,
    completionEmail: Boolean(email),
    leadership: createPostgresReconciliationLeadership(sessionPool),
    reconcileCloudAgents: () => reconcileCloudAgents({ prisma, jobs, cloudAgent }),
    reconcileComputerUpdates: () => reconcileComputerUpdates({ prisma, jobs }),
  });
  reconciler.start();

  const drain = createWorkerDrain({
    stopJobs: () => jobHost.stop(),
    stopReconciler: () => reconciler.stop(),
    afterDrain: sessionAdmission ? () => sessionAdmission.beginShutdown() : undefined,
  });
  // Active runs retain leases/heartbeats until job drain completes; only then close slot sessions.
  const requestDrain = () => {
    void drain.begin().catch((error) => logger.error("worker drain failed", error));
  };
  process.on("SIGUSR2", requestDrain);
  const health = process.env.WORKER_HEALTH_PORT
    ? await startWorkerHealth(
        drain.state,
        parsePositiveInteger(process.env.WORKER_HEALTH_PORT, 8001),
        "0.0.0.0",
        sessionAdmission
          ? {
              instanceId: sessionAdmission.admission.instanceId,
              generation: sessionAdmission.admission.generation,
              service: sessionAdmission.admission.service,
            }
          : undefined,
      )
    : undefined;

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    process.off("SIGUSR2", requestDrain);
    shutdown.abort();
    // Draining running jobs can outlast the kill deadline; say goodbye to the pooler first.
    setTimeout(() => {
      void realtime.close();
      void closePoolSessions(pool);
      void closePoolSessions(sessionPool);
    }, SESSION_RELEASE_MS).unref();
    try {
      await health?.close();
      await drain.begin();
      await jobs.close();
      await secrets.close();
      await realtime.close();
      await connector.stop();
      await mcp.close();
      firstPartyAuth?.disposeOidcDiscovery();
      if (sessionAdmission) {
        // A failed release keeps its reservation; no TTL or silent reclaim.
        await sessionAdmission
          .closeAndRelease()
          .catch((error) => logger.error("session admission retained after shutdown", error));
      } else if (sessionPool !== pool) await sessionPool.end().catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
    } finally {
      await logger.flush({ timeoutMs: 2_000 });
    }
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  // graphile-worker fires completeJob() without awaiting it. When pool.connect()
  // then hits Postgres 53300, that rejection is unhandled. Exiting here is the
  // crash loop: Docker restarts the process before Postgres has reaped the old
  // backends, so the next boot cannot connect either. Stay up on that rejection
  // only — do not resume after uncaughtException (Node leaves the process in an
  // undefined state).
  process.on("uncaughtException", (error) => {
    logger.error("uncaughtException", error);
    void stop().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", reason);
    if (isTooManyDatabaseConnections(reason)) return;
    void stop().finally(() => process.exit(1));
  });

  logger.info("boot.phase", { phase: "ready", "boot.elapsed_ms": Math.round(performance.now()) });
  logger.info("worker ready", { degraded: secrets.describe().capabilities.degraded ?? false });
}

main().catch(async (error) => {
  if (staging) logger.error("restricted staging worker startup failed");
  else logger.error("worker startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  // jobHost.start retries 53300 without bound above, so a saturated Postgres at
  // that step does not reach here. Other startup failures still exit.
  process.exit(1);
});
