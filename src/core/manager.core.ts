import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  AppsService,
  IAppsService,
} from '@waha/apps/app_sdk/services/IAppsService';
import { EngineBootstrap } from '@waha/core/abc/EngineBootstrap';
import { GowsEngineConfigService } from '@waha/core/config/GowsEngineConfigService';
import { WebJSEngineConfigService } from '@waha/core/config/WebJSEngineConfigService';
import { WhatsappSessionGoWSCore } from '@waha/core/engines/gows/session.gows.core';
import { WebhookConductor } from '@waha/core/integrations/webhooks/WebhookConductor';
import { MediaStorageFactory } from '@waha/core/media/MediaStorageFactory';
import { DefaultMap } from '@waha/utils/DefaultMap';
import { getPinoLogLevel, LoggerBuilder } from '@waha/utils/logging';
import { promiseTimeout, sleep } from '@waha/utils/promiseTimeout';
import { complete } from '@waha/utils/reactive/complete';
import { SwitchObservable } from '@waha/utils/reactive/SwitchObservable';
import { PinoLogger } from 'nestjs-pino';
import { Observable, retry, share } from 'rxjs';
import { map } from 'rxjs/operators';

import { WhatsappConfigService } from '../config.service';
import {
  WAHAEngine,
  WAHAEvents,
  WAHASessionStatus,
} from '../structures/enums.dto';
import {
  ProxyConfig,
  SessionConfig,
  SessionDetailedInfo,
  SessionDTO,
  SessionInfo,
} from '../structures/sessions.dto';
import { WebhookConfig } from '../structures/webhooks.config.dto';
import { populateSessionInfo, SessionManager } from './abc/manager.abc';
import { SessionParams, WhatsappSession } from './abc/session.abc';
import { EngineConfigService } from './config/EngineConfigService';
import { WhatsappSessionNoWebCore } from './engines/noweb/session.noweb.core';
import { WhatsappSessionWebJSCore } from './engines/webjs/session.webjs.core';
import { DOCS_URL } from './exceptions';
import { getProxyConfig } from './helpers.proxy';
import { MediaManager } from './media/MediaManager';
import { LocalSessionAuthRepository } from './storage/LocalSessionAuthRepository';
import { LocalStoreCore } from './storage/LocalStoreCore';

// Removed OnlyDefaultSessionIsAllowed - multiple sessions are now supported

enum SessionStatus {
  REMOVED = 'removed',
  STOPPED = 'stopped',
}

interface SessionData {
  session: WhatsappSession | null;
  config?: SessionConfig;
  status: SessionStatus | null;
  events: DefaultMap<WAHAEvents, SwitchObservable<any>>;
}

@Injectable()
export class SessionManagerCore extends SessionManager implements OnModuleInit {
  SESSION_STOP_TIMEOUT = 3000;

  // Map of session name -> session data
  private sessions: Map<string, SessionData> = new Map();
  DEFAULT = 'default';

  protected readonly EngineClass: typeof WhatsappSession;
  protected readonly engineBootstrap: EngineBootstrap;

  constructor(
    config: WhatsappConfigService,
    private engineConfigService: EngineConfigService,
    private webjsEngineConfigService: WebJSEngineConfigService,
    gowsConfigService: GowsEngineConfigService,
    log: PinoLogger,
    private mediaStorageFactory: MediaStorageFactory,
    @Inject(AppsService)
    appsService: IAppsService,
  ) {
    super(log, config, gowsConfigService, appsService);
    const engineName = this.engineConfigService.getDefaultEngineName();
    this.EngineClass = this.getEngine(engineName);
    this.engineBootstrap = this.getEngineBootstrap(engineName);

    this.store = new LocalStoreCore(engineName.toLowerCase());
    this.sessionAuthRepository = new LocalSessionAuthRepository(this.store);
    this.clearStorage().catch((error) => {
      this.log.error({ error }, 'Error while clearing storage');
    });
  }

  protected getEngine(engine: WAHAEngine): typeof WhatsappSession {
    if (engine === WAHAEngine.WEBJS) {
      return WhatsappSessionWebJSCore;
    } else if (engine === WAHAEngine.NOWEB) {
      return WhatsappSessionNoWebCore;
    } else if (engine === WAHAEngine.GOWS) {
      return WhatsappSessionGoWSCore;
    } else {
      throw new NotFoundException(`Unknown whatsapp engine '${engine}'.`);
    }
  }

  private getOrCreateSessionData(name: string): SessionData {
    if (!this.sessions.has(name)) {
      this.sessions.set(name, {
        session: null,
        config: undefined,
        status: SessionStatus.STOPPED,
        events: new DefaultMap<WAHAEvents, SwitchObservable<any>>(
          (key) =>
            new SwitchObservable((obs$) => {
              return obs$.pipe(retry(), share());
            }),
        ),
      });
    }
    return this.sessions.get(name)!;
  }

  async beforeApplicationShutdown(signal?: string) {
    // Stop all sessions
    for (const [name, _] of this.sessions) {
      await this.stop(name, true);
    }
    this.stopEvents();
    await this.engineBootstrap.shutdown();
  }

  async onApplicationBootstrap() {
    await this.engineBootstrap.bootstrap();
    this.startPredefinedSessions();
  }

  private async clearStorage() {
    const storage = await this.mediaStorageFactory.build(
      'all',
      this.log.logger.child({ name: 'Storage' }),
    );
    await storage.purge();
  }

  //
  // API Methods
  //
  async exists(name: string): Promise<boolean> {
    const sessionData = this.sessions.get(name);
    return sessionData !== undefined && sessionData.status !== SessionStatus.REMOVED;
  }

  isRunning(name: string): boolean {
    const sessionData = this.sessions.get(name);
    return !!sessionData?.session;
  }

  async upsert(name: string, config?: SessionConfig): Promise<void> {
    const sessionData = this.getOrCreateSessionData(name);
    sessionData.config = config;
  }

  async start(name: string): Promise<SessionDTO> {
    const sessionData = this.getOrCreateSessionData(name);
    if (sessionData.session) {
      throw new UnprocessableEntityException(
        `Session '${name}' is already started.`,
      );
    }
    this.log.info({ session: name }, `Starting session...`);
    const logger = this.log.logger.child({ session: name });
    logger.level = getPinoLogLevel(sessionData.config?.debug);
    const loggerBuilder: LoggerBuilder = logger;

    const storage = await this.mediaStorageFactory.build(
      name,
      loggerBuilder.child({ name: 'Storage' }),
    );
    await storage.init();
    const mediaManager = new MediaManager(
      storage,
      this.config.mimetypes,
      loggerBuilder.child({ name: 'MediaManager' }),
    );

    const webhook = new WebhookConductor(loggerBuilder);
    const proxyConfig = this.getProxyConfig(name, sessionData.config);
    const sessionConfig: SessionParams = {
      name,
      mediaManager,
      loggerBuilder,
      printQR: this.engineConfigService.shouldPrintQR,
      sessionStore: this.store,
      proxyConfig: proxyConfig,
      sessionConfig: sessionData.config,
      ignore: this.ignoreChatsConfig(sessionData.config),
    };
    if (this.EngineClass === WhatsappSessionWebJSCore) {
      sessionConfig.engineConfig = this.webjsEngineConfigService.getConfig();
    } else if (this.EngineClass === WhatsappSessionGoWSCore) {
      sessionConfig.engineConfig = this.gowsConfigService.getConfig();
    }
    await this.sessionAuthRepository.init(name);
    // @ts-ignore
    const session = new this.EngineClass(sessionConfig);
    sessionData.session = session;
    sessionData.status = null; // Running
    this.updateSession(name);

    // configure webhooks
    const webhooks = this.getWebhooks(sessionData.config);
    webhook.configure(session, webhooks);

    // Apps
    try {
      await this.appsService.beforeSessionStart(session, this.store);
    } catch (e) {
      logger.error(`Apps Error: ${e}`);
      session.status = WAHASessionStatus.FAILED;
    }

    // start session
    if (session.status !== WAHASessionStatus.FAILED) {
      await session.start();
      logger.info('Session has been started.');
      // Apps
      await this.appsService.afterSessionStart(session, this.store);
    }

    // Apps
    await this.appsService.afterSessionStart(session, this.store);

    return {
      name: session.name,
      status: session.status,
      config: session.sessionConfig,
    };
  }

  private updateSession(sessionName: string) {
    const sessionData = this.sessions.get(sessionName);
    if (!sessionData?.session) {
      return;
    }
    const session: WhatsappSession = sessionData.session;
    for (const eventName in WAHAEvents) {
      const event = WAHAEvents[eventName];
      const stream$ = session
        .getEventObservable(event)
        .pipe(map(populateSessionInfo(event, session)));
      sessionData.events.get(event).switch(stream$);
    }
  }

  getSessionEvent(sessionName: string, event: WAHAEvents): Observable<any> {
    const sessionData = this.getOrCreateSessionData(sessionName);
    return sessionData.events.get(event);
  }

  async stop(name: string, silent: boolean): Promise<void> {
    if (!this.isRunning(name)) {
      this.log.debug({ session: name }, `Session is not running.`);
      return;
    }

    this.log.info({ session: name }, `Stopping session...`);
    try {
      const session = this.getSession(name);
      await session.stop();
    } catch (err) {
      this.log.warn(`Error while stopping session '${name}'`);
      if (!silent) {
        throw err;
      }
    }
    this.log.info({ session: name }, `Session has been stopped.`);
    const sessionData = this.sessions.get(name);
    if (sessionData) {
      sessionData.session = null;
      sessionData.status = SessionStatus.STOPPED;
      this.updateSession(name);
    }
    await sleep(this.SESSION_STOP_TIMEOUT);
  }

  async unpair(name: string) {
    const sessionData = this.sessions.get(name);
    if (!sessionData?.session) {
      return;
    }
    const session = sessionData.session;

    this.log.info({ session: name }, 'Unpairing the device from account...');
    await session.unpair().catch((err) => {
      this.log.warn(`Error while unpairing from device: ${err}`);
    });
    await sleep(1000);
  }

  async logout(name: string): Promise<void> {
    await this.sessionAuthRepository.clean(name);
  }

  async delete(name: string): Promise<void> {
    await this.appsService.removeBySession(this, name);
    const sessionData = this.sessions.get(name);
    if (sessionData) {
      sessionData.session = null;
      sessionData.status = SessionStatus.REMOVED;
      sessionData.config = undefined;
      this.updateSession(name);
    }
  }

  /**
   * Combine per session and global webhooks
   */
  private getWebhooks(sessionConfig?: SessionConfig) {
    let webhooks: WebhookConfig[] = [];
    if (sessionConfig?.webhooks) {
      webhooks = webhooks.concat(sessionConfig.webhooks);
    }
    const globalWebhookConfig = this.config.getWebhookConfig();
    if (globalWebhookConfig) {
      webhooks.push(globalWebhookConfig);
    }
    return webhooks;
  }

  /**
   * Get either session's or global proxy if defined
   */
  protected getProxyConfig(name: string, sessionConfig?: SessionConfig): ProxyConfig | undefined {
    if (sessionConfig?.proxy) {
      return sessionConfig.proxy;
    }
    const sessionData = this.sessions.get(name);
    if (!sessionData?.session) {
      return undefined;
    }
    const sessions = { [name]: sessionData.session };
    return getProxyConfig(this.config, sessions, name);
  }

  getSession(name: string): WhatsappSession {
    const sessionData = this.sessions.get(name);
    const session = sessionData?.session;
    if (!session) {
      throw new NotFoundException(
        `We didn't find a session with name '${name}'.\n` +
          `Please start it first by using POST /api/sessions/${name}/start request`,
      );
    }
    return session;
  }

  async getSessions(all: boolean): Promise<SessionInfo[]> {
    const result: SessionInfo[] = [];

    for (const [name, sessionData] of this.sessions) {
      // Skip removed sessions
      if (sessionData.status === SessionStatus.REMOVED) {
        continue;
      }

      // Skip stopped sessions if not requesting all
      if (!all && !sessionData.session) {
        continue;
      }

      // Handle stopped sessions
      if (!sessionData.session && sessionData.status === SessionStatus.STOPPED) {
        result.push({
          name: name,
          status: WAHASessionStatus.STOPPED,
          config: sessionData.config,
          me: null,
          presence: null,
          timestamps: {
            activity: null,
          },
        });
        continue;
      }

      // Handle running sessions
      if (sessionData.session) {
        const session = sessionData.session;
        const me = session.getSessionMeInfo();
        result.push({
          name: session.name,
          status: session.status,
          config: session.sessionConfig,
          me: me,
          presence: session.presence,
          timestamps: {
            activity: session.getLastActivityTimestamp(),
          },
        });
      }
    }

    return result;
  }

  private async fetchEngineInfo(session: WhatsappSession | null) {
    // Get engine info
    let engineInfo = {};
    if (session) {
      try {
        engineInfo = await promiseTimeout(1000, session.getEngineInfo());
      } catch (error) {
        this.log.debug(
          { session: session.name, error: `${error}` },
          'Can not get engine info',
        );
      }
    }
    const engine = {
      engine: session?.engine,
      ...engineInfo,
    };
    return engine;
  }

  async getSessionInfo(name: string): Promise<SessionDetailedInfo | null> {
    const sessionData = this.sessions.get(name);
    if (!sessionData || sessionData.status === SessionStatus.REMOVED) {
      return null;
    }

    const sessions = await this.getSessions(true);
    const session = sessions.find(s => s.name === name);
    if (!session) {
      return null;
    }

    const engine = await this.fetchEngineInfo(sessionData.session);
    return {
      ...session,
      engine: engine,
    };
  }

  protected stopEvents() {
    for (const [_, sessionData] of this.sessions) {
      complete(sessionData.events);
    }
  }

  async onModuleInit() {
    await this.init();
  }

  async init() {
    await this.store.init();
    const knex = this.store.getWAHADatabase();
    await this.appsService.migrate(knex);
  }
}
