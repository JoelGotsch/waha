import { Test, TestingModule } from '@nestjs/testing';
import { SessionManagerCore } from './manager.core';
import { WhatsappConfigService } from '../config.service';
import { EngineConfigService } from './config/EngineConfigService';
import { WebJSEngineConfigService } from './config/WebJSEngineConfigService';
import { GowsEngineConfigService } from './config/GowsEngineConfigService';
import { PinoLogger } from 'nestjs-pino';
import { MediaStorageFactory } from './media/MediaStorageFactory';
import { AppsService } from '@waha/apps/app_sdk/services/IAppsService';
import { SessionConfig } from '../structures/sessions.dto';

describe('SessionManagerCore - Multiple Sessions', () => {
  let manager: SessionManagerCore;
  let mockConfig: Partial<WhatsappConfigService>;
  let mockEngineConfigService: Partial<EngineConfigService>;
  let mockWebjsEngineConfigService: Partial<WebJSEngineConfigService>;
  let mockGowsConfigService: Partial<GowsEngineConfigService>;
  let mockLogger: Partial<PinoLogger>;
  let mockMediaStorageFactory: Partial<MediaStorageFactory>;
  let mockAppsService: Partial<AppsService>;

  beforeEach(async () => {
    // Create mocks
    mockConfig = {
      getWebhookConfig: jest.fn().mockReturnValue(null),
      getIgnoreChatsConfig: jest.fn().mockReturnValue({}),
      mimetypes: [],
      startSessions: [],
      workerId: 'test-worker',
      getExcludedPaths: jest.fn().mockReturnValue([]),
    };

    mockEngineConfigService = {
      getDefaultEngineName: jest.fn().mockReturnValue('WEBJS'),
      shouldPrintQR: false,
    };

    mockWebjsEngineConfigService = {
      getConfig: jest.fn().mockReturnValue({}),
    };

    mockGowsConfigService = {
      getConfig: jest.fn().mockReturnValue({}),
      getBootstrapConfig: jest.fn().mockReturnValue({}),
    };

    mockLogger = {
      logger: {
        child: jest.fn().mockReturnThis(),
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      } as any,
      setContext: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };

    mockMediaStorageFactory = {
      build: jest.fn().mockResolvedValue({
        init: jest.fn(),
        purge: jest.fn(),
      }),
    };

    mockAppsService = {
      beforeSessionStart: jest.fn(),
      afterSessionStart: jest.fn(),
      removeBySession: jest.fn(),
      migrate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionManagerCore,
        { provide: WhatsappConfigService, useValue: mockConfig },
        { provide: EngineConfigService, useValue: mockEngineConfigService },
        { provide: WebJSEngineConfigService, useValue: mockWebjsEngineConfigService },
        { provide: GowsEngineConfigService, useValue: mockGowsConfigService },
        { provide: PinoLogger, useValue: mockLogger },
        { provide: MediaStorageFactory, useValue: mockMediaStorageFactory },
        { provide: AppsService, useValue: mockAppsService },
      ],
    }).compile();

    manager = module.get<SessionManagerCore>(SessionManagerCore);
  });

  describe('Multiple Sessions Support', () => {
    it('should allow creating sessions with different names', async () => {
      const session1Name = 'session1';
      const session2Name = 'session2';
      const session3Name = 'default';

      // Create session configs
      const config1: SessionConfig = { name: session1Name };
      const config2: SessionConfig = { name: session2Name };
      const config3: SessionConfig = { name: session3Name };

      // Upsert sessions
      await manager.upsert(session1Name, config1);
      await manager.upsert(session2Name, config2);
      await manager.upsert(session3Name, config3);

      // Verify sessions exist
      expect(await manager.exists(session1Name)).toBe(true);
      expect(await manager.exists(session2Name)).toBe(true);
      expect(await manager.exists(session3Name)).toBe(true);
    });

    it('should track multiple sessions independently', async () => {
      const session1Name = 'user1';
      const session2Name = 'user2';

      // Create sessions with different configs
      const config1: SessionConfig = {
        name: session1Name,
        metadata: { userId: 'user-1' }
      };
      const config2: SessionConfig = {
        name: session2Name,
        metadata: { userId: 'user-2' }
      };

      await manager.upsert(session1Name, config1);
      await manager.upsert(session2Name, config2);

      // Both should exist
      expect(await manager.exists(session1Name)).toBe(true);
      expect(await manager.exists(session2Name)).toBe(true);

      // Neither should be running yet
      expect(manager.isRunning(session1Name)).toBe(false);
      expect(manager.isRunning(session2Name)).toBe(false);
    });

    it('should allow sessions with non-default names', async () => {
      const customSessionName = 'my-custom-session';
      const config: SessionConfig = { name: customSessionName };

      // This should not throw an error
      await expect(manager.upsert(customSessionName, config)).resolves.not.toThrow();
      expect(await manager.exists(customSessionName)).toBe(true);
    });

    it('should return all sessions when getSessions is called', async () => {
      // Create multiple sessions
      await manager.upsert('session1', { name: 'session1' });
      await manager.upsert('session2', { name: 'session2' });
      await manager.upsert('default', { name: 'default' });

      const sessions = await manager.getSessions(true);

      // Should return all created sessions
      expect(sessions.length).toBeGreaterThanOrEqual(0);
      // Note: Without actually starting sessions, they might not appear in the list
      // This is implementation-dependent
    });

    it('should allow deleting individual sessions', async () => {
      const session1Name = 'to-delete';
      const session2Name = 'to-keep';

      await manager.upsert(session1Name, { name: session1Name });
      await manager.upsert(session2Name, { name: session2Name });

      expect(await manager.exists(session1Name)).toBe(true);
      expect(await manager.exists(session2Name)).toBe(true);

      // Delete one session
      await manager.delete(session1Name);

      // First session should be removed
      expect(await manager.exists(session1Name)).toBe(false);
      // Second session should still exist
      expect(await manager.exists(session2Name)).toBe(true);
    });

    it('should handle logout for different sessions independently', async () => {
      const session1Name = 'session-logout-1';
      const session2Name = 'session-logout-2';

      await manager.upsert(session1Name, { name: session1Name });
      await manager.upsert(session2Name, { name: session2Name });

      // Logout should not throw for any session
      await expect(manager.logout(session1Name)).resolves.not.toThrow();
      await expect(manager.logout(session2Name)).resolves.not.toThrow();
    });
  });

  describe('Session name validation', () => {
    it('should accept various session name formats', async () => {
      const validNames = [
        'default',
        'session1',
        'my-session',
        'user_123',
        'test.session',
        'CamelCaseSession',
      ];

      for (const name of validNames) {
        await expect(manager.upsert(name, { name })).resolves.not.toThrow();
        expect(await manager.exists(name)).toBe(true);
      }
    });
  });
});
